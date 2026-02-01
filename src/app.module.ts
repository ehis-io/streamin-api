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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    TmdbModule,
    ProvidersModule,
    MoviesModule,
    TvModule,
    StreamsModule,
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
