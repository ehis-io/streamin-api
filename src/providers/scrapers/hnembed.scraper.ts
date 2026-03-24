import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class HnEmbedScraper implements Scraper {
  name = 'HnEmbed';
  priority = 10;
  private readonly logger = new Logger(HnEmbedScraper.name);
  private readonly baseUrls: string[];

  constructor(private configService: ConfigService) {
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
    this.logger.log(`Building iframe embed for HnEmbed: ${url} [Priority: ${priority}]`);

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

    return [{
      url: embedUrl,
      quality: 'Auto',
      isM3U8: false,
      headers: { 'Referer': new URL(embedUrl).origin + '/' }
    }];
  }
}
