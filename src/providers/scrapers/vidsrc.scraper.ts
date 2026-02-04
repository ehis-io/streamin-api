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
    const type = 'tv'; 

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

    return this.puppeteerService.withPage(async (page) => {
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
      try {
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        // Sometimes we need a small delay for dynamic injectors
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (e) {
        this.logger.warn(`Navigation to ${embedUrl} failed or timed out: ${e.message}`);
      }

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
    }).catch(error => {
      this.logger.error(`VidSrc extraction failed: ${error.message}`);
      return [];
    });
  }
}
