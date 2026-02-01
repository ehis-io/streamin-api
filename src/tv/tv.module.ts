import { Module } from '@nestjs/common';
import { TvController } from './tv.controller';
import { TvService } from './tv.service';
import { TmdbModule } from '../tmdb/tmdb.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [TmdbModule, PrismaModule],
  controllers: [TvController],
  providers: [TvService],
})
export class TvModule {}
