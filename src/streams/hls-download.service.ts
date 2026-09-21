import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import axios from 'axios';
import { Response } from 'express';

@Injectable()
export class HlsDownloadService {
  private readonly logger = new Logger(HlsDownloadService.name);

  constructor(private configService: ConfigService) {}

  async download(
    m3u8Url: string,
    headersStr: string,
    filename: string,
    res: Response,
  ) {
    if (!m3u8Url) {
      throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
    }

    // Decode headers
    let headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    };
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

    // Use direct m3u8 URL
    let resolvedM3u8Url = m3u8Url;

    this.logger.log(`Starting HLS → MP4 download: ${resolvedM3u8Url.substring(0, 80)}...`);

    // Fetch the M3U8 playlist
    let playlistText: string;
    try {
      const playlistRes = await axios.get(resolvedM3u8Url, {
        headers,
        timeout: 15000,
        responseType: 'text',
      });
      playlistText = playlistRes.data;
    } catch (err: any) {
      this.logger.error(`Failed to fetch M3U8 playlist: ${err.message}`);
      throw new HttpException('Failed to fetch stream playlist', HttpStatus.BAD_GATEWAY);
    }

    // If it's a master playlist (has #EXT-X-STREAM-INF), pick the highest bandwidth variant
    if (playlistText.includes('#EXT-X-STREAM-INF')) {
      const lines = playlistText.split(/\r?\n/);
      let bestUrl: string | null = null;
      let bestBandwidth = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/);
          const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
          const variantUrl = lines[i + 1]?.trim();
          if (variantUrl && !variantUrl.startsWith('#') && bw >= bestBandwidth) {
            bestBandwidth = bw;
            bestUrl = variantUrl.startsWith('http')
              ? variantUrl
              : new URL(variantUrl, resolvedM3u8Url).toString();
          }
        }
      }
      if (bestUrl) {
        this.logger.debug(`Master playlist: using best variant (${bestBandwidth}bps)`);
        try {
          const variantRes = await axios.get(bestUrl, { headers, timeout: 15000, responseType: 'text' });
          playlistText = variantRes.data;
          resolvedM3u8Url = bestUrl;
        } catch (err: any) {
          throw new HttpException('Failed to fetch variant playlist', HttpStatus.BAD_GATEWAY);
        }
      }
    }

    // Parse all segment URLs from the media playlist
    const baseUrl = resolvedM3u8Url.substring(0, resolvedM3u8Url.lastIndexOf('/') + 1);
    const segmentUrls: string[] = [];
    for (const line of playlistText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      segmentUrls.push(trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).toString());
    }

    if (segmentUrls.length === 0) {
      throw new HttpException('No segments found in playlist', HttpStatus.BAD_GATEWAY);
    }

    this.logger.log(`Remuxing ${segmentUrls.length} segments → MP4 for: ${filename}`);

    const safeFilename =
      filename.replace(/[^a-z0-9.\- ]/gi, '_').replace(/\.(m3u8|ts)$/i, '') + '.mp4';

    // Set response headers for browser MP4 download
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('X-Total-Segments', segmentUrls.length.toString());

    // Spawn ffmpeg: read raw MPEG-TS from stdin, output streamable fragmented MP4 to stdout
    // -c copy = lossless remux (no transcoding), very fast
    const ffmpeg = spawn('ffmpeg', [
      '-i', 'pipe:0',          // read from stdin
      '-c', 'copy',            // lossless copy — no re-encoding
      '-movflags', 'frag_keyframe+empty_moov+faststart', // streamable MP4
      '-f', 'mp4',             // output format
      'pipe:1',                // write to stdout
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // Pipe ffmpeg stdout → HTTP response
    ffmpeg.stdout.pipe(res);

    // Collect the tail of ffmpeg stderr for logging only — capped, since it can log
    // a line per segment for a whole movie.
    let ffmpegErr = '';
    ffmpeg.stderr.on('data', (d: Buffer) => {
      ffmpegErr = (ffmpegErr + d.toString()).slice(-4096);
    });

    // Client cancelled: stop ffmpeg so the segment loop below exits instead of
    // downloading the rest of the movie for nobody.
    res.on('close', () => {
      if (!res.writableFinished) ffmpeg.kill('SIGKILL');
    });
    // Writes after ffmpeg exits raise EPIPE; without a handler that crashes the process.
    ffmpeg.stdin.on('error', (err) => this.logger.debug(`ffmpeg stdin closed: ${err.message}`));

    ffmpeg.on('close', (code) => {
      const status = code === 0 ? 'complete' : `error (code ${code})`;
      this.logger.log(`ffmpeg ${status}: ${safeFilename}`);
      if (code !== 0) this.logger.debug(`ffmpeg stderr: ${ffmpegErr.slice(-500)}`);
      if (!res.writableEnded) res.end();
    });

    ffmpeg.on('error', (err) => {
      this.logger.error(`ffmpeg process error: ${err.message}`);
      if (!res.writableEnded) res.status(500).end();
    });

    // Stream segments → ffmpeg stdin sequentially
    let downloadedSegments = 0;
    for (const segUrl of segmentUrls) {
      if (!ffmpeg.stdin.writable) break; // ffmpeg died or client disconnected

      try {
        const segRes = await axios.get(segUrl, {
          headers,
          responseType: 'stream',
          timeout: 20000,
        });

        await new Promise<void>((resolve, reject) => {
          const resume = () => segRes.data.resume();
          // If ffmpeg dies while this segment is paused, 'drain' never comes.
          const onStdinClose = () => {
            segRes.data.destroy();
            reject(new Error('ffmpeg stdin closed'));
          };
          const cleanup = () => {
            ffmpeg.stdin.off('drain', resume);
            ffmpeg.stdin.off('close', onStdinClose);
          };
          ffmpeg.stdin.once('close', onStdinClose);

          segRes.data.on('data', (chunk: Buffer) => {
            if (!ffmpeg.stdin.writable) {
              cleanup();
              onStdinClose();
              return;
            }
            // Honour backpressure: when ffmpeg (or the client behind it) is slower than
            // the CDN, unpaused writes queue the whole movie in Node's memory.
            if (!ffmpeg.stdin.write(chunk)) {
              segRes.data.pause();
              ffmpeg.stdin.once('drain', resume);
            }
          });
          segRes.data.on('end', () => { cleanup(); downloadedSegments++; resolve(); });
          segRes.data.on('error', () => { cleanup(); resolve(); }); // Skip bad segment gracefully
        });
      } catch (err: any) {
        this.logger.warn(`Skipping segment: ${err.message}`);
      }
    }

    // Signal end of input to ffmpeg — it will finalize the MP4 and flush stdout
    if (ffmpeg.stdin.writable) {
      ffmpeg.stdin.end();
    }

    this.logger.log(`All ${downloadedSegments}/${segmentUrls.length} segments piped to ffmpeg`);
  }
}
