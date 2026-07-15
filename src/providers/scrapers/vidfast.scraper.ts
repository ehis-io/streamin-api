import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

/**
 * VidFast (https://vidfast.pro) — TMDB-keyed iframe embed provider.
 *
 * Patterns (verified live):
 *   movie -> /movie/<tmdbId>
 *   tv    -> /tv/<tmdbId>/<season>/<episode>
 *
 * Anime (/anime/<malId>/...) returns 404, so this scraper is movie/tv only.
 *
 * .pro 301s to .vc; we use .pro as the stable entry point so a future rotation is
 * followed automatically, at the cost of one redirect hop the browser handles.
 * Override with VIDFAST_BASE_URL rather than editing this file.
 */
@Injectable()
export class VidFastScraper implements Scraper {
  name = 'VidFast';
  priority = 6;
  supportedTypes = ['movie', 'tv'];
  private readonly logger = new Logger(VidFastScraper.name);
  private readonly baseUrl: string;

  constructor(private readonly configService: ConfigService) {
    // Configurable so a domain rotation is an env change, not a redeploy
    // (same reasoning as VIDSRC_BASE_URLS).
    this.baseUrl = (this.configService.get<string>('VIDFAST_BASE_URL') || 'https://vidfast.pro').replace(/\/$/, '');
  }

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for ${query} (TMDB: ${tmdbId}, IMDB: ${imdbId}, Type: ${mediaType}) [Priority: ${priority}]`);

    // VidFast has no anime catalogue — let the anime scrapers handle those.
    if (mediaType === 'anime') return [];

    const activeType = mediaType === 'tv' ? 'tv' : 'movie';
    const id = tmdbId || imdbId;

    if (!id) {
      this.logger.warn('VidFast requires a TMDB or IMDB ID');
      return [];
    }

    return [{
      title: `${query} (VidFast)`,
      url: `${this.baseUrl}/${activeType}/${id}`,
      poster: '',
    }];
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
    this.logger.log(`Building iframe embed for VidFast: ${url} [Priority: ${priority}]`);

    let finalUrl = url;

    // Series need /<season>/<episode> appended; a title mis-typed as a movie is
    // corrected to /tv/ once we know we have episode info.
    if (episode && (episode.season || episode.episode)) {
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

    const primaryColor = this.configService.get<string>('VIDFAST_PRIMARY_COLOR', 'e50914');
    return [{
      url: `${finalUrl}?theme=${primaryColor}&autoPlay=true`,
      quality: 'Auto',
      isM3U8: false,
      headers: { 'Referer': `${this.baseUrl}/` },
    }];
  }
}
