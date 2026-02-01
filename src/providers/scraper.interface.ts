
export interface StreamLink {
  url: string;
  quality?: string; // e.g. "1080p", "720p"
  isM3U8?: boolean;
  headers?: Record<string, string>; // Referer, User-Agent etc.
}

export interface ScraperSearchResult {
  title: string;
  url: string; // The url to scrape details or links from
  poster?: string;
}

export interface Scraper {
  name: string;
  priority: number;

  /**
   * Search for a movie/tv show on this provider
   * @param query Title of the media
   * @param tmdbId Optional TMDB ID if available
   * @param imdbId Optional IMDB ID if available
   */
  search(query: string, tmdbId?: number, imdbId?: string): Promise<ScraperSearchResult[]>;

  /**
   * Extract stream links from a specific provider url
   */
  getStreamLinks(url: string, episode?: { season: number, episode: number }): Promise<StreamLink[]>;
}

export const SCRAPER_TOKEN = Symbol('SCRAPER_TOKEN');
