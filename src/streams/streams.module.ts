import { Module } from '@nestjs/common';
import { StreamsController } from './streams.controller';
import { ProvidersModule } from '../providers/providers.module';
import { StreamsGateway } from './streams.gateway';

@Module({
  imports: [ProvidersModule],
  controllers: [StreamsController],
  providers: [StreamsGateway],
})
export class StreamsModule { }
