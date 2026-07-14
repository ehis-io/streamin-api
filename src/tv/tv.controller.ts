import { Controller, Get, Query, Param, ParseIntPipe } from '@nestjs/common';
import { TvService } from './tv.service';
import { SearchDto } from '../common/dto/search.dto';
import { DiscoverDto } from '../common/dto/discover.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('tv')
export class TvController {
  constructor(private readonly tvService: TvService) { }

  @Get('trending')
  getTrending(@Query() query: PaginationDto) {
    console.log('[TV] Trending request:', query);
    return this.tvService.getTrending(query.page);
  }

  @Get('search')
  search(@Query() query: SearchDto) {
    console.log('[TV] Search request:', query);
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
  getRecommendations(@Param('id', ParseIntPipe) id: number) {
    return this.tvService.getRecommendations(id);
  }

  @Get(':id')
  getDetails(@Param('id', ParseIntPipe) id: number) {
    return this.tvService.getDetails(id);
  }

  @Get(':id/season/:season')
  getSeasonDetails(@Param('id', ParseIntPipe) id: number, @Param('season', ParseIntPipe) season: number) {
    return this.tvService.getSeasonDetails(id, season);
  }
}
