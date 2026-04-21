import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { RedisModule } from './common/cache/redis.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TmdbModule } from './tmdb/tmdb.module';
import { ProvidersModule } from './providers/providers.module';
import { MoviesModule } from './movies/movies.module';
import { TvModule } from './tv/tv.module';
import { StreamsModule } from './streams/streams.module';
import { PrismaModule } from './prisma/prisma.module';
import { MALModule } from './mal/mal.module';
import { AnimesModule } from './animes/animes.module';
import { AiModule } from './ai/ai.module';
import { PlaylistsModule } from './playlists/playlists.module';
import { PuppeteerModule } from './puppeteer/puppeteer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{
      ttl: 60000,
      limit: 300,
    }]),
    RedisModule,
    TmdbModule,
    MALModule,
    ProvidersModule,
    MoviesModule,
    TvModule,
    StreamsModule,
    PrismaModule,
    AnimesModule,
    AiModule,
    PlaylistsModule,
    PuppeteerModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule { }
