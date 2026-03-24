import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';
import { getAbsoluteApiUrl } from '../../common/utils/config.utils';

@Injectable()
export class VidLinkScraper implements Scraper {
  name = 'VidLink';
  priority = 5;
  supportedTypes = ['movie', 'tv'];
  private readonly logger = new Logger(VidLinkScraper.name);
  private readonly baseUrl = 'https://vidlink.pro';

  constructor(
    private configService: ConfigService,
    private puppeteerService: PuppeteerService
  ) { }

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for ${query} (TMDB: ${tmdbId}, IMDB: ${imdbId}, MAL: ${malId}, Type: ${mediaType}) [Priority: ${priority}]`);
    
    if (malId) {
      return [{
        title: `${query} (VidLink Anime)`,
        url: `${this.baseUrl}/anime/${malId}`,
        poster: ''
      }];
    }

    const activeType = mediaType === 'tv' ? 'tv' : 'movie';
    const id = tmdbId || imdbId;

    if (!id) {
      this.logger.warn('VidLink requires TMDB or IMDB ID');
      return [];
    }

    return [{
      title: `${query} (VidLink)`,
      url: `${this.baseUrl}/${activeType}/${id}`,
      poster: ''
    }];
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
    this.logger.log(`Attempting HLS extraction for VidLink: ${url} [Priority: ${priority}]`);

    return this.puppeteerService.withPage(async (page) => {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      let finalUrl = url;
      if (url.includes('/anime/')) {
        const type = episode?.type || 'sub';
        const epNum = episode?.episode || 1;
        finalUrl = `${url}/${epNum}/${type}`;
      } else if (episode && (episode.season || episode.episode)) {
        const s = episode.season || 1;
        const e = episode.episode || 1;
        
        // Robust URL building: always start from a base media URL if possible, 
        // or replace existing /tv/s/e pattern.
        if (finalUrl.includes('/movie/')) {
          finalUrl = finalUrl.replace('/movie/', '/tv/') + `/${s}/${e}`;
        } else if (finalUrl.includes('/tv/')) {
          // Replace anything after /tv/{id} with /{s}/{e}
          // URL format: https://vidlink.pro/tv/{id}/{s}/{e}
          const parts = finalUrl.split('/');
          const tvIndex = parts.indexOf('tv');
          if (tvIndex !== -1 && parts.length > tvIndex + 1) {
            // Keep up to ID, then add s/e
            finalUrl = parts.slice(0, tvIndex + 2).join('/') + `/${s}/${e}`;
          }
        } else {
          finalUrl = `${finalUrl.replace(/\/$/, '')}/tv/${s}/${e}`;
        }
      }

      this.logger.debug(`Navigating to VidLink URL: ${finalUrl}`);
      
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
          if (reqUrl.includes('.m3u8')) {
            this.logger.debug(`Found VidLink M3U8 early: ${reqUrl}`);
            const headers = request.headers();
            const headersBase64 = Buffer.from(JSON.stringify(headers)).toString('base64');
            m3u8Links.push({
              url: reqUrl,
              quality: 'Auto',
              isM3U8: true,
              headers: headers
            });

            // Resolve early for master playlist
            if (reqUrl.includes('master') || reqUrl.includes('index.m3u8')) {
              resolveLinks(m3u8Links);
            }
          }
        });

        try {
          // VidLink usually loads M3U8s very early after DOM content
          await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
          
          // Responsive polling for links
          for (let i = 0; i < 10 && m3u8Links.length === 0; i++) {
            await new Promise(r => setTimeout(r, 200));
          }

          // Try to click play button if no links found yet
          if (m3u8Links.length === 0) {
            this.logger.debug("Simulating interaction for VidLink...");
            await page.evaluate(() => {
              const selectors = ['#play', '.play', '#player', '.vjs-big-play-button'];
              for (const s of selectors) {
                const el = document.querySelector(s) as HTMLElement;
                if (el) { el.click(); return true; }
              }
              document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }).catch(() => {});
          }

          // Second polling pass after interaction
          for (let i = 0; i < 20 && !isResolved && m3u8Links.length === 0; i++) {
            await new Promise(r => setTimeout(r, 500));
          }
        } catch (e) {
          this.logger.warn(`VidLink navigation or interaction timed out`);
        }

        if (m3u8Links.length > 0) {
          resolveLinks(m3u8Links);
        } else {
          // Fallback to custom embed URL
          this.logger.warn(`No M3U8 links for VidLink, falling back`);
          const primaryColor = this.configService.get<string>('VIDLINK_PRIMARY_COLOR', 'e50914');
          resolveLinks([{
            url: `${finalUrl}?primaryColor=${primaryColor}&player=default&autoplay=true`,
            quality: 'Auto',
            isM3U8: false,
            headers: { 'Referer': `${this.baseUrl}/` }
          }]);
        }
      });
    }, priority).catch(error => {
      this.logger.error(`VidLink extraction failed: ${error.message}`);
      return [];
    });
  }
}
