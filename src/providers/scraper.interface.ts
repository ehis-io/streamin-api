
export interface StreamLink {
  url: string;
  quality?: string; // e.g. "1080p", "720p"
  isM3U8?: boolean;
  provider?: string;
  headers?: Record<string, string>; // Referer, User-Agent etc.
  type?: 'sub' | 'dub'; // Indicates if the stream is subbed or dubbed
}

export interface ScraperSearchResult {
  title: string;
  url: string; // The url to scrape details or links from
  poster?: string;
}

export interface Scraper {
  name: string;
  priority: number;
  supportedTypes?: string[]; // e.g. ["movie", "tv", "anime"]

  /**
   * Search for a movie/tv show on this provider
   * @param query Title of the media
   * @param tmdbId Optional TMDB ID if available
   * @param imdbId Optional IMDB ID if available
   * @param malId Optional MAL ID if available
   */
  search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]>;

  /**
   * Extract stream links from a specific provider url
   */
  getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]>;
}

export const SCRAPER_TOKEN = Symbol('SCRAPER_TOKEN');
