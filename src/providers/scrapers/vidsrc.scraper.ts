import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class VidSrcScraper implements Scraper {
  name = 'VidSrc';
  priority = 10;
  private readonly logger = new Logger(VidSrcScraper.name);
  private readonly baseUrls = [
    'https://vidsrc-embed.ru',
    'https://vidsrc-embed.su',
    'https://vidsrcme.su',
    'https://vsrc.su'
  ];

  async search(query: string, tmdbId?: number, imdbId?: string): Promise<ScraperSearchResult[]> {
    // VidSrc-embed.ru works with both TMDB and IMDB IDs
    // Example: https://vidsrc-embed.ru/embed/movie?imdb=tt36741457

    if (!imdbId && !tmdbId) {
      this.logger.warn('VidSrc requires IMDB or TMDB ID, cannot search by title alone');
      return [];
    }

    const type = 'movie'; // Default to movie, getStreamLinks will adjust if it's TV
    const idParam = imdbId ? `imdb=${imdbId}` : `tmdb=${tmdbId}`;

    return this.baseUrls.map(baseUrl => ({
      title: `${query} (${new URL(baseUrl).hostname})`,
      url: `${baseUrl}/embed/${type}?${idParam}`,
      poster: ''
    }));
  }

  async getStreamLinks(url: string, episode?: { season: number, episode: number }): Promise<StreamLink[]> {
    this.logger.log(`Fetching stream from ${url}`);

    try {
      let embedUrl = url;
      const urlObj = new URL(url);
      const domain = `${urlObj.protocol}//${urlObj.hostname}`;

      // Handle TV show episode information
      if (episode) {
        if (url.includes('/movie?')) {
          embedUrl = url.replace('/movie?', '/tv?');
        }

        const operator = embedUrl.includes('?') ? '&' : '?';
        embedUrl = `${embedUrl}${operator}season=${episode.season}&episode=${episode.episode}`;
      }

      this.logger.log(`VidSrc embed URL: ${embedUrl}`);

      return [{
        url: embedUrl,
        quality: 'Auto',
        isM3U8: false,
        headers: {
          'Referer': `${domain}/`,
          'Origin': domain
        }
      }];

    } catch (error) {
      this.logger.error(`VidSrc scraping failed: ${error.message}`);
      return [];
    }
  }
}
