import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import { VidSrcScraper } from './scrapers/vidsrc.scraper';
import { VidLinkScraper } from './scrapers/vidlink.scraper';
import { GogoAnimeScraper } from './scrapers/gogoanime.scraper';
import { TmdbModule } from '../tmdb/tmdb.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SCRAPER_TOKEN } from './scraper.interface';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CacheWarmingService } from './cache-warming.service';
import { StreamFreshnessService } from './stream-freshness.service';

@Module({
  imports: [TmdbModule, PrismaModule],
  providers: [
    ProvidersService,
    StreamValidationService,
    StreamCacheService,
    CircuitBreakerService,
    CacheWarmingService,
    StreamFreshnessService,
    VidSrcScraper,
    VidLinkScraper,
    GogoAnimeScraper,
    {
      provide: SCRAPER_TOKEN,
      useFactory: (vidsrc: VidSrcScraper, vidlink: VidLinkScraper, gogo: GogoAnimeScraper) =>
        [vidsrc, vidlink, gogo],
      inject: [VidSrcScraper, VidLinkScraper, GogoAnimeScraper],
    },
  ],
  exports: [ProvidersService],
})
export class ProvidersModule { }
