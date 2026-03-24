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

  constructor(private configService: ConfigService) {}

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
    this.logger.log(`Building iframe embed for VidLink: ${url} [Priority: ${priority}]`);

    let finalUrl = url;
    if (url.includes('/anime/')) {
      const type = episode?.type || 'sub';
      const epNum = episode?.episode || 1;
      finalUrl = `${url}/${epNum}/${type}`;
    } else if (episode && (episode.season || episode.episode)) {
      const s = episode.season || 1;
      const e = episode.episode || 1;
      if (finalUrl.includes('/movie/')) {
        finalUrl = finalUrl.replace('/movie/', '/tv/') + `/${s}/${e}`;
      } else if (finalUrl.includes('/tv/')) {
        const parts = finalUrl.split('/');
        const tvIndex = parts.indexOf('tv');
        if (tvIndex !== -1 && parts.length > tvIndex + 1) {
          finalUrl = parts.slice(0, tvIndex + 2).join('/') + `/${s}/${e}`;
        }
      } else {
        finalUrl = `${finalUrl.replace(/\/$/, '')}/tv/${s}/${e}`;
      }
    }

    const primaryColor = this.configService.get<string>('VIDLINK_PRIMARY_COLOR', 'e50914');
    return [{
      url: `${finalUrl}?primaryColor=${primaryColor}&player=default&autoplay=true`,
      quality: 'Auto',
      isM3U8: false,
      headers: { 'Referer': `${this.baseUrl}/` }
    }];
  }
}
