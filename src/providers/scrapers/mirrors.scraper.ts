import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';

@Injectable()
export class MirrorsScraper implements Scraper {
  name = 'MirrorResolver';
  priority = 1;
  private readonly logger = new Logger(MirrorsScraper.name);

  async search(): Promise<ScraperSearchResult[]> {
    return [];
  }

  async getStreamLinks(url: string, episode?: any, priority: number = 0): Promise<StreamLink[]> {
    // Mirror resolution via Puppeteer disabled — scrapers return embeds directly now
    this.logger.debug(`MirrorResolver: skipping ${url}`);
    return [];
  }
}
