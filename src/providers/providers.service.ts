import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, StreamLink, ScraperSearchResult, SCRAPER_TOKEN } from './scraper.interface';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export interface ScraperStatus {
  name: string;
  status: 'success' | 'failed' | 'timeout' | 'no_results' | 'circuit_open';
  linksFound: number;
  durationMs: number;
  error?: string;
  circuitState?: 'closed' | 'open' | 'half-open';
}

export interface StreamResult {
  links: StreamLink[];
  scraperStatuses: ScraperStatus[];
}

/** Quality score for speculative completion weighting */
function qualityScore(link: StreamLink): number {
  if (!link.isM3U8) return 1;
  const q = (link.quality || '').toLowerCase();
  if (q.includes('1080')) return 10;
  if (q.includes('720')) return 7;
  if (q.includes('480')) return 4;
  if (q.includes('360')) return 2;
  // "auto" or master playlists typically serve adaptive quality
  if (q.includes('auto') || link.url.includes('master')) return 8;
  return 5;
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  private readonly STREAM_TIMEOUT_MS: number;

  private readonly inFlightRequests = new Map<string, { promise: Promise<StreamResult>, priority: number }>();
  private readonly activePrefetches = new Set<string>();
  private globalPrefetchCount = 0;
  private readonly MAX_GLOBAL_PREFETCH = 3; // Total background tasks allowed across all requests

  constructor(
    @Inject(SCRAPER_TOKEN) private scrapers: Scraper[],
    private tmdbService: TmdbService,
    private malService: MALService,
    private prisma: PrismaService,
    private validationService: StreamValidationService,
    private cacheService: StreamCacheService,
    private circuitBreaker: CircuitBreakerService,
    private configService: ConfigService,
  ) {
    this.scrapers = Array.isArray(this.scrapers) ? this.scrapers : (this.scrapers ? [this.scrapers] : []);
    this.scrapers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.logger.log(`Registered ${this.scrapers.length} scrapers: ${this.scrapers.map(s => s.name).join(', ')}`);

    this.STREAM_TIMEOUT_MS = this.configService.get<number>('STREAM_TIMEOUT_MS', 30000); // Increased to 30s for better stability

    axios.defaults.httpAgent = httpAgent;
    axios.defaults.httpsAgent = httpsAgent;
  }

  getScrapers(): Scraper[] {
    return this.scrapers;
  }

  getScraperHealth() {
    return this.circuitBreaker.getAllHealth();
  }

  async findStreamLinks(
    id: string,
    seasonParam?: number,
    episodeParam?: number,
    type: 'sub' | 'dub' = 'sub',
    mediaType?: string,
    onLinkFound?: (link: StreamLink) => void,
    priority: number = 0
  ): Promise<StreamResult> {
    const season = seasonParam ? Number(seasonParam) : undefined;
    const episode = episodeParam ? Number(episodeParam) : undefined;

    const numericId = parseInt(id);
    if (isNaN(numericId) || numericId <= 0) {
      this.logger.warn(`Invalid numeric ID provided for stream discovery: ${id}`);
      return { links: [], scraperStatuses: [] };
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

        try {
          const searchRes = await this.tmdbService.search(title, 'tv');
          if (searchRes.results && searchRes.results.length > 0) {
            tmdbId = searchRes.results[0].id;
            this.logger.log(`Mapped Anime "${title}" (MAL: ${malId}) to TMDB ID: ${tmdbId}`);
          } else {
            this.logger.warn(`Could not find TMDB match for Anime "${title}"`);
          }
        } catch (searchError: any) {
          this.logger.warn(`TMDB search failed for Anime mapping: ${searchError.message}`);
        }
      } else {
        tmdbId = numericId;
        details = await this.tmdbService.getDetails(tmdbId, activeMediaType as 'movie' | 'tv');
        title = activeMediaType === 'movie' ? details.title : details.name;
        imdbId = details.external_ids?.imdb_id || details.imdb_id;
      }
    } catch (e: any) {
      this.logger.error(`Failed to fetch metadata for ${id} (${activeMediaType}): ${e.message}`);
      return { links: [], scraperStatuses: [] };
    }

    const dbSeason = (activeMediaType === 'tv' || activeMediaType === 'anime') ? (season || 1) : null;
    const dbEpisode = (activeMediaType === 'tv' || activeMediaType === 'anime') ? (episode || 1) : null;

    const requestKey = `${activeMediaType}:${activeMediaType === 'anime' ? malId : tmdbId}:s${dbSeason}:e${dbEpisode}:${type}`;

    // Deduplication: join in-flight request
    const inFlight = this.inFlightRequests.get(requestKey);
    if (inFlight) {
      if (priority < inFlight.priority) {
        this.logger.debug(`[Priority Boost] Upgrading ${requestKey} from ${inFlight.priority} to ${priority}`);
        inFlight.priority = priority;
      }
      this.logger.debug(`[Deduplication] Joining in-flight request for ${requestKey}`);
      const result = await inFlight.promise;
      if (onLinkFound) {
        result.links.forEach((link: any) => onLinkFound(link));
      }
      return result;
    }

    const fetchPromise = (async () => {
      try {
        // Use a dynamic priority getter so logic within can see upgrades
        const getCurrentPriority = () => this.inFlightRequests.get(requestKey)?.priority ?? priority;
        
        return await this.performFindStreamLinks(
          id, numericId, title, tmdbId, malId, imdbId, activeMediaType,
          dbSeason, dbEpisode, type, onLinkFound, getCurrentPriority
        );
      } finally {
        this.inFlightRequests.delete(requestKey);
      }
    })();

    this.inFlightRequests.set(requestKey, { promise: fetchPromise, priority });
    return fetchPromise;
  }

  private async performFindStreamLinks(
    id: string,
    numericId: number,
    title: string,
    tmdbId: number | undefined,
    malId: number | undefined,
    imdbId: string | undefined,
    activeMediaType: string | undefined,
    dbSeason: number | null,
    dbEpisode: number | null,
    type: 'sub' | 'dub',
    onLinkFound?: (link: StreamLink) => void,
    priority: number | (() => number) = 0
  ): Promise<StreamResult> {
    const getPriority = () => typeof priority === 'function' ? priority() : priority;
    const season = dbSeason;
    const episode = dbEpisode;

    // 1. Check Redis Cache
    const cacheKey = this.cacheService.buildCacheKey(activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
    // 1. Check Redis Cache
    const cachedRedis = await this.cacheService.getFromRedis(cacheKey);
    const hasM3U8Redis = cachedRedis?.some(l => l.isM3U8);

    if (cachedRedis && hasM3U8Redis) {
      if (onLinkFound) cachedRedis.forEach(link => onLinkFound(link));
      return { links: cachedRedis, scraperStatuses: [{ name: 'cache:redis', status: 'success', linksFound: cachedRedis.length, durationMs: 0 }] };
    }

    // 2. Check DB
    const cachedDb = await this.cacheService.getFromDatabase(activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
    const hasM3U8Db = cachedDb?.some(l => l.isM3U8);

    if (cachedDb && hasM3U8Db) {
      this.logger.log(`Found ${cachedDb.length} cached links (including M3U8) for ${title} in the database`);
      if (onLinkFound) cachedDb.forEach(link => onLinkFound(link));
      return { links: cachedDb, scraperStatuses: [{ name: 'cache:database', status: 'success', linksFound: cachedDb.length, durationMs: 0 }] };
    }

    if ((cachedRedis && cachedRedis.length > 0) || (cachedDb && cachedDb.length > 0)) {
       this.logger.log(`Found cached links for ${title}, but no M3U8. Proceeding with fresh scrape...`);
    }

    this.logger.log(`Resolving streams for ${title} (${activeMediaType}) - S${dbSeason} E${dbEpisode} [Priority: ${priority}]`);

    const allLinks: StreamLink[] = [];
    const scraperStatuses: ScraperStatus[] = [];
    const activeScrapers = this.scrapers.filter(s =>
      !s.supportedTypes || s.supportedTypes.includes(activeMediaType!)
    );

    // Overall timeout
    let isTimedOut = false;
    const timeoutHandle = setTimeout(() => { isTimedOut = true; }, this.STREAM_TIMEOUT_MS);

    // Speculative completion resolver
    let speculativeResolve: (() => void) | null = null;
    const speculativePromise = new Promise<void>(resolve => { speculativeResolve = resolve; });

    const checkSpeculativeCompletion = () => {
      const m3u8Links = allLinks.filter(l => l.isM3U8);
      
      // Resolve immediately if we found a high-quality link or multiple options
      const hasHighQuality = m3u8Links.some(l => 
          (l.quality || '').toLowerCase().includes('1080') || 
          (l.quality || '').toLowerCase().includes('auto') ||
          l.url.includes('master')
      );

      if (hasHighQuality || m3u8Links.length >= 2) {
        this.logger.debug(`Speculative completion: quality threshold reached, resolving early`);
        speculativeResolve?.();
        return;
      }
    };

    // Pipeline: launch all scrapers in parallel, each scraper searches + extracts + validates as a pipeline
    const scraperPromises = activeScrapers.map(async (scraper) => {
      const scraperStart = Date.now();

      // Circuit breaker check
      if (!this.circuitBreaker.isAvailable(scraper.name)) {
        const health = this.circuitBreaker.getHealth(scraper.name);
        this.logger.debug(`Skipping ${scraper.name}: circuit is ${health.state}`);
        scraperStatuses.push({
          name: scraper.name,
          status: 'circuit_open',
          linksFound: 0,
          durationMs: 0,
          circuitState: health.state,
        });
        return [];
      }

      try {
        if (isTimedOut) {
          scraperStatuses.push({ name: scraper.name, status: 'timeout', linksFound: 0, durationMs: 0 });
          return [];
        }

        let searchResults: ScraperSearchResult[] = [];

        let mappingKey = activeMediaType === 'anime'
          ? `mal:anime:${malId}:${scraper.name}`
          : `tmdb:${activeMediaType}:${tmdbId}:${scraper.name}`;

        if (activeMediaType === 'tv' && season) {
          mappingKey += `:s${season}`;
        }

        // Check for existing mapping
        const mapping = await (this.prisma as any).providerMapping.findUnique({
          where: { mappingKey }
        });

        if (mapping) {
          this.logger.debug(`Using mapped URL for ${scraper.name}: ${mapping.externalUrl}`);
          searchResults = [{ title: title || 'Media', url: mapping.externalUrl }];
        } else {
          const searchQuery = (activeMediaType === 'tv' && season)
            ? `${title} Season ${season}`
            : title;

          this.logger.debug(`Searching for ${scraper.name} using query: "${searchQuery}"`);
          searchResults = await scraper.search(searchQuery, tmdbId, imdbId, malId, getPriority(), activeMediaType);

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
                  update: { externalUrl: bestResult.url, tmdbId: tmdbId || null, malId: malId || null },
                  create: { mappingKey, tmdbId: tmdbId || null, malId: malId || null, provider: scraper.name, externalUrl: bestResult.url }
                });
              } catch (mapError: any) {
                this.logger.warn(`Could not save provider mapping for ${mappingKey}: ${mapError.message}`);
              }
            }
          }
        }

        // Pipeline: start extracting from each search result immediately,
        // validate each link as it arrives (don't wait for all extraction to finish)
        const validLinks: (StreamLink & { provider: string })[] = [];

        await Promise.all(searchResults.map(async (result) => {
          try {
            const streamParams = (activeMediaType === 'anime' || (season && episode))
              ? { season: season || 1, episode: episode || 1, type }
              : undefined;

            let links = await scraper.getStreamLinks(result.url, streamParams, getPriority());

            // 🛡️ RECURSIVE RESOLUTION: If any link is a known mirror, resolve it to M3U8
            const mirrorsScraper = this.scrapers.find(s => s.name === 'MirrorResolver');
            if (mirrorsScraper) {
              const resolvedLinks: StreamLink[] = [];
              for (const link of links) {
                const isMirror = /streamwish|filemoon|voe\.sx|doodstream|mixdrop|upstream|9animetv|gogocdn|embtaku|vidcloud|upcloud|vidsrc|vidlink/i.test(link.url);
                if (isMirror && !link.isM3U8) {
                  this.logger.debug(`Found mirror link, attempting deep resolution: ${link.url}`);
                  const deepLinks = await mirrorsScraper.getStreamLinks(link.url, streamParams, getPriority());
                  if (deepLinks.length > 0) {
                    resolvedLinks.push(...deepLinks);
                  } else {
                    resolvedLinks.push(link); // Keep original if resolution fails
                  }
                } else {
                  resolvedLinks.push(link);
                }
              }
              links = resolvedLinks;
            }

            const taggedLinks = links.map(l => ({
              ...l,
              provider: result.title.includes('(') ? result.title : `${scraper.name} (${new URL(result.url).hostname})`
            }) as (StreamLink & { provider: string }));

            // Validate each link immediately as it comes in (pipelined)
            await Promise.all(taggedLinks.map(async (link) => {
              if (isTimedOut) return;
              try {
                const isValid = await this.validationService.validateStream(link.url, getPriority());
                if (isValid) {
                  await this.cacheService.saveToDatabase(link, activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
                  validLinks.push(link);
                  allLinks.push(link);
                  this.logger.log(`Valid link found (${link.isM3U8 ? 'HLS' : 'Direct'}): ${link.url.substring(0, 100)}...`);
                  if (onLinkFound) onLinkFound(link);
                  checkSpeculativeCompletion();
                } else {
                  this.logger.warn(`REJECTED by validation: ${link.url.substring(0, 100)}...`);
                }
              } catch (valError: any) {
                this.logger.error(`Validation crashed for ${link.url}: ${valError.message}`);
              }
            }));
          } catch (e: any) {
            this.logger.warn(`${scraper.name} mirror ${result.url} failed: ${e.message}`);
          }
        }));

        if (validLinks.length > 0) {
          this.cacheService.saveToRedis(cacheKey, allLinks);
        }

        const duration = Date.now() - scraperStart;

        // Record circuit breaker metrics
        if (validLinks.length > 0) {
          this.circuitBreaker.recordSuccess(scraper.name, duration);
        } else {
          // no_results is still a "working" scraper, only record failure for actual errors
          this.circuitBreaker.recordSuccess(scraper.name, duration);
        }

        scraperStatuses.push({
          name: scraper.name,
          status: validLinks.length > 0 ? 'success' : 'no_results',
          linksFound: validLinks.length,
          durationMs: duration,
          circuitState: this.circuitBreaker.getHealth(scraper.name).state,
        });

        return validLinks;
      } catch (e: any) {
        const duration = Date.now() - scraperStart;
        this.logger.error(`${scraper.name} CRITICAL FAILURE: ${e.message}`);
        this.circuitBreaker.recordFailure(scraper.name, duration, e.message);

        scraperStatuses.push({
          name: scraper.name,
          status: 'failed',
          linksFound: 0,
          durationMs: duration,
          error: e.message,
          circuitState: this.circuitBreaker.getHealth(scraper.name).state,
        });
        return [];
      }
    });

    // Race between: all scrapers finishing, speculative completion, or timeout
    const startTime = Date.now();

    await Promise.race([
      Promise.all(scraperPromises),
      speculativePromise,
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          // Fallback: 3s elapsed with at least 1 M3U8
          const m3u8Count = allLinks.filter(l => l.isM3U8).length;
          if (Date.now() - startTime > 3000 && m3u8Count >= 1) {
            this.logger.debug(`Time-based speculative completion: ${m3u8Count} M3U8 after 3s`);
            clearInterval(interval);
            resolve();
          }
          if (isTimedOut) {
            this.logger.debug(`Overall timeout reached (${this.STREAM_TIMEOUT_MS}ms)`);
            clearInterval(interval);
            resolve();
          }
        }, 500);
      })
    ]);

    clearTimeout(timeoutHandle);

    return { links: allLinks, scraperStatuses };
  }

  async prefetchLinks(
    items: { id: string, mediaType: 'movie' | 'tv' | 'anime', title?: string }[],
    onLinkFound?: (id: string, link: StreamLink) => void
  ) {
    this.logger.log(`Queueing prefetch for ${items.length} items`);

    const queue = [...items];

    const processQueue = async () => {
      while (queue.length > 0) {
        if (this.globalPrefetchCount >= this.MAX_GLOBAL_PREFETCH) {
          this.logger.debug(`[Prefetch Guard] Global limit reached (${this.globalPrefetchCount}/${this.MAX_GLOBAL_PREFETCH}). Waiting...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        const item = queue.shift();
        if (!item) break;

        const dbSeason = item.mediaType === 'tv' ? 1 : null;
        const dbEpisode = item.mediaType === 'tv' ? 1 : (item.mediaType === 'anime' ? 1 : null);
        const prefetchKey = `${item.mediaType}:${item.id}:s${dbSeason}:e${dbEpisode}`;

        if (this.activePrefetches.has(prefetchKey)) {
          this.logger.debug(`[Prefetch Guard] Skip: ${prefetchKey} already in progress`);
          continue;
        }

        try {
          this.activePrefetches.add(prefetchKey);
          this.globalPrefetchCount++;
          this.logger.debug(`Proactively resolving streams for ${item.id} (${item.mediaType}) [Global Count: ${this.globalPrefetchCount}]`);
          await this.findStreamLinks(
            item.id,
            dbSeason || undefined,
            dbEpisode || undefined,
            'sub',
            item.mediaType,
            onLinkFound ? (link) => onLinkFound(item.id, link) : undefined,
            1
          );
        } catch (err: any) {
          this.logger.debug(`Background prefetch failed for ${item.id}: ${err.message}`);
        } finally {
          this.activePrefetches.delete(prefetchKey);
          this.globalPrefetchCount--;
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };

    // Only start as many loops as we have items, capped at a reasonable local concurrency
    const localConcurrent = Math.min(3, items.length);
    for (let i = 0; i < localConcurrent; i++) {
      processQueue();
    }
  }
}
