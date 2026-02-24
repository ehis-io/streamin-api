import { Injectable, Logger, Inject } from '@nestjs/common';
import { Scraper, StreamLink, ScraperSearchResult, SCRAPER_TOKEN } from './scraper.interface';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);

  private readonly validationQueues = new Map<string, (() => Promise<void>)[]>();
  private readonly activeValidations = new Map<string, number>();
  private readonly coolingDownDomains = new Map<string, number>();
  private readonly MAX_CONCURRENT_PER_DOMAIN = 3;
  private readonly RETRY_DELAY_MS = 5000;
  private readonly COOL_DOWN_MS = 30000;
  private readonly MAX_RETRIES = 3;

  constructor(
    @Inject(SCRAPER_TOKEN) private scrapers: Scraper[],
    private tmdbService: TmdbService,
    private malService: MALService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private prisma: PrismaService,
  ) {
    // Ensure scrapers is an array (handles cases where NestJS might inject a single object or nothing)
    this.scrapers = Array.isArray(this.scrapers) ? this.scrapers : (this.scrapers ? [this.scrapers] : []);
    this.scrapers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.logger.log(`Registered ${this.scrapers.length} scrapers: ${this.scrapers.map(s => s.name).join(', ')}`);
  }

  getScrapers(): Scraper[] {
    return this.scrapers;
  }

  async findStreamLinks(
    id: string,
    seasonParam?: number,
    episodeParam?: number,
    type: 'sub' | 'dub' = 'sub',
    mediaType?: string,
    onLinkFound?: (link: StreamLink) => void,
    priority: number = 0
  ): Promise<StreamLink[]> {
    const season = seasonParam ? Number(seasonParam) : undefined;
    const episode = episodeParam ? Number(episodeParam) : undefined;

    // Check Database for persistent storage
    // Ensure ID is numeric for TMDB/MAL providers
    const numericId = parseInt(id);
    if (isNaN(numericId) || numericId <= 0) {
      this.logger.warn(`Invalid numeric ID provided for stream discovery: ${id}`);
      return [];
    }

    let activeMediaType = mediaType;
    if (!activeMediaType) {
      activeMediaType = (season && episode) ? 'tv' : 'movie';
    }

    let title = '';
    let tmdbId: number | undefined;
    let malId: number | undefined;
    let imdbId: string | undefined;

    let details: any;
    try {
      if (activeMediaType === 'anime') {
        malId = numericId;
        const animeResponse = await this.malService.getDetails(malId);
        details = (animeResponse as any).data;
        title = details.title;

        // Try to map MAL Anime to TMDB TV Show by title
        try {
          const searchRes = await this.tmdbService.search(title, 'tv');
          if (searchRes.results && searchRes.results.length > 0) {
            // Best effort: take first result. 
            // In production, we might want to check release year or fuzzy match title.
            tmdbId = searchRes.results[0].id;
            this.logger.log(`Mapped Anime "${title}" (MAL: ${malId}) to TMDB ID: ${tmdbId}`);
          } else {
            this.logger.warn(`Could not find TMDB match for Anime "${title}"`);
          }
        } catch (searchError) {
          this.logger.warn(`TMDB search failed for Anime mapping: ${searchError.message}`);
        }

      } else {
        tmdbId = numericId;
        details = await this.tmdbService.getDetails(tmdbId, activeMediaType as 'movie' | 'tv');
        title = activeMediaType === 'movie' ? details.title : details.name;
        imdbId = details.external_ids?.imdb_id || details.imdb_id;
      }
    } catch (e) {
      this.logger.error(`Failed to fetch metadata for ${id} (${activeMediaType}): ${e.message}`);
      return [];
    }

    this.logger.log(`Resolving streams for ${title} (${activeMediaType}) - S${season} E${episode} [Priority: ${priority}]`);

    const allLinks: StreamLink[] = [];
    const activeScrapers = this.scrapers.filter(s =>
      !s.supportedTypes || s.supportedTypes.includes(activeMediaType!)
    );

    // Run ALL scrapers in parallel for maximum speed. 
    // PuppeteerService handles queuing to avoid resource exhaustion.
    const scraperPromises = activeScrapers.map(async (scraper) => {
      try {
        let searchResults: ScraperSearchResult[] = [];

        // Unique key for individual provider mappings - include mediaType and season for TV to avoid collisions
        let mappingKey = activeMediaType === 'anime'
          ? `mal:anime:${malId}:${scraper.name}`
          : `tmdb:${activeMediaType}:${tmdbId}:${scraper.name}`;
          
        if (activeMediaType === 'tv' && season) {
          mappingKey += `:s${season}`;
        }

        this.logger.debug(`[${scraper.name}] Using mappingKey: ${mappingKey}`);

        // Check for existing mapping to skip search
        const mapping = await (this.prisma as any).providerMapping.findUnique({
          where: { mappingKey }
        });

        if (mapping) {
          this.logger.debug(`Using mapped URL for ${scraper.name}: ${mapping.externalUrl}`);
          searchResults = [{
            title: title || 'Media',
            url: mapping.externalUrl
          }];
        } else {
          // For TV shows, specifically include the season in the search query to improve accuracy
          const searchQuery = (activeMediaType === 'tv' && season) 
            ? `${title} Season ${season}` 
            : title;
            
          this.logger.debug(`Searching for ${scraper.name} using query: "${searchQuery}"`);
          searchResults = await scraper.search(searchQuery, tmdbId, imdbId, malId, priority, activeMediaType);
          
          // Save the first mapping for future use
          // CRITICAL: Ensure we don't map episode-specific URLs at the show level
          if (searchResults.length > 0) {
            const bestResult = searchResults[0];
            const lowerUrl = bestResult.url.toLowerCase();
            const isEpisodeSpecific = 
              (lowerUrl.includes('/tv/') && (lowerUrl.match(/\//g) || []).length > 4) ||
              lowerUrl.includes('episode=') ||
              lowerUrl.includes('season=') ||
              lowerUrl.includes('/play/') ||
              lowerUrl.includes('/watch/');
            
            if (!isEpisodeSpecific) {
              try {
                await (this.prisma as any).providerMapping.upsert({
                  where: { mappingKey },
                  update: {
                    externalUrl: bestResult.url,
                    tmdbId: tmdbId || null,
                    malId: malId || null
                  },
                  create: {
                    mappingKey,
                    tmdbId: tmdbId || null,
                    malId: malId || null,
                    provider: scraper.name,
                    externalUrl: bestResult.url
                  }
                });
              } catch (mapError) {
                this.logger.warn(`Could not save provider mapping for ${mappingKey}: ${mapError.message}`);
              }
            } else {
              this.logger.debug(`Skipping show-level mapping for episode-specific URL: ${bestResult.url}`);
            }
          }
        }

        const scraperLinksPromises = searchResults.map(async (result) => {
          try {
            const streamParams = (activeMediaType === 'anime' || (season && episode))
              ? { season: season || 1, episode: episode || 1, type }
              : undefined;

            const links = await scraper.getStreamLinks(result.url, streamParams, priority);
            return links.map(l => ({
              ...l,
              provider: result.title.includes('(') ? result.title : `${scraper.name} (${new URL(result.url).hostname})`
            }) as (StreamLink & { provider: string }));
          } catch (e) {
            this.logger.warn(`${scraper.name} mirror ${result.url} failed: ${e.message}`);
            return [];
          }
        });

        const nestedResults = await Promise.all(scraperLinksPromises);
        const flatLinks = nestedResults.flat();

        // Validate streams
        const validationResults = await Promise.all(
          flatLinks.map(async (link) => {
            try {
              const isValid = await this.validateStream(link.url, priority);
              if (isValid) {
                if (onLinkFound) onLinkFound(link);
                return link;
              }
            } catch (valError) {
              this.logger.warn(`Validation crashed for ${link.url}: ${valError.message}`);
            }
            return null;
          })
        );

        const validLinks = validationResults.filter((l): l is StreamLink & { provider: string } => l !== null);
        allLinks.push(...validLinks);
        return validLinks;
      } catch (e) {
        this.logger.error(`${scraper.name} CRITICAL FAILURE: ${e.message}`);
        return [];
      }
    });

    // Wait for all scrapers to complete (or fail)
    await Promise.all(scraperPromises);

    return allLinks;
  }

  private async validateStream(url: string, priority: number = 0): Promise<boolean> {
    const domain = new URL(url).hostname;
    const isRestricted = domain.includes('vidsrc') ||
      domain.includes('vidlink.pro') ||
      domain.includes('gogoanime') ||
      domain.includes('9animetv.be');

    // Fast-path for direct M3U8 links from trusted high-priority scrapers if they're not restricted
    if (!isRestricted && url.includes('.m3u8')) {
      this.logger.debug(`Fast-tracking validation for M3U8: ${domain}`);
      return true;
    }

    if (!isRestricted) {
      return this.executeValidation(url);
    }

    // Check if domain is in cool-down
    const coolDownUntil = this.coolingDownDomains.get(domain);
    if (coolDownUntil && Date.now() < coolDownUntil) {
      this.logger.debug(`Skipping validation for ${domain} due to cool-down until ${new Date(coolDownUntil).toISOString()}`);
      return false;
    }

    // Rate limiting logic for restricted domains
    return new Promise((resolve) => {
      const queue = this.validationQueues.get(domain) || [];
      const runValidation = async () => {
        const active = this.activeValidations.get(domain) || 0;
        this.activeValidations.set(domain, active + 1);

        try {
          const result = await this.executeValidation(url);
          resolve(result);
        } finally {
          const newActive = (this.activeValidations.get(domain) || 1) - 1;
          this.activeValidations.set(domain, newActive);
          this.processQueue(domain);
        }
      };

      if ((this.activeValidations.get(domain) || 0) < this.MAX_CONCURRENT_PER_DOMAIN) {
        runValidation();
      } else {
        queue.push(runValidation);
        this.validationQueues.set(domain, queue);
      }
    });
  }

  private processQueue(domain: string) {
    const queue = this.validationQueues.get(domain);
    if (queue && queue.length > 0 && (this.activeValidations.get(domain) || 0) < this.MAX_CONCURRENT_PER_DOMAIN) {
      const next = queue.shift();
      if (next) next();
    }
  }

  private async executeValidation(url: string, attempt: number = 1): Promise<boolean> {
    const domain = new URL(url).hostname;
    try {
      // First try a HEAD request - it's much faster and uses less bandwidth
      // Some providers block HEAD, so we fallback to GET
      try {
        const headResponse = await axios.head(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': url
          },
          timeout: 1500 // Reduced from 2s to 1.5s
        });
        if (headResponse.status === 200) return true;
      } catch (headError) {
        // If HEAD fails, proceed to GET
        this.logger.debug(`HEAD validation failed for ${url}, trying GET...`);
      }

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': url
        },
        timeout: 5000, // Reduced from 8s to 5s for faster fail-fast
        responseType: 'stream' // Use stream to avoid downloading huge files
      });

      // Read only a small portion of the response to check for error text
      return new Promise((resolve) => {
        let buffer = '';
        const stream = response.data;

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lowerData = buffer.toLowerCase();

          if (lowerData.includes("we couldn't find this episode") ||
            lowerData.includes("please check back another time") ||
            lowerData.includes("404 not found") ||
            lowerData.includes("video not found") ||
            lowerData.includes("file was deleted") ||
            lowerData.includes("no longer available")) {
            stream.destroy();
            resolve(false);
          }

          // If we've read 2KB (reduced from 10KB) and haven't found error text, assume it's valid
          // This speeds up validation significantly for working streams
          if (buffer.length > 2048) {
            stream.destroy();
            resolve(true);
          }
        });

        stream.on('end', () => resolve(true));
        stream.on('error', () => resolve(false));
      });

    } catch (e) {
      if (e.response?.status === 429 && attempt <= this.MAX_RETRIES) {
        this.logger.warn(`Rate limited (429) by ${domain}. Retrying in ${this.RETRY_DELAY_MS}ms (Attempt ${attempt}/${this.MAX_RETRIES})`);

        // Set cool-down for the domain to prevent new requests from starting
        this.coolingDownDomains.set(domain, Date.now() + this.COOL_DOWN_MS);

        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS));
        return this.executeValidation(url, attempt + 1);
      }

      this.logger.debug(`Stream validation failed for ${url}: ${e.message}`);
      return false;
    }
  }

  /**
   * Proactively resolve and cache links for a batch of media items.
   * This runs in the background to avoid blocking the main thread.
   */
  async prefetchLinks(
    items: { id: string, mediaType: 'movie' | 'tv' | 'anime', title?: string }[],
    onLinkFound?: (id: string, link: StreamLink) => void
  ) {
    this.logger.log(`Queueing prefetch for ${items.length} items`);

    // Simple background queue to avoid overloading
    const queue = [...items];
    const concurrentLimit = 3;

    const processQueue = async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) break;

        try {
          this.logger.debug(`Proactively resolving streams for ${item.id} (${item.mediaType})`);
          // Resolve links (this also saves to DB and cache)
            await this.findStreamLinks(
              item.id,
              item.mediaType === 'tv' ? 1 : undefined,
              item.mediaType === 'tv' ? 1 : (item.mediaType === 'anime' ? 1 : undefined),
              'sub',
              item.mediaType,
              onLinkFound ? (link) => onLinkFound(item.id, link) : undefined,
              1 // LOW PRIORITY for prefetch
            );
        } catch (err) {
          this.logger.debug(`Background prefetch failed for ${item.id}: ${err.message}`);
        }

        // Small delay between items to be nice to providers
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };

    // Start workers
    for (let i = 0; i < Math.min(concurrentLimit, items.length); i++) {
      processQueue();
    }
  }
}
