
export interface StreamLink {
  url: string;
  quality?: string; // e.g. "1080p", "720p"
  isM3U8?: boolean;
  provider?: string;
  originalUrl?: string; // The original embed URL before extraction
  headers?: Record<string, string>; // Referer, User-Agent etc.
  type?: 'sub' | 'dub'; // Indicates if the stream is subbed or dubbed
  /**
   * When true, the frontend should route the manifest + segments through the
   * backend HLS proxy (for ad stripping or Referer/CORS bypass).
   * When false/undefined, segments can be served directly from the CDN
   * for a major speed boost (avoids the double-hop).
   */
  needsProxy?: boolean;
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
   * @param priority Optional priority for the search operation
   */
  search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority?: number, mediaType?: string): Promise<ScraperSearchResult[]>;

  /**
   * Extract stream links from a specific provider url
   * @param priority Optional priority for the stream link extraction operation
   */
  getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority?: number): Promise<StreamLink[]>;
}

export const SCRAPER_TOKEN = Symbol('SCRAPER_TOKEN');
