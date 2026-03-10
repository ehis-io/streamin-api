import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import { StreamLink } from './scraper.interface';

@Injectable()
export class StreamCacheService {
  private readonly logger = new Logger(StreamCacheService.name);

  private readonly REDIS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private readonly VOLATILE_TTL_DAYS = 7; // M3U8 direct streams
  private readonly STABLE_TTL_DAYS = 365; // Embed URLs

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private prisma: PrismaService,
  ) {}

  buildCacheKey(
    activeMediaType: string,
    tmdbId?: number,
    malId?: number,
    dbSeason?: number | null,
    dbEpisode?: number | null,
    type?: string,
  ): string {
    return `streams:${activeMediaType}:${activeMediaType === 'anime' ? malId : tmdbId}:s${dbSeason}:e${dbEpisode}:${type}`;
  }

  async getFromRedis(cacheKey: string): Promise<StreamLink[] | null> {
    try {
      const cachedLinks = await this.cacheManager.get<StreamLink[]>(cacheKey);
      if (cachedLinks && cachedLinks.length > 0) {
        this.logger.debug(`[Redis] Cache hit for ${cacheKey}`);
        return cachedLinks;
      }
    } catch (cacheError: any) {
      this.logger.warn(`Redis cache check failed: ${cacheError.message}`);
    }
    return null;
  }

  async getFromDatabase(
    activeMediaType: string,
    tmdbId?: number,
    malId?: number,
    dbSeason?: number | null,
    dbEpisode?: number | null,
    type?: string,
  ): Promise<(StreamLink & { provider: string })[] | null> {
    const volatileThreshold = new Date(Date.now() - this.VOLATILE_TTL_DAYS * 24 * 60 * 60 * 1000);
    const stableThreshold = new Date(Date.now() - this.STABLE_TTL_DAYS * 24 * 60 * 60 * 1000);

    try {
      const existingLinks = await (this.prisma as any).streamedLink.findMany({
        where: {
          ...(activeMediaType === 'anime' ? { malId } : { tmdbId }),
          season: dbSeason,
          episode: dbEpisode,
          type,
          OR: [
            { isM3U8: true, createdAt: { gte: volatileThreshold } },
            { isM3U8: false, createdAt: { gte: stableThreshold } }
          ]
        },
      });

      if (existingLinks && existingLinks.length > 0) {
        return existingLinks.map((link: any) => ({
          url: link.url,
          quality: link.quality as any,
          isM3U8: link.isM3U8,
          headers: link.headers ? JSON.parse(link.headers) : undefined,
          provider: link.provider,
        }));
      }
    } catch (dbError: any) {
      this.logger.warn(`Error checking database for existing links: ${dbError.message}`);
    }
    return null;
  }

  async saveToRedis(cacheKey: string, links: StreamLink[]): Promise<void> {
    try {
      await this.cacheManager.set(cacheKey, links, this.REDIS_TTL_MS);
    } catch (e: any) {
      this.logger.warn(`Failed to save to Redis: ${e.message}`);
    }
  }

  async saveToDatabase(
    link: StreamLink & { provider: string },
    activeMediaType: string,
    tmdbId?: number,
    malId?: number,
    dbSeason?: number | null,
    dbEpisode?: number | null,
    type?: string,
  ): Promise<void> {
    try {
      await (this.prisma as any).streamedLink.create({
        data: {
          tmdbId: activeMediaType === 'anime' ? null : tmdbId,
          malId: activeMediaType === 'anime' ? malId : null,
          season: dbSeason,
          episode: dbEpisode,
          url: link.url,
          quality: link.quality || 'auto',
          isM3U8: link.isM3U8 || false,
          provider: link.provider,
          headers: link.headers ? JSON.stringify(link.headers) : null,
          type: type,
        }
      });
    } catch (saveError: any) {
      this.logger.warn(`Failed to save stream link to DB: ${saveError.message}`);
    }
  }
}
