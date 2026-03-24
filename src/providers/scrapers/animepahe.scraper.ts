import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class AnimePaheScraper implements Scraper {
    name = 'AnimePahe';
    priority = 10;
    private readonly logger = new Logger(AnimePaheScraper.name);
    private readonly baseUrl = 'https://animepahe.si';

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
        this.logger.log(`Searching for ${query} [Priority: ${priority}]`);
        // AnimePahe requires direct page navigation, return a search URL
        return [{
            title: `${query} (AnimePahe)`,
            url: `${this.baseUrl}/anime/${query.toLowerCase().replace(/\s+/g, '-')}`,
            poster: ''
        }];
    }

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
        this.logger.log(`Building iframe embed for AnimePahe: ${url} [Priority: ${priority}]`);
        // AnimePahe doesn't have a simple embed URL, skip to avoid wasted page loads
        return [];
    }
}
