import { Controller, Get, Query, Param } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { SearchDto } from '../common/dto/search.dto';
import { DiscoverDto } from '../common/dto/discover.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('movies')
export class MoviesController {
  constructor(private readonly moviesService: MoviesService) { }

  @Get('trending')
  getTrending(@Query() query: PaginationDto) {
    return this.moviesService.getTrending(query.page);
  }

  @Get('search')
  search(@Query() query: SearchDto) {
    return this.moviesService.search(query.q, query.page);
  }

  @Get('genres')
  getGenres() {
    return this.moviesService.getGenres();
  }

  @Get('discover')
  discover(@Query() query: DiscoverDto) {
    return this.moviesService.discover(query);
  }

  @Get(':id/recommendations')
  getRecommendations(@Param('id') id: string) {
    return this.moviesService.getRecommendations(+id);
  }

  @Get(':id')
  getDetails(@Param('id') id: string) {
    return this.moviesService.getDetails(+id);
  }
}
