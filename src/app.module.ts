import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
