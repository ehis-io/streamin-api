import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TmdbService } from '../tmdb/tmdb.service';
import { ProvidersService } from './providers.service';

@Injectable()
export class CacheWarmingService {
  private readonly logger = new Logger(CacheWarmingService.name);
  private isRunning = false;

  constructor(
    private tmdbService: TmdbService,
    private providersService: ProvidersService,
  ) {}

  /** Run every 6 hours — pre-scrape trending movies and TV shows */
  @Cron(CronExpression.EVERY_6_HOURS)
  async warmTrendingCache() {
    if (this.isRunning) {
      this.logger.debug('Cache warming already in progress, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting cache warming for trending content...');

    try {
      const [trendingMovies, trendingTv] = await Promise.all([
        this.tmdbService.getTrending('movie', 1).catch(() => ({ results: [] })),
        this.tmdbService.getTrending('tv', 1).catch(() => ({ results: [] })),
      ]);

      const movieItems = (trendingMovies.results || []).slice(0, 10).map((m: any) => ({
        id: String(m.id),
        mediaType: 'movie' as const,
        title: m.title,
      }));

      const tvItems = (trendingTv.results || []).slice(0, 10).map((t: any) => ({
        id: String(t.id),
        mediaType: 'tv' as const,
        title: t.name,
      }));

      const items = [...movieItems, ...tvItems];
      this.logger.log(`Warming cache for ${items.length} trending items`);

      await this.providersService.prefetchLinks(items);
    } catch (error: any) {
      this.logger.error(`Cache warming failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
