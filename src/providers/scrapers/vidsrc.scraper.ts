import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';

@Injectable()
export class VidSrcScraper implements Scraper {
  name = 'VidSrc';
  priority = 20;
  private readonly logger = new Logger(VidSrcScraper.name);
  private readonly baseUrls = [
    'https://vidsrc-embed.ru',
    'https://vidsrc-embed.su',
    'https://vidsrcme.su',
    'https://vsrc.su'
  ];

  constructor(private puppeteerService: PuppeteerService) { }

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for ${query} (TMDB: ${tmdbId}, IMDB: ${imdbId}, MAL: ${malId}, Type: ${mediaType}) [Priority: ${priority}]`);
    // VidSrc-embed.ru works with both TMDB and IMDB IDs
    // Example: https://vidsrc-embed.ru/embed/movie?imdb=tt36741457
    // TEMP: Skip VidSrc if TMDB ID is not present
    if (!tmdbId) {
      this.logger.debug('VidSrc requires TMDB ID, skipping');
      return [];
    }

    if (!imdbId && !tmdbId) {
      this.logger.warn('VidSrc requires IMDB or TMDB ID, cannot search by title alone');
      return [];
    }

    // Treat 'anime' media type as 'tv' if we have a TMDB ID
    const activeType = mediaType === 'movie' ? 'movie' : 'tv';

    const idParam = imdbId ? `imdb=${imdbId}` : `tmdb=${tmdbId}`;

    return this.baseUrls.flatMap(baseUrl => {
      const results: ScraperSearchResult[] = [];

      if (!mediaType || activeType === 'movie') {
        results.push({
          title: `${query} (${new URL(baseUrl).hostname})`,
          url: `${baseUrl}/embed/movie?${idParam}`,
          poster: ''
        });
      }

      if (!mediaType || activeType === 'tv') {
        results.push({
          title: `${query} (TV) (${new URL(baseUrl).hostname})`,
          url: `${baseUrl}/embed/tv?${idParam}`,
          poster: ''
        });
      }
      return results;
    });
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
    this.logger.log(`Attempting HLS extraction for VidSrc: ${url} [Priority: ${priority}]`);

    return this.puppeteerService.withPage(async (page) => {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      let embedUrl = url;
      if (episode && (episode.season || episode.episode)) {
        if (embedUrl.includes('/movie?')) {
          embedUrl = embedUrl.replace('/movie?', '/tv?');
        }

        try {
          const urlObj = new URL(embedUrl);
          const season = episode.season || 1;
          urlObj.searchParams.set('season', season.toString());
          urlObj.searchParams.set('episode', episode.episode.toString());
          embedUrl = urlObj.toString();
        } catch (urlError) {
          // Fallback if URL is weird
          const operator = embedUrl.includes('?') ? '&' : '?';
          const season = episode.season || 1;
          embedUrl = `${embedUrl}${operator}season=${season}&episode=${episode.episode}`;
        }
      }

      this.logger.debug(`Navigating to embed URL: ${embedUrl}`);

      return new Promise<StreamLink[]>(async (resolve) => {
        const m3u8Links: StreamLink[] = [];
        let isResolved = false;

        const resolveLinks = (links: StreamLink[]) => {
          if (isResolved) return;
          isResolved = true;
          page.removeAllListeners('request');
          resolve(links);
        };

        page.on('request', (request) => {
          const reqUrl = request.url();
          if (reqUrl.includes('.m3u8') && !reqUrl.includes('heartbeat')) {
            const link = {
              url: reqUrl,
              quality: 'Auto',
              isM3U8: true,
              headers: request.headers()
            };
            m3u8Links.push(link);

            // Fast exit: if it's a master playlist, we're likely done
            if (reqUrl.includes('master') || reqUrl.includes('index.m3u8')) {
              this.logger.debug(`Found master playlist, resolving immediately for speed`);
              resolveLinks([link]);
            }
          }
        });

        // Navigate with a shorter timeout
        try {
          await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });

          // Wait a maximum of 3 more seconds for dynamic links if none found yet
          if (!isResolved && m3u8Links.length === 0) {
            await new Promise(r => setTimeout(r, 3000));
          }
        } catch (e) {
          this.logger.warn(`Navigation to ${embedUrl} timed out, checking extracted links...`);
        }

        if (!isResolved) {
          if (m3u8Links.length > 0) {
            resolveLinks(m3u8Links);
          } else {
            // Fallback to embed URL
            this.logger.warn(`No M3U8 links for VidSrc, falling back`);
            resolveLinks([{
              url: embedUrl,
              quality: 'Auto',
              isM3U8: false,
              headers: { 'Referer': 'https://vidsrc.to/' }
            }]);
          }
        }
      });
    }, priority).catch(error => {
      this.logger.error(`VidSrc extraction failed: ${error.message}`);
      return [];
    });
  }
}
