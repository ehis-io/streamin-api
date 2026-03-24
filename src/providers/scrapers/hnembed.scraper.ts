import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';
import { getAbsoluteApiUrl } from '../../common/utils/config.utils';

@Injectable()
export class HnEmbedScraper implements Scraper {
  name = 'HnEmbed';
  priority = 10;
  private readonly logger = new Logger(HnEmbedScraper.name);
  private readonly baseUrls: string[];

  constructor(private puppeteerService: PuppeteerService, private configService: ConfigService) {
    const urls = this.configService.get<string>('HNEMBED_BASE_URLS');
    this.baseUrls = urls
      ? urls.split(',').map(u => u.trim())
      : ['https://hnembed.cc'];
  }

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for ${query} (TMDB: ${tmdbId}, IMDB: ${imdbId}, Type: ${mediaType}) [Priority: ${priority}]`);
    if (!imdbId && !tmdbId) {
      this.logger.warn('HnEmbed requires IMDB or TMDB ID');
      return [];
    }

    const id = imdbId || tmdbId?.toString();
    const activeType = mediaType === 'tv' ? 'tv' : 'movie';

    return this.baseUrls.flatMap(baseUrl => {
      const results: ScraperSearchResult[] = [];

      if (!mediaType || activeType === 'movie') {
        results.push({
          title: `${query} (${new URL(baseUrl).hostname})`,
          url: `${baseUrl}/embed/movie/${id}`,
          poster: ''
        });
      }

      if (!mediaType || activeType === 'tv') {
        results.push({
          title: `${query} (TV) (${new URL(baseUrl).hostname})`,
          url: `${baseUrl}/embed/tv/${id}`,
          poster: ''
        });
      }
      return results;
    });
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
    this.logger.log(`Attempting HLS extraction for HnEmbed: ${url} [Priority: ${priority}]`);

    return this.puppeteerService.withPage(async (page) => {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      let embedUrl = url;
      if (episode && (episode.season || episode.episode)) {
        const season = episode.season || 1;
        const ep = episode.episode || 1;

        if (embedUrl.includes('/movie/')) {
          embedUrl = embedUrl.replace('/movie/', '/tv/') + `/${season}/${ep}`;
        } else if (embedUrl.includes('/tv/')) {
          const parts = embedUrl.split('/');
          const tvIndex = parts.indexOf('tv');
          if (tvIndex !== -1 && parts.length > tvIndex + 1) {
            embedUrl = parts.slice(0, tvIndex + 2).join('/') + `/${season}/${ep}`;
          }
        } else {
          embedUrl = `${embedUrl.replace(/\/$/, '')}/tv/${season}/${ep}`;
        }
      }

      this.logger.debug(`Navigating to HnEmbed URL: ${embedUrl}`);

      return new Promise<StreamLink[]>(async (resolve) => {
        const m3u8Links: StreamLink[] = [];
        let isResolved = false;

        const cleanup = () => {
          page.removeAllListeners('request');
        };

        const resolveLinks = (links: StreamLink[]) => {
          if (isResolved) return;
          isResolved = true;
          cleanup();
          resolve(links);
        };

        page.on('request', (request) => {
          const reqUrl = request.url();
          if (reqUrl.includes('.m3u8') && !reqUrl.includes('heartbeat')) {
            this.logger.debug(`Found HnEmbed M3U8 link: ${reqUrl}`);

            const headers = request.headers();
            const streamLink = {
              url: reqUrl,
              quality: 'Auto',
              isM3U8: true,
              headers: headers
            };

            m3u8Links.push(streamLink);

            // Master playlist is the ultimate prize, resolve immediately
            if (reqUrl.includes('master') || reqUrl.includes('index.m3u8')) {
              this.logger.debug(`Found master playlist, resolving early`);
              resolveLinks([streamLink]);
            } else {
              // If we find ANY m3u8, wait a tiny bit for more but resolve quickly
              // If we find ANY m3u8, resolve immediately if it's the first one
              this.logger.debug(`Found HnEmbed stream, resolving quickly`);
              resolveLinks([streamLink]);
            }
          }
        });

        try {
          // Use 'domcontentloaded' for faster navigation as we only care about requests
          await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

          // Polling for initial load
          for (let i = 0; i < 10 && m3u8Links.length === 0; i++) {
            await new Promise(r => setTimeout(r, 200));
          }

          // Try to click play button if no links found yet
          if (m3u8Links.length === 0) {
            this.logger.debug("Simulating interaction for HnEmbed...");
            await page.evaluate(() => {
              const selectors = ['#play', '.play', '#player', '.vjs-big-play-button', '#video-player'];
              for (const s of selectors) {
                const el = document.querySelector(s) as HTMLElement;
                if (el) { el.click(); return true; }
              }
              document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }).catch(() => {});
          }

          // Polling after interaction
          for (let i = 0; i < 20 && !isResolved && m3u8Links.length === 0; i++) {
            await new Promise(r => setTimeout(r, 250));
          }
        } catch (e) {
          this.logger.warn(`Navigation to ${embedUrl} timed out or interrupted`);
        }

        if (m3u8Links.length > 0) {
          resolveLinks(m3u8Links);
        } else {
          this.logger.warn(`No M3U8 links for HnEmbed, falling back to iframe`);
          resolveLinks([{
            url: embedUrl,
            quality: 'Auto',
            isM3U8: false,
            headers: { 'Referer': new URL(embedUrl).origin + '/' }
          }]);
        }
      });
    }, priority).catch(error => {
      this.logger.error(`HnEmbed extraction failed: ${error.message}`);
      return [];
    });
  }
}
