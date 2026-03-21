import { Module } from '@nestjs/common';
import { StreamsController } from './streams.controller';
import { ConfigModule } from '@nestjs/config';
import { ProvidersModule } from '../providers/providers.module';
import { StreamsGateway } from './streams.gateway';
import { HlsProxyService } from './hls-proxy.service';
import { HlsDownloadService } from './hls-download.service';

@Module({
  imports: [ProvidersModule, ConfigModule],
  controllers: [StreamsController],
  providers: [StreamsGateway, HlsProxyService, HlsDownloadService],
})
export class StreamsModule { }
