import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

/**
 * Fetches M3U8 manifests and strips injected ad segments before serving.
 *
 * Ad detection heuristics:
 * 1. SCTE-35 markers (#EXT-X-CUE-OUT / #EXT-X-CUE-IN)
 * 2. EXT-X-DATERANGE with SCTE35 class
 * 3. Discontinuity-wrapped blocks pointing to ad domains
 * 4. Segments whose URLs contain ad-related keywords
 */
@Injectable()
export class HlsProxyService {
  private readonly logger = new Logger(HlsProxyService.name);
  private readonly proxyBaseUrl: string;

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

  constructor(private configService: ConfigService) {
    const port = this.configService.get<number>('PORT', 4001);
    const apiUrl = this.configService.get<string>('API_URL', `http://localhost:${port}`);
    this.proxyBaseUrl = `${apiUrl}/api/v1/streams/hls-proxy`;
  }

  /**
   * Build a proxy URL that routes a sub-manifest through this service.
   * Headers are passed as base64-encoded JSON.
   */
  private buildProxyUrl(targetUrl: string, headers?: Record<string, string>): string {
    const params = new URLSearchParams({ url: targetUrl });
    if (headers && Object.keys(headers).length > 0) {
      params.set('headers', Buffer.from(JSON.stringify(headers)).toString('base64'));
    }
    return `${this.proxyBaseUrl}?${params.toString()}`;
  }

  /** Fetch, clean, and return an M3U8 manifest as a string */
  async getCleanManifest(m3u8Url: string, headers?: Record<string, string>): Promise<string> {
    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      ...headers,
    };

    const response = await axios.get(m3u8Url, {
      headers: reqHeaders,
      timeout: 10000,
      responseType: 'text',
    });

    const raw: string = response.data;
    // Handle redirects for accurate relative URL resolution
    const finalUrl = response.request?.res?.responseUrl || m3u8Url;

    // Master playlist — rewrite variant URLs to proxy through us
    if (raw.includes('#EXT-X-STREAM-INF')) {
      return this.cleanMasterPlaylist(raw, finalUrl, headers);
    }

    // Media playlist — strip ad segments and proxy resources
    return this.cleanMediaPlaylist(raw, finalUrl, headers);
  }

  /**
   * Master playlist: rewrite variant URLs so HLS.js fetches them
   * through our proxy (where ad segments get stripped).
   */
  private cleanMasterPlaylist(raw: string, baseUrl: string, headers?: Record<string, string>): string {
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
        cleaned.push(this.buildProxyUrl(absoluteUrl, headers));
        continue;
      }

      cleaned.push(line);
    }

    return cleaned.join('\n');
  }

  /**
   * Media playlist: identify and remove ad segments.
   * Also recursively proxies all segments and keys to bypass CORS/Referer blocks.
   */
  private cleanMediaPlaylist(raw: string, baseUrl: string, headers?: Record<string, string>): string {
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

      // --- SCTE-35 CUE-IN: leaving ad break ---
      if (line.startsWith('#EXT-X-CUE-IN')) {
        insideAdBreak = false;
        continue;
      }

      // Skip everything inside a SCTE-35 ad break
      if (insideAdBreak) {
        if (!line.startsWith('#')) strippedSegments++;
        continue;
      }

      // --- EXT-X-DATERANGE with SCTE35 class ---
      if (line.startsWith('#EXT-X-DATERANGE') && line.includes('SCTE35')) {
        continue;
      }

      // Proxy URIs in tags (KEY, MAP, etc.)
      if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
        line = line.replace(/URI="([^"]+)"/, (_, uri) => {
          try {
            const absoluteUri = uri.startsWith('http') ? uri : new URL(uri, baseUrl).toString();
            return `URI="${this.buildProxyUrl(absoluteUri, headers)}"`;
          } catch {
            return `URI="${uri}"`;
          }
        });
      }

      // Proxy segment URL
      if (!line.startsWith('#') && line.length > 0) {
        try {
          const absoluteUrl = line.startsWith('http') ? line : new URL(line, baseUrl).toString();
          
          // Check for ads BEFORE proxying
          if (this.isAdSegmentUrl(absoluteUrl)) {
            // Also remove the preceding #EXTINF tag
            if (cleaned.length > 0 && cleaned[cleaned.length - 1].startsWith('#EXTINF')) {
              cleaned.pop();
            }
            strippedSegments++;
            continue;
          }

          line = this.buildProxyUrl(absoluteUrl, headers);
        } catch {
          // If URL is invalid, keep it as is
        }
      }

      // --- DISCONTINUITY block analysis ---
      if (line === '#EXT-X-DISCONTINUITY') {
        if (inDiscontinuityBlock) {
          // End of a discontinuity block — check if it was ads
          const hasAd = discontinuityBuffer.some(l => this.isAdSegmentUrl(l));
          if (!hasAd) {
            // Keep the block — it was real content
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

    // Flush any remaining discontinuity buffer
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
   * Handles arbitrary binary data and passes through Content-Type.
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
      });

      // Pass through relevant headers
      const contentType = response.headers['content-type'];
      if (contentType) res.setHeader('Content-Type', contentType);
      
      const cacheControl = response.headers['cache-control'];
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);

      // 🧱 Wide open CORS for proxied resources (HLS segments/keys)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Access-Control-Expose-Headers', '*');
      
      response.data.pipe(res);
    } catch (e: any) {
      this.logger.error(`Binary proxy failed for ${targetUrl}: ${e.message}`);
      throw new HttpException(
        `Failed to fetch resource: ${e.message}`,
        e.response?.status || HttpStatus.BAD_GATEWAY
      );
    }
  }

  private isAdSegmentUrl(url: string): boolean {
    if (!url || url.startsWith('#')) return false;
    // Note: If the URL is already proxied, we might need to extract the original URL or check both.
    // However, cleanMediaPlaylist now processes lines sequentially.
    return this.AD_URL_PATTERNS.some(pattern => pattern.test(url));
  }
}
