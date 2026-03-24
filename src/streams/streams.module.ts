import { Module } from '@nestjs/common';
import { StreamsController } from './streams.controller';
import { ConfigModule } from '@nestjs/config';
import { ProvidersModule } from '../providers/providers.module';
import { StreamsGateway } from './streams.gateway';
import { HlsProxyService } from './hls-proxy.service';
import { HlsDownloadService } from './hls-download.service';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../common/cache/redis.module';

@Module({
  imports: [ProvidersModule, ConfigModule, PrismaModule, RedisModule],
  controllers: [StreamsController],
  providers: [StreamsGateway, HlsDownloadService],
})
export class StreamsModule { }
