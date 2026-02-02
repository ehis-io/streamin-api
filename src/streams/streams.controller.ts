import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ProvidersService } from '../providers/providers.service';
import { GetStreamsDto } from './dto/get-streams.dto';
import { PrefetchStreamsDto } from './dto/prefetch-streams.dto';

@Controller('streams')
export class StreamsController {
  constructor(private readonly providersService: ProvidersService) { }

  @Post('prefetch')
  async prefetch(@Body() data: PrefetchStreamsDto) {
    this.providersService.prefetchLinks(data.items);
    return { success: true, message: 'Prefetch started' };
  }

  @Get(':id')
  async getStreams(
    @Param('id') id: string,
    @Query() query: GetStreamsDto,
  ) {
    return this.providersService.findStreamLinks(
      id,
      query.season,
      query.episode,
      query.type,
      query.mediaType
    );
  }

  @Get(':id/:season/:episode')
  async getStreamsNested(
    @Param('id') id: string,
    @Param('season') season: string,
    @Param('episode') episode: string,
    @Query('type') type: 'sub' | 'dub' = 'sub',
    @Query('mediaType') mediaType?: string,
  ) {
    return this.providersService.findStreamLinks(id, parseInt(season), parseInt(episode), type, mediaType);
  }
}
