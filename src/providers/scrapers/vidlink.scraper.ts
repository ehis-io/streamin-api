import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';

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

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]> {
    if (malId) {
      return [{
        title: `${query} (VidLink Anime)`,
        url: `${this.baseUrl}/anime/${malId}`,
        poster: ''
      }];
    }

    if (!tmdbId) {
      this.logger.warn('VidLink requires TMDB ID for embedding');
      return [];
    }

    return [{
      title: `${query} (VidLink)`,
      url: `${this.baseUrl}/movie/${tmdbId}`, // Default to movie URL
      poster: ''
    }];
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]> {
    this.logger.log(`Attempting HLS extraction for VidLink: ${url}`);

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
            m3u8Links.push({
              url: reqUrl,
              quality: 'Auto',
              isM3U8: true,
              headers: request.headers()
            });

            // Resolve early for master playlist
            if (reqUrl.includes('master') || reqUrl.includes('index.m3u8')) {
              resolveLinks(m3u8Links);
            }
          }
        });

        try {
          // VidLink usually loads M3U8s very early after DOM content
          await page.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          
          // Wait a max of 3s for slow injectors
          if (m3u8Links.length === 0) {
            await new Promise(r => setTimeout(r, 3000));
          }
        } catch (e) {
          this.logger.warn(`VidLink navigation timed out, checking extracted links...`);
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
    }).catch(error => {
      this.logger.error(`VidLink extraction failed: ${error.message}`);
      return [];
    });
  }
}
