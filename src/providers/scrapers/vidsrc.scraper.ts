import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class VidSrcScraper implements Scraper {
  name = 'VidSrc';
  priority = 100;
  private readonly logger = new Logger(VidSrcScraper.name);
  private readonly baseUrls: string[];
  constructor(private configService: ConfigService) {
    const urls = this.configService.get<string>('VIDSRC_BASE_URLS');
    this.baseUrls = urls
      ? urls.split(',').map(u => u.trim())
      : [
        'https://vidsrc.me',
        'https://vidsrc.pm',
        'https://vidsrc.xyz',
        'https://vidsrc.net'
      ];
  }

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for ${query} (TMDB: ${tmdbId}, IMDB: ${imdbId}, MAL: ${malId}, Type: ${mediaType}) [Priority: ${priority}]`);
    if (!tmdbId) {
      this.logger.debug('VidSrc requires TMDB ID, skipping');
      return [];
    }

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
    this.logger.log(`Building iframe embed for VidSrc: ${url} [Priority: ${priority}]`);

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
      } catch {
        const operator = embedUrl.includes('?') ? '&' : '?';
        const season = episode.season || 1;
        embedUrl = `${embedUrl}${operator}season=${season}&episode=${episode.episode}`;
      }
    }

    return [{
      url: embedUrl,
      quality: 'Auto',
      isM3U8: false,
      headers: { 'Referer': 'https://vidsrc.to/' }
    }];
  }
}
