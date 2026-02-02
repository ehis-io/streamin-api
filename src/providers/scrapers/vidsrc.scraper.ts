import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

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

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]> {
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
    // (Most providers index anime as TV shows via TMDB)
    const type = 'tv'; // For anime we default to TV if we got here. 
    // Wait, general search calls this too. 
    // We need to know if it's movie or tv.
    // The `getStreamLinks` adjusts, but search returns a URL.
    // Actually, let's infer: if it's anime (malId present), use 'tv'.
    // But the search method signature doesn't pass 'type'.

    // Simple heuristic: If malId is present, it's anime => 'tv'.
    // Otherwise we default to 'movie', but we might need to be smarter.
    // The `ProvidersService` calls `search` then `getStreamLinks`.
    // The `search` returns a `url` that `getStreamLinks` parses.

    // Changing default logic:
    // We will return generic embed URLs.

    const idParam = imdbId ? `imdb=${imdbId}` : `tmdb=${tmdbId}`;

    return this.baseUrls.flatMap(baseUrl => {
      const results: ScraperSearchResult[] = [];
      // Add movie option (default)
      results.push({
        title: `${query} (${new URL(baseUrl).hostname})`,
        url: `${baseUrl}/embed/movie?${idParam}`,
        poster: ''
      });
      // Add TV option
      results.push({
        title: `${query} (TV) (${new URL(baseUrl).hostname})`,
        url: `${baseUrl}/embed/tv?${idParam}`,
        poster: ''
      });
      return results;
    });
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]> {
    this.logger.log(`Attempting HLS extraction for VidSrc: ${url}`);

    const puppeteer = require('puppeteer-extra');
    const StealthPlugin = require('puppeteer-extra-plugin-stealth');
    puppeteer.use(StealthPlugin());

    let browser;
    try {
      browser = await puppeteer.launch({
        headless: true, // We can run headless for extraction
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });

      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

      let embedUrl = url;
      if (episode && (episode.season || episode.episode)) {
        if (embedUrl.includes('/movie?')) {
          embedUrl = embedUrl.replace('/movie?', '/tv?');
        }
        const operator = embedUrl.includes('?') ? '&' : '?';
        const season = episode.season || 1;
        embedUrl = `${embedUrl}${operator}season=${season}&episode=${episode.episode}`;
      }

      this.logger.debug(`Navigating to embed URL: ${embedUrl}`);
      
      const m3u8Links: StreamLink[] = [];

      // Intercept network requests to find the master playlist
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const reqUrl = request.url();
        if (reqUrl.includes('.m3u8')) {
          this.logger.debug(`Found potential M3U8 link: ${reqUrl}`);
          m3u8Links.push({
            url: reqUrl,
            quality: 'Auto',
            isM3U8: true,
            headers: request.headers()
          });
        }
        request.continue();
      });

      // Navigate and wait for some time for streams to load
      await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      
      // Sometimes we need a small delay for dynamic injectors
      await new Promise(resolve => setTimeout(resolve, 5000));

      if (m3u8Links.length > 0) {
        this.logger.log(`Successfully extracted ${m3u8Links.length} M3U8 links for VidSrc`);
        return m3u8Links;
      }

      this.logger.warn(`No M3U8 links found for VidSrc, falling back to embed URL`);
      return [{
        url: embedUrl,
        quality: 'Auto',
        isM3U8: false,
        headers: {
          'Referer': 'https://vicsrc.to/', // Common fallback referer
        }
      }];

    } catch (error) {
      this.logger.error(`VidSrc extraction failed: ${error.message}`);
      return [];
    } finally {
      if (browser) await browser.close();
    }
  }
}
