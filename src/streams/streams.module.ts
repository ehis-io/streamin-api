import { Module } from '@nestjs/common';
import { StreamsController } from './streams.controller';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  controllers: [StreamsController],
})
export class StreamsModule {}
