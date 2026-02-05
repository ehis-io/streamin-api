import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { VidSrcScraper } from './scrapers/vidsrc.scraper';
import { VidLinkScraper } from './scrapers/vidlink.scraper';
import { GogoAnimeScraper } from './scrapers/gogoanime.scraper';
import { HnEmbedScraper } from './scrapers/hnembed.scraper';
import { TmdbModule } from '../tmdb/tmdb.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SCRAPER_TOKEN } from './scraper.interface';

@Module({
  imports: [TmdbModule, PrismaModule],
  providers: [
    ProvidersService,
    VidSrcScraper,
    VidLinkScraper,
    GogoAnimeScraper,
    HnEmbedScraper,
    {
      provide: SCRAPER_TOKEN,
      useFactory: (vidsrc: VidSrcScraper, vidlink: VidLinkScraper, gogo: GogoAnimeScraper, hnembed: HnEmbedScraper) => 
        [vidsrc, vidlink, gogo, hnembed],
      inject: [VidSrcScraper, VidLinkScraper, GogoAnimeScraper, HnEmbedScraper],
    },
  ],
  exports: [ProvidersService],
})
export class ProvidersModule { }
