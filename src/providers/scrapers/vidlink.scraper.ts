import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class VidLinkScraper implements Scraper {
  name = 'VidLink';
  priority = 10; // Higher priority as it's a reliable provider
  private readonly logger = new Logger(VidLinkScraper.name);
  private readonly baseUrl = 'https://vidlink.pro';

  async search(query: string, tmdbId?: number, imdbId?: string): Promise<ScraperSearchResult[]> {
    if (!tmdbId) {
      this.logger.warn('VidLink requires TMDB ID for embedding');
      return [];
    }

    // Since VidLink uses direct TMDB ID-based URLs, we return a virtual search result
    // that getStreamLinks will use to construct the final URL.
    return [{
      title: `${query} (VidLink)`,
      url: `${this.baseUrl}/movie/${tmdbId}`, // Default to movie URL
      poster: ''
    }];
  }

  async getStreamLinks(url: string, episode?: { season: number, episode: number }): Promise<StreamLink[]> {
    this.logger.log(`Generating VidLink stream for: ${url} ${episode ? `(S${episode.season}E${episode.episode})` : ''}`);

    try {
      let finalUrl = url;

      // If it's a TV show episode, transform the URL
      if (episode) {
        // url is something like: https://vidlink.pro/movie/12345
        // We need: https://vidlink.pro/tv/12345/season/episode
        finalUrl = url.replace('/movie/', '/tv/') + `/${episode.season}/${episode.episode}`;
      }

      // Add default customization parameters for a premium look
      // primaryColor=63b8bc&secondaryColor=a2a2a2&iconColor=eefdec&icons=vid&title=true&poster=true&nextbutton=true
      const params = new URLSearchParams({
        primaryColor: '63b8bc',
        secondaryColor: 'a2a2a2',
        iconColor: 'eefdec',
        icons: 'vid',
        title: 'true',
        poster: 'true',
        nextbutton: 'true'
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
