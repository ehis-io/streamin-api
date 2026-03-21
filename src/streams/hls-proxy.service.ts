import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { Response, Request } from 'express';

@Injectable()
export class HlsProxyService {
  private readonly logger = new Logger(HlsProxyService.name);
  constructor(private configService: ConfigService) { }

  async proxy(url: string, headersStr: string, req: Request, res: Response) {
    if (!url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    const apiUrl = this.configService.get('API_URL', 'http://localhost:4001');

    // 🧬 Default headers (important for bypassing blocks)
    let headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: new URL(url).origin,
      Origin: new URL(url).origin,
    };

    // 🧠 Decode custom headers
    if (headersStr) {
      try {
        const decoded = Buffer.from(headersStr, 'base64').toString('utf-8');
        headers = { ...headers, ...JSON.parse(decoded) };
      } catch {
        try {
          headers = { ...headers, ...JSON.parse(decodeURIComponent(headersStr)) };
        } catch {}
      }
    }

    const encodedHeaders = encodeURIComponent(
      Buffer.from(JSON.stringify(headers)).toString('base64'),
    );

    try {
      this.logger.debug(`Proxying: ${url}`);
      const response = await axios.get(url, {
        headers: {
          ...headers,
          Range: req.headers.range || '',
        },
        responseType: 'stream',
        validateStatus: () => true,
        timeout: 30000,
      });

      // 🧱 CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');

      if (response.status >= 400) {
        this.logger.warn(`Proxy fail [${response.status}]: ${url}`);
        res.status(response.status);
        response.data.pipe(res);
        return;
      }

      const contentType = (response.headers['content-type'] || '').toLowerCase();
      const isM3U8 = url.includes('.m3u8') || 
                    contentType.includes('mpegurl') || 
                    contentType.includes('application/x-mpegurl');

      // Forward headers (but NOT content-length for M3U8 because it changes)
      res.status(response.status);
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
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
          // Simple check if it's actually an M3U8 payload
          if (!raw.startsWith('#EXTM3U') && raw.length < 10) {
             this.logger.warn(`Empty or invalid M3U8 content for ${url}`);
             res.status(500).send('Invalid M3U8 content');
             return;
          }

          const rewritten = raw.split(/\r?\n/).map(line => {
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

          res.setHeader('content-type', 'application/vnd.apple.mpegurl');
          res.send(rewritten);
        });
      } else {
        response.data.pipe(res);
      }
    } catch (err: any) {
      this.logger.error(`Proxy crash for ${url}: ${err.message}`);
      throw new HttpException('Proxy failed', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
