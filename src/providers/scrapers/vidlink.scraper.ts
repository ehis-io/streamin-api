import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class VidLinkScraper implements Scraper {
  name = 'VidLink';
  priority = 5;
  supportedTypes = ['movie', 'tv'];
  private readonly logger = new Logger(VidLinkScraper.name);
  private readonly baseUrl = 'https://vidlink.pro';

  constructor(private configService: ConfigService) { }

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

    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      let finalUrl = url;
      if (url.includes('/anime/')) {
        const type = episode?.type || 'sub';
        const epNum = episode?.episode || 1;
        finalUrl = `${url}/${epNum}/${type}`;
      } else if (episode && episode.season) {
        finalUrl = url.replace('/movie/', '/tv/') + `/${episode.season}/${episode.episode}`;
      }

      this.logger.debug(`Navigating to VidLink URL: ${finalUrl}`);

      const m3u8Links: StreamLink[] = [];

      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const reqUrl = request.url();
        if (reqUrl.includes('.m3u8')) {
          this.logger.debug(`Found VidLink M3U8: ${reqUrl}`);
          m3u8Links.push({
            url: reqUrl,
            quality: 'Auto',
            isM3U8: true,
            headers: request.headers()
          });
        }
        request.continue();
      });

      await page.goto(finalUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 3000));

      if (m3u8Links.length > 0) {
        this.logger.log(`Successfully extracted ${m3u8Links.length} M3U8 links for VidLink`);
        return m3u8Links;
      }

      this.logger.warn(`No M3U8 links found for VidLink, falling back to custom embed URL`);
      const primaryColor = this.configService.get<string>('VIDLINK_PRIMARY_COLOR', 'e50914');
      const params = new URLSearchParams({
        primaryColor,
        player: 'default',
        autoplay: 'true'
      });
      return [{
        url: `${finalUrl}?${params.toString()}`,
        quality: 'Auto',
        isM3U8: false,
        headers: {
          'Referer': `${this.baseUrl}/`
        }
      }];

    } catch (error) {
      this.logger.error(`VidLink extraction failed: ${error.message}`);
      return [];
    } finally {
      if (browser) await browser.close();
    }
  }
}
