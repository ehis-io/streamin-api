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
    this.logger.log(`Fetching stream from ${url}`);

    try {
      let embedUrl = url;
      const urlObj = new URL(url);
      const domain = `${urlObj.protocol}//${urlObj.hostname}`;

      // Handle TV show / Anime episode information
      if (episode && (episode.season || episode.episode)) {
        // If the base URL was /movie, force switch to /tv
        if (embedUrl.includes('/movie?')) {
          embedUrl = embedUrl.replace('/movie?', '/tv?');
        }

        const operator = embedUrl.includes('?') ? '&' : '?';
        // For anime, if season is missing, default to 1.
        const season = episode.season || 1;
        embedUrl = `${embedUrl}${operator}season=${season}&episode=${episode.episode}`;
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
