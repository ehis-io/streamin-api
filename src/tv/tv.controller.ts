import { Controller, Get, Query, Param } from '@nestjs/common';
import { TvService } from './tv.service';
import { SearchDto } from '../common/dto/search.dto';
import { DiscoverDto } from '../common/dto/discover.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('tv')
export class TvController {
  constructor(private readonly tvService: TvService) { }

  @Get('trending')
  getTrending(@Query() query: PaginationDto) {
    return this.tvService.getTrending(query.page);
  }

  @Get('search')
  search(@Query() query: SearchDto) {
    return this.tvService.search(query.q, query.page);
  }

  @Get('genres')
  getGenres() {
    return this.tvService.getGenres();
  }

  @Get('discover')
  discover(@Query() query: DiscoverDto) {
    return this.tvService.discover(query);
  }

  @Get(':id/recommendations')
  getRecommendations(@Param('id') id: string) {
    return this.tvService.getRecommendations(+id);
  }

  @Get(':id')
  getDetails(@Param('id') id: string) {
    return this.tvService.getDetails(+id);
  }
}
