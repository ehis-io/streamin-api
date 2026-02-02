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
    this.logger.log(`Generating VidLink stream for: ${url} ${episode ? `(E${episode.episode}${episode.season ? `, S${episode.season}` : ''}, ${episode.type})` : ''}`);

    try {
      let finalUrl = url;

      if (url.includes('/anime/')) {
        // Format: /anime/{MALid}/{number}/{subOrDub}
        const type = episode?.type || 'sub';
        const epNum = episode?.episode || 1;
        finalUrl = `${url}/${epNum}/${type}`;
        this.logger.log(`VidLink Anime URL constructed: ${finalUrl} (MAL ID: ${url.split('/anime/')[1]}, Episode: ${epNum}, Type: ${type})`);
      } else if (episode && episode.season) {
        finalUrl = url.replace('/movie/', '/tv/') + `/${episode.season}/${episode.episode}`;
      }

      // Read customization from config or use theme-consistent defaults
      const primaryColor = this.configService.get<string>('VIDLINK_PRIMARY_COLOR', 'e50914');
      const secondaryColor = this.configService.get<string>('VIDLINK_SECONDARY_COLOR', '1f1f1f');
      const iconColor = this.configService.get<string>('VIDLINK_ICON_COLOR', 'ffffff');
      const icons = this.configService.get<string>('VIDLINK_ICONS', 'vid');

      const params = new URLSearchParams({
        primaryColor,
        secondaryColor,
        iconColor,
        icons,
        player: 'default',
        autoplay: 'true',
        title: 'true',
        poster: 'true',
        nextbutton: 'true',
        fallback: 'true'
      });

      finalUrl = `${finalUrl}?${params.toString()}`;

      this.logger.log(`VidLink final URL: ${finalUrl}`);

      return [{
        url: finalUrl,
        quality: 'Auto',
        isM3U8: false,
        headers: {
          'Referer': `${this.baseUrl}/`,
          'Origin': this.baseUrl
        }
      }];

    } catch (error) {
      this.logger.error(`VidLink URL construction failed: ${error.message}`);
      return [];
    }
  }
}
