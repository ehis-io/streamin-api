import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { StreamValidationService } from './stream-validation.service';
import { StreamCacheService } from './stream-cache.service';
import { VidSrcScraper } from './scrapers/vidsrc.scraper';
import { VidLinkScraper } from './scrapers/vidlink.scraper';
import { VidFastScraper } from './scrapers/vidfast.scraper';
import { GogoAnimeScraper } from './scrapers/gogoanime.scraper';
import { NineAnimeScraper } from './scrapers/nineanime.scraper';
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
    VidFastScraper,
    GogoAnimeScraper,
    NineAnimeScraper,
    AnimePaheScraper,
    // HnEmbedScraper disabled per user request
    MirrorsScraper,
    {
      provide: SCRAPER_TOKEN,
      useFactory: (vidsrc: VidSrcScraper, vidlink: VidLinkScraper, vidfast: VidFastScraper, gogo: GogoAnimeScraper, nineanime: NineAnimeScraper, animepahe: AnimePaheScraper, mirrors: MirrorsScraper) =>
        [vidsrc, vidlink, vidfast, gogo, nineanime, animepahe, mirrors],
      inject: [VidSrcScraper, VidLinkScraper, VidFastScraper, GogoAnimeScraper, NineAnimeScraper, AnimePaheScraper, MirrorsScraper],
    },
  ],
  exports: [ProvidersService],
})
export class ProvidersModule { }
