import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { VidSrcScraper } from './scrapers/vidsrc.scraper';
import { VidLinkScraper } from './scrapers/vidlink.scraper';
import { TmdbModule } from '../tmdb/tmdb.module';
import { SCRAPER_TOKEN } from './scraper.interface';

@Module({
  imports: [TmdbModule],
  providers: [
    ProvidersService,
    VidSrcScraper,
    VidLinkScraper,
    {
      provide: SCRAPER_TOKEN,
      useFactory: (vidsrc: VidSrcScraper, vidlink: VidLinkScraper) => {
        return [vidsrc, vidlink];
      },
      inject: [VidSrcScraper, VidLinkScraper],
    },
  ],
  exports: [ProvidersService],
})
export class ProvidersModule { }
