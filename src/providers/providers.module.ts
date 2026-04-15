import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import { VidSrcScraper } from './scrapers/vidsrc.scraper';
import { VidLinkScraper } from './scrapers/vidlink.scraper';
import { GogoAnimeScraper } from './scrapers/gogoanime.scraper';
import { AnimePaheScraper } from './scrapers/animepahe.scraper';
// import { HnEmbedScraper } from './scrapers/hnembed.scraper';
import { MirrorsScraper } from './scrapers/mirrors.scraper';
import { TmdbModule } from '../tmdb/tmdb.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SCRAPER_TOKEN } from './scraper.interface';
import { CircuitBreakerService } from './circuit-breaker.service';
import { CacheWarmingService } from './cache-warming.service';
import { StreamFreshnessService } from './stream-freshness.service';
import { IframeResolverService } from './iframe-resolver.service';

@Module({
  imports: [TmdbModule, PrismaModule],
  providers: [
    ProvidersService,
    StreamValidationService,
    StreamCacheService,
    CircuitBreakerService,
    CacheWarmingService,
    StreamFreshnessService,
    IframeResolverService,
    VidSrcScraper,
    VidLinkScraper,
    GogoAnimeScraper,
    AnimePaheScraper,
    // HnEmbedScraper disabled per user request
    MirrorsScraper,
    {
      provide: SCRAPER_TOKEN,
      useFactory: (vidsrc: VidSrcScraper, vidlink: VidLinkScraper, gogo: GogoAnimeScraper, animepahe: AnimePaheScraper, mirrors: MirrorsScraper) =>
        [vidsrc, vidlink, gogo, animepahe, mirrors],
      inject: [VidSrcScraper, VidLinkScraper, GogoAnimeScraper, AnimePaheScraper, MirrorsScraper],
    },
  ],
  exports: [ProvidersService],
})
export class ProvidersModule { }
