import { Injectable, Logger, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios, { AxiosResponse } from 'axios';
import * as http from 'http';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';

// Origin responses that prove the cached URL is dead — never recoverable by retrying.
// 403/410 = signed/IP-bound token revoked; 404 = removed; 451 = blocked.
const DEAD_URL_STATUSES = new Set([403, 404, 410, 451]);

// Shared keep-alive agents with higher socket limits for HLS proxy throughput.
// A single movie can issue 500-1000 parallel segment requests — defaults (maxSockets=Infinity
// but per-host ~6) throttle concurrency. Explicit maxSockets avoids head-of-line blocking.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32 });

/**
 * Fetches M3U8 manifests and strips injected ad segments before serving.
 */
@Injectable()
export class HlsProxyService {
  private readonly logger = new Logger(HlsProxyService.name);
  private readonly proxyBaseUrl: string;

  /** Redis TTL for cleaned manifests — short because manifests are often live-edge sensitive */
  private readonly MANIFEST_CACHE_TTL_MS = 3000;

  private readonly AD_URL_PATTERNS = [
    /\/ads?\//i,
    /\/preroll/i,
    /\/midroll/i,
    /\/postroll/i,
    /ssaimanifest/i,
    /interstitial/i,
    /stitched-ad/i,
    /creative/i,
    /\.ad\./i,
    /ad-?server/i,
    /imasdk/i,
    /dai\.google/i,
  ];

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private prisma: PrismaService,
  ) {
    const port = this.configService.get<number>('PORT', 4001);
    const apiUrl = this.configService.get<string>('API_URL', `http://localhost:${port}`);
    this.proxyBaseUrl = `${apiUrl}/api/v1/streams/hls-proxy`;
  }

  /**
   * Drop a known-dead URL from manifest cache + DB so the next /streams request
   * re-scrapes instead of replaying the same broken URL. Fire-and-forget — never
   * blocks the response to the user.
   */
  private invalidateDeadUrl(url: string): void {
    this.cacheManager.del(`hls:manifest:p:${url}`).catch(() => {});
    this.cacheManager.del(`hls:manifest:d:${url}`).catch(() => {});
    (this.prisma as any).streamedLink
      .deleteMany({ where: { url } })
      .then((r: { count: number }) => {
        if (r.count > 0) {
          this.logger.warn(`Purged ${r.count} dead streamedLink(s): ${url.substring(0, 100)}`);
        }
      })
      .catch((e: any) => this.logger.warn(`Failed to purge dead link: ${e.message}`));
  }

  /**
   * Build a proxy URL that routes a sub-manifest through this service.
   * Headers are passed as base64-encoded JSON.
   */
  private buildProxyUrl(targetUrl: string, headers?: Record<string, string>, proxySegments?: boolean): string {
    const params = new URLSearchParams({ url: targetUrl });
    if (headers && Object.keys(headers).length > 0) {
      params.set('headers', Buffer.from(JSON.stringify(headers)).toString('base64'));
    }
    if (proxySegments) params.set('proxy_segs', '1');
    return `${this.proxyBaseUrl}?${params.toString()}`;
  }

  /**
   * Fetch, clean, and return an M3U8 manifest.
   *
   * @param proxySegments When true, rewrites segment URLs to go through this proxy
   *                      (needed when origin requires Referer or blocks CORS). When false,
   *                      segments point directly at the CDN — saves the double-hop.
   */
  async getCleanManifest(
    m3u8Url: string,
    headers?: Record<string, string>,
    proxySegments: boolean = false,
  ): Promise<string> {
    // Redis cache: very short TTL, keyed by (url, proxySegments) so both variants coexist
    const cacheKey = `hls:manifest:${proxySegments ? 'p' : 'd'}:${m3u8Url}`;
    try {
      const cached = await this.cacheManager.get<string>(cacheKey);
      if (cached) {
        this.logger.debug(`[Manifest Cache Hit] ${m3u8Url.substring(0, 80)}`);
        return cached;
      }
    } catch (e: any) {
      this.logger.debug(`Manifest cache read failed: ${e.message}`);
    }

    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      ...headers,
    };

    let response: AxiosResponse<string>;
    try {
      response = await axios.get<string>(m3u8Url, {
        headers: reqHeaders,
        timeout: 10000,
        responseType: 'text',
        httpAgent,
        httpsAgent,
      });
    } catch (e: any) {
      const status = e.response?.status;
      if (status && DEAD_URL_STATUSES.has(status)) {
        this.invalidateDeadUrl(m3u8Url);
        throw new HttpException(`Origin returned ${status} for ${m3u8Url}`, status);
      }
      throw e;
    }

    const raw: string = response.data;
    // Handle redirects for accurate relative URL resolution
    const finalUrl = response.request?.res?.responseUrl || m3u8Url;

    let cleaned: string;
    if (raw.includes('#EXT-X-STREAM-INF')) {
      cleaned = this.cleanMasterPlaylist(raw, finalUrl, headers, proxySegments);
    } else {
      cleaned = this.cleanMediaPlaylist(raw, finalUrl, headers, proxySegments);
    }

    // Fire-and-forget cache write
    this.cacheManager.set(cacheKey, cleaned, this.MANIFEST_CACHE_TTL_MS).catch(() => {});

    return cleaned;
  }

  /**
   * Master playlist: rewrite variant URLs to route back through this proxy
   * (so the media playlists also get ad-stripped). The `proxySegments` flag
   * is propagated through the query string.
   */
  private cleanMasterPlaylist(
    raw: string,
    baseUrl: string,
    headers?: Record<string, string>,
    proxySegments: boolean = false,
  ): string {
    const lines = raw.split(/\r?\n/);
    const cleaned: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip EXT-X-DATERANGE ad markers at master level
      if (line.startsWith('#EXT-X-DATERANGE') && line.includes('SCTE35')) {
        continue;
      }

      // Rewrite variant URLs to go through the proxy
      if (!line.startsWith('#') && line.trim().length > 0) {
        const absoluteUrl = line.trim().startsWith('http')
          ? line.trim()
          : new URL(line.trim(), baseUrl).toString();
        cleaned.push(this.buildProxyUrl(absoluteUrl, headers, proxySegments));
        continue;
      }

      cleaned.push(line);
    }

    return cleaned.join('\n');
  }

  /**
   * Media playlist: identify and remove ad segments.
   *
   * If `proxySegments` is false (fast path), segment URLs are made absolute
   * but left pointing directly at the origin CDN. This removes the double-hop
   * for every segment fetch.
   */
  private cleanMediaPlaylist(
    raw: string,
    baseUrl: string,
    headers?: Record<string, string>,
    proxySegments: boolean = false,
  ): string {
    const lines = raw.split(/\r?\n/);
    const cleaned: string[] = [];
    let insideAdBreak = false;
    let discontinuityBuffer: string[] = [];
    let inDiscontinuityBlock = false;
    let strippedSegments = 0;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      if (!line) continue;

      // --- SCTE-35 CUE-OUT: entering ad break ---
      if (line.startsWith('#EXT-X-CUE-OUT') || line.startsWith('#EXT-OATCLS-SCTE35')) {
        insideAdBreak = true;
        continue;
      }

      if (line.startsWith('#EXT-X-CUE-IN')) {
        insideAdBreak = false;
        continue;
      }

      if (insideAdBreak) {
        if (!line.startsWith('#')) strippedSegments++;
        continue;
      }

      if (line.startsWith('#EXT-X-DATERANGE') && line.includes('SCTE35')) {
        continue;
      }

      // KEY / MAP URIs: only proxy when we're proxying segments (same constraints).
      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
        line = line.replace(/URI="([^"]+)"/, (_, uri) => {
          try {
            const absoluteUri = uri.startsWith('http') ? uri : new URL(uri, baseUrl).toString();
            return `URI="${proxySegments ? this.buildProxyUrl(absoluteUri, headers, true) : absoluteUri}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }

      // Segment URL
      if (!line.startsWith('#') && line.length > 0) {
        try {
          const absoluteUrl = line.startsWith('http') ? line : new URL(line, baseUrl).toString();

          if (this.isAdSegmentUrl(absoluteUrl)) {
            if (cleaned.length > 0 && cleaned[cleaned.length - 1].startsWith('#EXTINF')) {
              cleaned.pop();
            }
            strippedSegments++;
            continue;
          }

          // FAST PATH: direct CDN URL (no proxy). SLOW PATH: proxy every segment.
          line = proxySegments ? this.buildProxyUrl(absoluteUrl, headers, true) : absoluteUrl;
        } catch {
          // If URL is invalid, keep it as is
        }
      }

      if (line === '#EXT-X-DISCONTINUITY') {
        if (inDiscontinuityBlock) {
          const hasAd = discontinuityBuffer.some(l => this.isAdSegmentUrl(l));
          if (!hasAd) {
            cleaned.push('#EXT-X-DISCONTINUITY');
            cleaned.push(...discontinuityBuffer);
          } else {
            strippedSegments += discontinuityBuffer.filter(l => !l.startsWith('#')).length;
          }
          discontinuityBuffer = [];
        } else {
          inDiscontinuityBlock = true;
          discontinuityBuffer = [];
        }
        continue;
      }

      if (inDiscontinuityBlock) {
        discontinuityBuffer.push(line);
        continue;
      }

      cleaned.push(line);
    }

    if (discontinuityBuffer.length > 0) {
      const hasAd = discontinuityBuffer.some(l => this.isAdSegmentUrl(l));
      if (!hasAd) {
        cleaned.push('#EXT-X-DISCONTINUITY');
        cleaned.push(...discontinuityBuffer);
      } else {
        strippedSegments += discontinuityBuffer.filter(l => !l.startsWith('#')).length;
      }
    }

    if (strippedSegments > 0) {
      this.logger.log(`Stripped ${strippedSegments} ad segments from manifest`);
    }

    return cleaned.join('\n');
  }

  /**
   * Directly proxy a resource (segment, key, etc.) and stream it to the client.
   */
  async proxyResource(targetUrl: string, headers: Record<string, string> | undefined, res: any) {
    try {
      const reqHeaders: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        ...headers,
      };

      const response = await axios.get(targetUrl, {
        headers: reqHeaders,
        timeout: 15000,
        responseType: 'stream',
        httpAgent,
        httpsAgent,
      });

      const contentType = response.headers['content-type'];
      if (contentType) res.setHeader('Content-Type', contentType);

      const cacheControl = response.headers['cache-control'];
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);

      response.data.pipe(res);
    } catch (e: any) {
      const status = e.response?.status;
      this.logger.error(`Binary proxy failed for ${targetUrl}: ${e.message}`);
      if (status && DEAD_URL_STATUSES.has(status)) {
        this.invalidateDeadUrl(targetUrl);
      }
      throw new HttpException(
        `Failed to fetch resource: ${e.message}`,
        status || HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private isAdSegmentUrl(url: string): boolean {
    if (!url || url.startsWith('#')) return false;
    return this.AD_URL_PATTERNS.some(pattern => pattern.test(url));
  }
}
