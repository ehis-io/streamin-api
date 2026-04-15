import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { IframeResolverService } from '../iframe-resolver.service';

@Injectable()
export class MirrorsScraper implements Scraper {
  name = 'MirrorResolver';
  priority = 1;
  private readonly logger = new Logger(MirrorsScraper.name);

  constructor(private iframeResolver: IframeResolverService) {}

  async search(): Promise<ScraperSearchResult[]> {
    // MirrorResolver is not a standalone scraper — it's invoked by ProvidersService
    // to deep-resolve embed URLs found by other scrapers.
    return [];
  }

  async getStreamLinks(url: string, episode?: any, priority: number = 0): Promise<StreamLink[]> {
    if (!this.iframeResolver.isResolvableEmbed(url)) {
      this.logger.debug(`Not a known embed mirror, skipping: ${url}`);
      return [];
    }

    this.logger.log(`Deep-resolving mirror embed: ${url}`);
    const links = await this.iframeResolver.resolve(url, priority);

    if (links.length > 0) {
      this.logger.log(`Resolved ${links.length} direct stream(s) from mirror: ${url}`);
    } else {
      this.logger.warn(`No streams found in mirror embed: ${url}`);
    }

    return links;
  }
}
