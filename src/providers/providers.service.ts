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
import { PuppeteerService } from '../puppeteer/puppeteer.service';

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

/** True for a playable media file (as opposed to an embed/iframe page). */
export function isDirectMediaUrl(url: string): boolean {
  return /\.(mp4|m4v|webm|mkv|mov|m3u8|m3u)(\?|#|$)/i.test(url || '');
}

/**
 * Decide whether a stream needs to be proxied through our backend.
 *
 * Proxy IS needed when:
 *  - Source is known to inject ads into the manifest (SCTE-35, VAST, etc.)
 *  - Source requires a Referer header that the browser can't set directly
 *  - CDN doesn't return CORS headers
 *
 * Otherwise, the browser can hit the CDN directly → saves the double-hop
 * (~100-500ms per segment) on every `.ts` fetch.
 */
function determineNeedsProxy(link: StreamLink): boolean {
  // Applies to any direct media, not just HLS. This used to early-return false for
  // everything non-M3U8, which made the checks below unreachable for direct .mp4
  // links — including vodvidl, which is in the force-proxy list precisely because it
  // demands a Referer the browser can't send. Embed pages are still never proxied;
  // they're loaded in an iframe.
  if (!isDirectMediaUrl(link.url)) return false;

  // If the scraper set custom headers beyond User-Agent, the browser can't
  // forward them on cross-origin fetches — we must proxy.
  if (link.headers) {
    const keys = Object.keys(link.headers).map(k => k.toLowerCase());
    const needsForwardedHeaders = keys.some(k =>
      k === 'referer' || k === 'origin' || k === 'cookie' || k === 'authorization',
    );
    if (needsForwardedHeaders) return true;
  }

  const urlLower = link.url.toLowerCase();

  // Sources known to inject server-side ads or block CORS on direct fetch
  const knownAdInjectors = [
    'ssaimanifest', 'dai.google', 'stitcher', 'mediatailor',
    'vodvidl', 'videostr', 'proxy/file', 'headers=',
  ];
  if (knownAdInjectors.some(p => urlLower.includes(p))) return true;

  // Default: direct playback (fast path)
  return false;
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name);
  private readonly STREAM_TIMEOUT_MS: number;

  private readonly inFlightRequests = new Map<string, { promise: Promise<StreamResult>, priority: number }>();
  private readonly activePrefetches = new Set<string>();
  private globalPrefetchCount = 0;
  private readonly MAX_GLOBAL_PREFETCH = 3; // Total background tasks allowed across all requests
  private activeUserRequests = 0;

  constructor(
    @Inject(SCRAPER_TOKEN) private scrapers: Scraper[],
    private tmdbService: TmdbService,
    private malService: MALService,
    private prisma: PrismaService,
    private validationService: StreamValidationService,
    private cacheService: StreamCacheService,
    private circuitBreaker: CircuitBreakerService,
    private configService: ConfigService,
    private puppeteerService: PuppeteerService,
  ) {
    this.scrapers = Array.isArray(this.scrapers) ? this.scrapers : (this.scrapers ? [this.scrapers] : []);
    this.scrapers.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    this.logger.log(`Registered ${this.scrapers.length} scrapers: ${this.scrapers.map(s => s.name).join(', ')}`);

    this.STREAM_TIMEOUT_MS = this.configService.get<number>('STREAM_TIMEOUT_MS', 15000);

    axios.defaults.httpAgent = httpAgent;
    axios.defaults.httpsAgent = httpsAgent;
  }

  getScrapers(): Scraper[] {
    return this.scrapers;
  }

  getScraperHealth() {
    return this.circuitBreaker.getAllHealth();
  }

  /**
   * Probe each cached link in parallel and emit only the ones that actually respond.
   * Non-M3U8 (iframe) links pass through optimistically — we can't HEAD-check playback
   * inside a sandboxed iframe, so we let the frontend's manual fallback handle those.
   *
   * Dead M3U8 links are dropped silently and fire-and-forget purged from the DB so the
   * next request re-scrapes instead of serving the same dead URL.
   */
  private async emitProbedLinks(
    links: StreamLink[],
    onLinkFound?: (link: StreamLink) => void,
  ): Promise<StreamLink[]> {
    const live: StreamLink[] = [];

    await Promise.all(
      links.map(async (link) => {
        link.needsProxy = determineNeedsProxy(link);

        if (!link.isM3U8) {
          // Iframe / non-HLS: pass through. Frontend's manual switch covers failures.
          live.push(link);
          onLinkFound?.(link);
          return;
        }

        const ok = await this.validationService.validateStream(link.url, link.headers);
        if (ok) {
          live.push(link);
          onLinkFound?.(link);
        } else {
          this.logger.warn(`Dead cached M3U8 dropped: ${link.url.substring(0, 100)}`);
          (this.prisma as any).streamedLink
            .deleteMany({ where: { url: link.url } })
            .catch((e: any) => this.logger.debug(`Failed to purge dead link: ${e.message}`));
        }
      }),
    );

    return live;
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

    const dbSeason = (activeMediaType === 'tv' || activeMediaType === 'anime') ? (season || 1) : null;
    const dbEpisode = (activeMediaType === 'tv' || activeMediaType === 'anime') ? (episode || 1) : null;

    const requestKey = `${activeMediaType}:${numericId}:s${dbSeason}:e${dbEpisode}:${type}`;

    // 🛡️ [OPTIMIZATION] Cache-First Resolution
    // We check the cache immediately using the numeric ID before any metadata fetch.
    const cacheKey = this.cacheService.buildCacheKey(
      activeMediaType!,
      activeMediaType !== 'anime' ? numericId : undefined,
      activeMediaType === 'anime' ? numericId : undefined,
      dbSeason,
      dbEpisode,
      type
    );

    // Parallelize Redis + DB cache checks — they're both independent reads
    const [cachedRedis, cachedDb] = await Promise.all([
      this.cacheService.getFromRedis(cacheKey),
      this.cacheService.getFromDatabase(
        activeMediaType!,
        activeMediaType !== 'anime' ? numericId : undefined,
        activeMediaType === 'anime' ? numericId : undefined,
        dbSeason,
        dbEpisode,
        type,
      ),
    ]);

    if (cachedRedis && cachedRedis.length > 0) {
      const hasQualityLink = cachedRedis.some(l => l.isM3U8);
      if (hasQualityLink) {
        this.logger.log(`[Cache Hit: Redis] Validating cached streams for ${requestKey}`);
        const live = await this.emitProbedLinks(cachedRedis, onLinkFound);
        if (live.length > 0) {
          return { links: live, scraperStatuses: [{ name: 'cache:redis', status: 'success', linksFound: live.length, durationMs: 0 }] };
        }
        this.logger.warn(`[Cache Hit: Redis] All cached links dead for ${requestKey} — re-scraping`);
      }
    }

    if (cachedDb && cachedDb.length > 0) {
      const hasQualityLink = cachedDb.some(l => l.isM3U8);
      if (hasQualityLink) {
        this.logger.log(`[Cache Hit: DB] Validating cached streams for ${requestKey}`);
        const live = await this.emitProbedLinks(cachedDb, onLinkFound);
        if (live.length > 0) {
          return { links: live, scraperStatuses: [{ name: 'cache:database', status: 'success', linksFound: live.length, durationMs: 0 }] };
        }
        this.logger.warn(`[Cache Hit: DB] All cached links dead for ${requestKey} — re-scraping`);
      }
    }

    // Deduplication: join in-flight request
    const inFlight = this.inFlightRequests.get(requestKey);
    if (inFlight) {
      if (priority < inFlight.priority) {
        this.logger.debug(`[Priority Boost] Upgrading ${requestKey} from ${inFlight.priority} to ${priority}`);
        inFlight.priority = priority;
        if (priority <= 0) {
          this.puppeteerService.abortTasksWithPriority(1);
        }
      }
      this.logger.debug(`[Deduplication] Joining in-flight request for ${requestKey}`);
      const result = await inFlight.promise;
      if (onLinkFound) {
        result.links.forEach((link: any) => onLinkFound(link));
      }
      return result;
    }

    const fetchPromise = (async () => {
      const isUserRequest = priority <= 0;
      if (isUserRequest) {
        this.activeUserRequests++;
        this.logger.debug(`[Priority System] User request started. Active user requests: ${this.activeUserRequests}. Aborting background prefetches.`);
        this.puppeteerService.abortTasksWithPriority(1);
      }

      try {
        const metadataPromise = (async () => {
          let title = '';
          let tmdbId: number | undefined;
          let malId: number | undefined;
          let imdbId: string | undefined;
          let tmdbMappingPromise: Promise<void> | undefined;

          if (activeMediaType === 'anime') {
            malId = numericId;
            const animeResponse = await this.malService.getDetails(malId);
            const details = (animeResponse as any).data;
            title = details?.title || '';
            
            // Start TMDB mapping in parallel if needed
            tmdbMappingPromise = this.tmdbService.search(title, 'tv')
              .then(searchRes => {
                if (searchRes.results && searchRes.results.length > 0) {
                  tmdbId = searchRes.results[0].id;
                }
              })
              .catch(() => {});
          } else {
            tmdbId = numericId;
            const details = await this.tmdbService.getDetails(tmdbId, activeMediaType as 'movie' | 'tv');
            title = activeMediaType === 'movie' ? details?.title : details?.name;
            imdbId = details?.external_ids?.imdb_id || details?.imdb_id;
          }
          return { title, tmdbId, malId, imdbId, tmdbMappingPromise };
        })();

        const getCurrentPriority = () => this.inFlightRequests.get(requestKey)?.priority ?? priority;

        return await this.performFindStreamLinks(
          id, numericId, metadataPromise, activeMediaType,
          dbSeason, dbEpisode, type, onLinkFound, getCurrentPriority
        );
      } catch (e: any) {
        this.logger.error(`Failed to resolve streams for ${id} (${activeMediaType}): ${e.message}`);
        return { links: [], scraperStatuses: [] };
      } finally {
        this.inFlightRequests.delete(requestKey);
        if (isUserRequest) {
          this.activeUserRequests--;
          this.logger.debug(`[Priority System] User request finished. Active user requests: ${this.activeUserRequests}.`);
        }
      }
    })();

    this.inFlightRequests.set(requestKey, { promise: fetchPromise, priority });
    return fetchPromise;
  }

  private async performFindStreamLinks(
    id: string,
    numericId: number,
    metadataPromise: Promise<{ title: string, tmdbId?: number, malId?: number, imdbId?: string, tmdbMappingPromise?: Promise<void> }>,
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
    
    // We start with IDs from the request if available to avoid blocking on metadata
    let tmdbId = activeMediaType !== 'anime' ? numericId : undefined;
    let malId = activeMediaType === 'anime' ? numericId : undefined;
    let imdbId: string | undefined;
    let title = '';
    let tmdbMappingPromise: Promise<void> | undefined;

    // Start metadata resolution in background
    metadataPromise.then(meta => {
      title = meta.title;
      if (meta.tmdbId) tmdbId = meta.tmdbId;
      if (meta.malId) malId = meta.malId;
      imdbId = meta.imdbId;
      tmdbMappingPromise = meta.tmdbMappingPromise;
      this.logger.debug(`Metadata resolved: ${title} (TMDB: ${tmdbId}, MAL: ${malId})`);
    }).catch(e => this.logger.warn(`Metadata fetch failed: ${e.message}`));

    const cacheKey = this.cacheService.buildCacheKey(activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, type);

    this.logger.log(`Resolving streams for ID ${numericId} (${activeMediaType}) - S${dbSeason} E${dbEpisode} [Priority: ${getPriority()}]`);

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

      const hasPremiumIframe = allLinks.some(l => 
        (activeMediaType === 'movie' || activeMediaType === 'tv') && 
        (/vidsrc|vidlink/i.test(l.url) || /vidsrc|vidlink/i.test(l.provider || ''))
      );

      // Instantly resolve if we have any good direct link, a premium iframe, or multiple fallback iframes
      if (hasHighQuality || 
          m3u8Links.length >= 1 || 
          hasPremiumIframe ||
          allLinks.length >= 2) {
        this.logger.debug(`Speculative completion: threshold reached (${m3u8Links.length} M3U8, premium=${hasPremiumIframe}, ${allLinks.length} total), resolving early`);
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
          // Wait for title if not yet available (needed for search)
          if (!title) {
            const meta = await metadataPromise;
            title = meta.title;
            if (meta.tmdbId) tmdbId = meta.tmdbId;
            if (meta.malId) malId = meta.malId;
            imdbId = meta.imdbId;
            tmdbMappingPromise = meta.tmdbMappingPromise;
          }

          const searchQuery = (activeMediaType === 'tv' && season)
            ? `${title} Season ${season}`
            : title;

          this.logger.debug(`Searching for ${scraper.name} using query: "${searchQuery}"`);
          
          // If this scraper needs TMDB ID and it's not yet available, wait for the mapping promise.
          if (!tmdbId && tmdbMappingPromise && scraper.name === 'VidSrc') {
            await tmdbMappingPromise;
          }

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

            const links = await scraper.getStreamLinks(result.url, streamParams, getPriority());

            // 🛡️ RECURSIVE RESOLUTION + VALIDATION PIPELINE
            // Instead of waiting for ALL mirrors to resolve, we process each link independently.
            // This allows speculative completion to trigger as soon as the first mirror finishes.
            const mirrorsScraper = this.scrapers.find(s => s.name === 'MirrorResolver');

            await Promise.all(links.map(async (initialLink) => {
              if (isTimedOut) return;

              const isMirror = /streamwish|filemoon|voe\.sx|doodstream|mixdrop|upstream|9animetv|gogocdn|embtaku|vidcloud|upcloud|vidsrc|vidlink|vodvidl/i.test(initialLink.url);
              let resolvedLinks: (StreamLink & { provider: string })[] = [];

              if (isMirror && !initialLink.isM3U8 && mirrorsScraper) {
                this.logger.debug(`Deep-resolving mirror: ${initialLink.url}`);
                const deepLinks = await mirrorsScraper.getStreamLinks(initialLink.url, streamParams, getPriority());
                const targetLinks = deepLinks.length > 0 ? deepLinks : [initialLink];
                resolvedLinks = targetLinks.map(l => ({
                  ...l,
                  provider: result.title.includes('(') ? result.title : `${scraper.name} (${new URL(result.url).hostname})`
                }));
              } else {
                resolvedLinks = [{
                  ...initialLink,
                  provider: result.title.includes('(') ? result.title : `${scraper.name} (${new URL(result.url).hostname})`
                }];
              }

              // OPTIMISTIC PIPELINE: emit links immediately, validate in background.
              // The frontend tries playback; if it fails, it fails over to next provider.
              // This saves the HEAD+GET round-trip latency per link before first emit.
              for (const link of resolvedLinks) {
                if (isTimedOut) break;
                // Tag whether the browser needs to route this through the backend proxy
                link.needsProxy = determineNeedsProxy(link);

                validLinks.push(link);
                allLinks.push(link);
                this.logger.log(`Link emitted (${link.isM3U8 ? 'HLS' : 'Direct'}, proxy=${link.needsProxy}): ${link.url.substring(0, 100)}...`);
                if (onLinkFound) onLinkFound(link);
                checkSpeculativeCompletion();

                // Background: validate & persist. If validation fails, remove from cache.
                (async () => {
                  try {
                    // 🛡️ TRUSTED PROVIDER BYPASS: Iframes from major providers are trusted
                    const isTrustedIframe = !link.isM3U8 && 
                      /vidsrc|vidlink|9animetv|gogocdn|embtaku|vidcloud|upcloud|animepahe/i.test(link.url);

                    let isValid = true;
                    if (!isTrustedIframe) {
                      isValid = await this.validationService.validateStream(link.url, link.headers, getPriority());
                    }

                    if (isValid) {
                      // Persist under the LINK's own sub/dub tag (e.g. GogoAnime returns
                      // both), not the request type — otherwise a dub link gets stored as
                      // sub and served to the wrong audience / misses the dub cache.
                      const linkType = (link as any).type || type;
                      await this.cacheService.saveToDatabase(link, activeMediaType!, tmdbId, malId, dbSeason, dbEpisode, linkType);
                    } else {
                      this.logger.warn(`Background validation rejected: ${link.url.substring(0, 100)}...`);
                      // Remove from in-memory list so the Redis cache reflects only valid links
                      const idx = allLinks.findIndex(l => l.url === link.url);
                      if (idx >= 0) {
                        allLinks.splice(idx, 1);
                        // Re-write the Redis snapshot so the dead link isn't served for
                        // the next 24h (validation completes after the initial saveToRedis).
                        if (allLinks.length > 0) {
                          this.cacheService.saveToRedis(cacheKey, allLinks).catch(() => {});
                        }
                      }
                    }
                  } catch (valError: any) {
                    this.logger.error(`Validation crashed for ${link.url}: ${valError.message}`);
                  }
                })();
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

    // Held outside the Promise so it can be cleared once the race settles. Previously,
    // if Promise.all won the race with zero links, isTimedOut never flipped (the overall
    // timeout is cleared just below) and this interval ticked every 500ms forever.
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    await Promise.race([
      Promise.all(scraperPromises),
      speculativePromise,
      new Promise<void>((resolve) => {
        fallbackInterval = setInterval(() => {
          // Fallback: 3s elapsed with AT LEAST 1 link of any kind
          if (Date.now() - startTime > 3000 && allLinks.length >= 1) {
            this.logger.debug(`Time-based speculative completion: ${allLinks.length} total links after 3s`);
            resolve();
          }
          if (isTimedOut) {
            this.logger.debug(`Overall timeout reached (${this.STREAM_TIMEOUT_MS}ms)`);
            resolve();
          }
        }, 500);
      })
    ]);

    if (fallbackInterval) clearInterval(fallbackInterval);
    clearTimeout(timeoutHandle);

    return { links: allLinks, scraperStatuses };
  }

  async prefetchLinks(
    items: { id: string, mediaType: 'movie' | 'tv' | 'anime', title?: string }[],
    onLinkFound?: (id: string, link: StreamLink, mediaType: 'movie' | 'tv' | 'anime') => void,
  ) {
    this.logger.log(`Queueing prefetch for ${items.length} items`);

    const queue = [...items];

    const processQueue = async () => {
      while (queue.length > 0) {
        if (this.activeUserRequests > 0) {
          this.logger.debug(`[Prefetch Guard] Pausing prefetch because user requests (${this.activeUserRequests}) are active.`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        if (this.globalPrefetchCount >= this.MAX_GLOBAL_PREFETCH) {
          this.logger.debug(`[Prefetch Guard] Global limit reached (${this.globalPrefetchCount}/${this.MAX_GLOBAL_PREFETCH}). Waiting...`);
          await new Promise(resolve => setTimeout(resolve, 5000));
          continue;
        }

        const item = queue.shift();
        if (!item) break;

        const dbSeason = (item.mediaType === 'tv' || item.mediaType === 'anime') ? 1 : null;
        const dbEpisode = (item.mediaType === 'tv' || item.mediaType === 'anime') ? 1 : null;
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
            onLinkFound ? (link) => onLinkFound(item.id, link, item.mediaType) : undefined,
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

    // Process prefetch queue serially — user requests always get priority via reserved Puppeteer slots.
    // Await it so callers (e.g. the WS gateway) only emit `prefetch-complete` once the
    // queue has actually drained, instead of immediately.
    await processQueue();
  }
}
