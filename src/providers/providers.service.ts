import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, StreamLink, ScraperSearchResult, SCRAPER_TOKEN } from './scraper.interface';
import { TmdbService } from '../tmdb/tmdb.service';
import { MALService } from '../mal/mal.service';
import { PrismaService } from '../prisma/prisma.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

export interface ScraperStatus {
  name: string;
  status: 'success' | 'failed' | 'timeout' | 'no_results';
  linksFound: number;
  durationMs: number;
  error?: string;
}

export interface StreamResult {
  links: StreamLink[];
  scraperStatuses: ScraperStatus[];
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  private readonly STREAM_TIMEOUT_MS: number;

  private readonly inFlightRequests = new Map<string, Promise<StreamResult>>();
  private readonly activePrefetches = new Set<string>();

  constructor(
    @Inject(SCRAPER_TOKEN) private scrapers: Scraper[],
    private tmdbService: TmdbService,
    private malService: MALService,
    private prisma: PrismaService,
    private validationService: StreamValidationService,
    private cacheService: StreamCacheService,
    private configService: ConfigService,
  ) {
    this.scrapers = Array.isArray(this.scrapers) ? this.scrapers : (this.scrapers ? [this.scrapers] : []);
    this.scrapers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.logger.log(`Registered ${this.scrapers.length} scrapers: ${this.scrapers.map(s => s.name).join(', ')}`);

    this.STREAM_TIMEOUT_MS = this.configService.get<number>('STREAM_TIMEOUT_MS', 30000);

    axios.defaults.httpAgent = httpAgent;
    axios.defaults.httpsAgent = httpsAgent;
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
    if (this.inFlightRequests.has(requestKey)) {
      this.logger.debug(`[Deduplication] Joining in-flight request for ${requestKey}`);
      const inFlight = await this.inFlightRequests.get(requestKey)!;
      if (onLinkFound) {
        inFlight.links.forEach(link => onLinkFound(link));
      }
      return inFlight;
    }

    const fetchPromise = (async () => {
      try {
        return await this.performFindStreamLinks(
          id, numericId, title, tmdbId, malId, imdbId, activeMediaType,
          dbSeason, dbEpisode, type, onLinkFound, priority
        );
      } finally {
        this.inFlightRequests.delete(requestKey);
      }
    })();

    this.inFlightRequests.set(requestKey, fetchPromise);
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
    priority: number = 0
  ): Promise<StreamResult> {
    const season = dbSeason;
    const episode = dbEpisode;

    // 1. Check Redis Cache
    const cacheKey = this.cacheService.buildCacheKey(activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
    const cachedRedis = await this.cacheService.getFromRedis(cacheKey);
    if (cachedRedis) {
      if (onLinkFound) cachedRedis.forEach(link => onLinkFound(link));
      return { links: cachedRedis, scraperStatuses: [{ name: 'cache:redis', status: 'success', linksFound: cachedRedis.length, durationMs: 0 }] };
    }

    // 2. Check DB
    const cachedDb = await this.cacheService.getFromDatabase(activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
    if (cachedDb) {
      this.logger.log(`Found ${cachedDb.length} cached links for ${title} in the database`);
      if (onLinkFound) cachedDb.forEach(link => onLinkFound(link));
      return { links: cachedDb, scraperStatuses: [{ name: 'cache:database', status: 'success', linksFound: cachedDb.length, durationMs: 0 }] };
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

    const scraperPromises = activeScrapers.map(async (scraper) => {
      const scraperStart = Date.now();
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
          searchResults = await scraper.search(searchQuery, tmdbId, imdbId, malId, priority, activeMediaType);

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
          } catch (e: any) {
            this.logger.warn(`${scraper.name} mirror ${result.url} failed: ${e.message}`);
            return [];
          }
        });

        const nestedResults = await Promise.all(scraperLinksPromises);
        const flatLinks = nestedResults.flat();

        // Validate streams
        const validationResults = await Promise.all(
          flatLinks.map(async (link) => {
            if (isTimedOut) return null;
            try {
              const isValid = await this.validationService.validateStream(link.url, priority);
              if (isValid) {
                await this.cacheService.saveToDatabase(link, activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);
                if (onLinkFound) onLinkFound(link);
                return link;
              }
            } catch (valError: any) {
              this.logger.warn(`Validation crashed for ${link.url}: ${valError.message}`);
            }
            return null;
          })
        );

        const validLinks = validationResults.filter((l): l is StreamLink & { provider: string } => l !== null);
        allLinks.push(...validLinks);

        if (validLinks.length > 0) {
          this.cacheService.saveToRedis(cacheKey, allLinks);
        }

        const duration = Date.now() - scraperStart;
        scraperStatuses.push({
          name: scraper.name,
          status: validLinks.length > 0 ? 'success' : 'no_results',
          linksFound: validLinks.length,
          durationMs: duration,
        });

        return validLinks;
      } catch (e: any) {
        const duration = Date.now() - scraperStart;
        this.logger.error(`${scraper.name} CRITICAL FAILURE: ${e.message}`);
        scraperStatuses.push({
          name: scraper.name,
          status: 'failed',
          linksFound: 0,
          durationMs: duration,
          error: e.message,
        });
        return [];
      }
    });

    // Speculative completion with overall timeout
    const startTime = Date.now();

    await Promise.race([
      Promise.all(scraperPromises),
      new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          const m3u8Count = allLinks.filter(l => l.isM3U8).length;
          if (m3u8Count >= 3 || (Date.now() - startTime > 15000 && m3u8Count >= 1)) {
            this.logger.debug(`Speculative completion triggered with ${allLinks.length} links (${m3u8Count} M3U8)`);
            clearInterval(interval);
            resolve();
          }
          if (isTimedOut) {
            this.logger.debug(`Overall timeout reached (${this.STREAM_TIMEOUT_MS}ms)`);
            clearInterval(interval);
            resolve();
          }
        }, 1000);
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
    const concurrentLimit = 3;

    const processQueue = async () => {
      while (queue.length > 0) {
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
          this.logger.debug(`Proactively resolving streams for ${item.id} (${item.mediaType})`);
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
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    };

    for (let i = 0; i < Math.min(concurrentLimit, items.length); i++) {
      processQueue();
    }
  }
}
