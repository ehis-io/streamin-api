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
  private readonly MAX_CONCURRENT_PER_DOMAIN = 2;
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
    season?: number,
    episode?: number,
    type: 'sub' | 'dub' = 'sub',
    mediaType?: string,
    onLinkFound?: (link: StreamLink) => void
  ): Promise<StreamLink[]> {
    const cacheKey = `streams:${id}:${season || ''}:${episode || ''}:${mediaType || ''}`;
    const cached = await this.cacheManager.get<StreamLink[]>(cacheKey);
    if (cached) {
      this.logger.log(`Returned cached streams for ${cacheKey}`);
      return cached;
    }

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

    const dbLinks = await (this.prisma as any).streamedLink.findMany({
      where: activeMediaType === 'anime'
        ? { malId: numericId, episode: episode || 1 }
        : { tmdbId: numericId, season: season || null, episode: episode || null }
    });

    if (dbLinks.length > 0) {
      this.logger.log(`Found ${dbLinks.length} streams in DB for ${id}`);
      const links = dbLinks.map(dbLink => ({
        url: dbLink.url,
        quality: dbLink.quality || 'Auto',
        isM3U8: dbLink.isM3U8,
        provider: dbLink.provider,
        type: dbLink.type as 'sub' | 'dub',
        headers: dbLink.headers ? JSON.parse(dbLink.headers) : undefined
      }));
      // Also cache in Redis for faster access
      await this.cacheManager.set(cacheKey, links, 86400000);
      return links;
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

    this.logger.log(`Resolving streams for ${title} (${activeMediaType})`);

    const allLinks: StreamLink[] = [];
    const activeScrapers = this.scrapers.filter(s =>
      !s.supportedTypes || s.supportedTypes.includes(activeMediaType!)
    );

    const scraperResults = await Promise.all(activeScrapers.map(async (scraper) => {
      try {
        let searchResults: ScraperSearchResult[] = [];

        // Unique key for individual provider mappings
        const mappingKey = activeMediaType === 'anime'
          ? `mal:${malId}:${scraper.name}`
          : `tmdb:${tmdbId}:${scraper.name}`;

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
          searchResults = await scraper.search(title, tmdbId, imdbId, malId);

          // Save the first mapping for future use
          if (searchResults.length > 0) {
            const bestResult = searchResults[0];
            try {
              // Manual upsert-like logic with mappingKey
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
          }
        }

        const scraperLinksPromises = searchResults.map(async (result) => {
          try {
            const streamParams = (activeMediaType === 'anime' || (season && episode))
              ? { season, episode: episode || 1, type }
              : undefined;

            const links = await scraper.getStreamLinks(result.url, streamParams);
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

        // Validate streams (check for "Not Found" or specific error text)
        // This is important for providers that return 200 OK even for error pages
        // Validate streams in parallel (respecting per-domain limits inside validateStream)
        const validationResults = await Promise.all(
          flatLinks.map(async (link) => {
            // Respecting per-domain limits inside validateStream
            const isValid = await this.validateStream(link.url);
            if (isValid) {
              if (onLinkFound) (onLinkFound as any)(link); // REPORT REAL-TIME
              return link;
            }
            return null;
          })
        );

        return validationResults.filter((l): l is (typeof flatLinks)[0] => l !== null);
      } catch (e) {
        this.logger.warn(`${scraper.name} failed: ${e.message}`);
        return [];
      }
    }));

    scraperResults.forEach(res => {
      if (res) allLinks.push(...res);
    });

    if (allLinks.length > 0) {
      await this.cacheManager.set(cacheKey, allLinks, 86400000); // 24 hours

      // Persist to Database for long-term cache
      try {
        const createManyParams = allLinks.map(link => ({
          tmdbId: activeMediaType !== 'anime' ? tmdbId : null,
          malId: activeMediaType === 'anime' ? malId : null,
          season: season || null,
          episode: episode || null,
          url: link.url,
          quality: link.quality,
          isM3U8: !!link.isM3U8,
          provider: link.provider || 'Unknown',
          type: link.type || null,
          headers: link.headers ? JSON.stringify(link.headers) : null
        }));

        // Avoid duplicates if same URL exists for same ID/EP
        for (const data of createManyParams) {
          try {
            const existing = await (this.prisma as any).streamedLink.findFirst({
              where: {
                url: data.url,
                tmdbId: data.tmdbId,
                malId: data.malId,
                season: data.season,
                episode: data.episode,
                type: data.type
              }
            });

            if (!existing) {
              await (this.prisma as any).streamedLink.create({ data });
            }
          } catch (e) {
            this.logger.warn(`Failed to save link ${data.url} to DB: ${e.message}`);
          }
        }
      } catch (dbError) {
        this.logger.warn(`Failed to save streams to DB: ${dbError.message}`);
      }
    }

    return allLinks;
  }

  private async validateStream(url: string): Promise<boolean> {
    const domain = new URL(url).hostname;
    const isRestricted = domain.includes('vidsrc') ||
      domain.includes('vidlink.pro') ||
      domain.includes('gogoanime') ||
      domain.includes('9animetv.be');

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
          timeout: 5000
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
        timeout: 10000,
        responseType: 'stream' // Use stream to avoid downloading huge files
      });

      // Read only a small portion of the response to check for error text
      return new Promise((resolve) => {
        let buffer = '';
        const stream = response.data;

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lowerData = buffer.toLowerCase();

          if (lowerData.includes("we coudn't find this episode") ||
            lowerData.includes("please check back another time") ||
            lowerData.includes("404 not found") ||
            lowerData.includes("video not found") ||
            lowerData.includes("file was deleted") ||
            lowerData.includes("no longer available")) {
            stream.destroy();
            resolve(false);
          }

          // If we've read 10KB and haven't found error text, assume it's valid
          if (buffer.length > 10240) {
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
          // Check if already in DB to skip expensive search
          const numericId = parseInt(item.id);
          const existing = await (this.prisma as any).streamedLink.findFirst({
            where: item.mediaType === 'anime'
              ? { malId: numericId, episode: 1 }
              : { tmdbId: numericId, season: item.mediaType === 'tv' ? 1 : null, episode: item.mediaType === 'tv' ? 1 : null }
          });

          if (existing) {
            this.logger.debug(`Skipping prefetch for ${item.id} - already in DB`);
            continue;
          }

          this.logger.debug(`Proactively resolving streams for ${item.id} (${item.mediaType})`);
          // Resolve links (this also saves to DB and cache)
          await this.findStreamLinks(
            item.id,
            item.mediaType === 'tv' ? 1 : undefined,
            item.mediaType === 'tv' ? 1 : (item.mediaType === 'anime' ? 1 : undefined),
            'sub',
            item.mediaType,
            onLinkFound ? (link) => onLinkFound(item.id, link) : undefined
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
