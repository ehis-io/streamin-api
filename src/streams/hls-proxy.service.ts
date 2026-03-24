import { Injectable, Logger, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { request } from 'undici';
import axios from 'axios';
import { Response, Request } from 'express';
import * as http from 'http';
import * as https from 'https';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 1000, keepAliveMsecs: 15000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 1000, keepAliveMsecs: 15000 });

import { getAbsoluteApiUrl } from '../common/utils/config.utils';

// Memoize header decoding to save CPU on every segment request
const headerCache = new Map<string, Record<string, string>>();

@Injectable()
export class HlsProxyService {
  private readonly logger = new Logger(HlsProxyService.name);
  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) { }

  public getApiUrl(): string {
    return getAbsoluteApiUrl(this.configService);
  }

  async proxy(url: string, headersStr: string, req: Request, res: Response) {
    if (!url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    const apiUrl = this.getApiUrl();


    const isM3U8Request = url.includes('.m3u8');
    const isKeyRequest = url.includes('.key') || url.includes('/key/');
    const cacheKeyStr = Buffer.from(url).toString('base64');
    const m3u8CacheKey = `proxy:m3u8:${cacheKeyStr}`;
    const keyCacheKey = `proxy:key:${cacheKeyStr}`;

    // 🚀 Fast Path: Redis Cache Hit
    if (isM3U8Request) {
      const cachedM3U8 = await this.cacheManager.get<string>(m3u8CacheKey);
      if (cachedM3U8) {
        this.logger.debug(`[Cache Hit] M3U8 Playlist >> ${url.substring(0, 50)}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('content-type', 'application/vnd.apple.mpegurl');
        res.send(cachedM3U8);
        return;
      }
    }

    if (isKeyRequest) {
      const cachedKeyBase64 = await this.cacheManager.get<string>(keyCacheKey);
      if (cachedKeyBase64) {
        this.logger.debug(`[Cache Hit] AES Key >> ${url.substring(0, 50)}`);
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('content-type', 'application/octet-stream');
        res.send(Buffer.from(cachedKeyBase64, 'base64'));
        return;
      }
    }

    // 🧬 Default headers
    let headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: new URL(url).origin,
      Origin: new URL(url).origin,
    };

    // 🧠 Decode custom headers (with memoization)
    if (headersStr) {
      const cached = headerCache.get(headersStr);
      if (cached) {
        headers = { ...headers, ...cached };
      } else {
        try {
          const decoded = Buffer.from(headersStr, 'base64').toString('utf-8');
          const parsed = JSON.parse(decoded);
          headerCache.set(headersStr, parsed);
          headers = { ...headers, ...parsed };
          
          // Basic cache cleanup
          if (headerCache.size > 1000) headerCache.delete(headerCache.keys().next().value);
        } catch {
          try {
            const parsed = JSON.parse(decodeURIComponent(headersStr));
            headerCache.set(headersStr, parsed);
            headers = { ...headers, ...parsed };
          } catch {}
        }
      }
    }

    const encodedHeaders = encodeURIComponent(
      Buffer.from(JSON.stringify(headers)).toString('base64'),
    );

    try {
      this.logger.debug(`Proxying: ${url}`);
      
      // Fast path for segments: use undici for high-performance streaming
      if (!isM3U8Request && !isKeyRequest) {
          const { statusCode, headers: respHeaders, body } = await request(url, {
              headers: { ...headers, range: req.headers.range as string },
              method: 'GET',
              maxRedirections: 5,
              throwOnError: false,
              bodyTimeout: 15000,    // ⚡ Prevent hanging on slow segments
              headersTimeout: 15000,
          });

          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');

          if (statusCode >= 400) {
              this.logger.warn(`Proxy fail [${statusCode}]: ${url}`);
              res.status(statusCode);
              body.pipe(res);
              return;
          }

          // Forward essential headers
          res.status(statusCode);
          const headersToForward = ['content-type', 'content-range', 'accept-ranges', 'content-length', 'cache-control'];
          headersToForward.forEach(h => {
              if (respHeaders[h]) res.setHeader(h, respHeaders[h] as string);
          });

          body.pipe(res);
          return;
      }

      // 🧬 For M3U8 and Keys, we still use axios for easier Buffer handling or keep it for consistency
      // Actually, let's keep axios for M3U8/Keys since it's already working and they are small
      const response = await axios.get(url, {
        headers: {
          ...headers,
          Range: req.headers.range || '',
        },
        responseType: 'stream',
        validateStatus: () => true,
        timeout: 20000, // Reduced timeout
        httpAgent,
        httpsAgent
      });

      // 🧱 CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Accept,Authorization,Origin');

      if (response.status >= 400) {
        this.logger.warn(`Proxy fail [${response.status}]: ${url}`);
        res.status(response.status);
        response.data.pipe(res);
        return;
      }

      const contentType = (response.headers['content-type'] || '').toLowerCase();
      const isM3U8 = isM3U8Request || 
                    contentType.includes('mpegurl') || 
                    contentType.includes('application/x-mpegurl');

      // Forward headers
      res.status(response.status);
      
      if (isM3U8) {
         // Allow short-term cache for manifest (30s) to reduce redundant proxy hits
         res.setHeader('Cache-Control', 'public, max-age=30');
      }

      const headersToForward = [
        'content-type', 'content-range', 'accept-ranges', 
        'cache-control', 'etag', 'last-modified', 'expires'
      ];
      if (!isM3U8) headersToForward.push('content-length');

      headersToForward.forEach(h => {
        if (response.headers[h]) res.setHeader(h, response.headers[h]);
      });

      if (response.status === 304) {
        res.end();
        return;
      }

      if (isM3U8) {
        let raw = '';
        response.data.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
        response.data.on('end', () => {
          const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
          const trimmedRaw = raw.trim();
          if (!trimmedRaw.startsWith('#EXTM3U') && trimmedRaw.length < 10) {
             this.logger.warn(`Empty or invalid M3U8 content for ${url}`);
             res.status(500).send('Invalid M3U8 content');
             return;
          }

          const rewritten = trimmedRaw.split(/\r?\n/).map(line => {
            const trimmed = line.trim();
            if (!trimmed) return line;

            if (trimmed.startsWith('#EXT-X-KEY')) {
              return line.replace(/URI="([^"]+)"/, (_, keyUrl) => {
                const abs = new URL(keyUrl, baseUrl).toString();
                return `URI="${apiUrl}/api/v1/streams/hls-proxy?url=${encodeURIComponent(abs)}&headers=${encodedHeaders}"`;
              });
            }

            if (trimmed.startsWith('#') && !trimmed.startsWith('#EXT-X-STREAM-INF')) return line;
            if (trimmed.startsWith('#EXT-X-STREAM-INF')) return line;

            let targetUrl = trimmed;
            if (!targetUrl.startsWith('http')) {
              targetUrl = new URL(targetUrl, baseUrl).toString();
            }

            return `${apiUrl}/api/v1/streams/hls-proxy?url=${encodeURIComponent(targetUrl)}&headers=${encodedHeaders}`;
          }).join('\n');

          // Save to redis (10 minute TTL)
          this.cacheManager.set(m3u8CacheKey, rewritten, 10 * 60 * 1000).catch(e => this.logger.warn(`Redis M3U8 Cache error: ${e.message}`));

          res.setHeader('content-type', 'application/vnd.apple.mpegurl');
          res.send(rewritten);
        });
      } else if (isKeyRequest) {
        const chunks: Buffer[] = [];
        response.data.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.data.on('end', () => {
           const fullBuffer = Buffer.concat(chunks);
           // Save base64 to redis (60 minute TTL for keys since they are static)
           this.cacheManager.set(keyCacheKey, fullBuffer.toString('base64'), 60 * 60 * 1000).catch(e => this.logger.warn(`Redis Key Cache error: ${e.message}`));
           res.send(fullBuffer);
        });
      } else {
        response.data.pipe(res);
      }
    } catch (err: any) {
      const code = err.code || 'UNKNOWN_ERROR';
      const status = err.response?.status ? `HTTP ${err.response.status}` : 'No Response';
      this.logger.error(`Proxy crash for ${url} | Code: ${code} | Status: ${status} | Msg: ${err.message || String(err)}`);
      throw new HttpException('Proxy failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
