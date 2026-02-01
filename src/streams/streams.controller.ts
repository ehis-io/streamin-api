import { Controller, Get, Param, Query } from '@nestjs/common';
import { ProvidersService } from '../providers/providers.service';
import { GetStreamsDto } from './dto/get-streams.dto';

@Controller('streams')
export class StreamsController {
  constructor(private readonly providersService: ProvidersService) {}

  @Get(':id')
  async getStreams(
    @Param('id') id: string,
    @Query() query: GetStreamsDto,
  ) {
    return this.providersService.findStreamLinks(id, query.season, query.episode);
  }

  @Get(':id/:season/:episode')
  async getStreamsNested(
    @Param('id') id: string,
    @Param('season') season: string,
    @Param('episode') episode: string,
  ) {
    return this.providersService.findStreamLinks(id, parseInt(season), parseInt(episode));
  }
}
