import { Controller, Get, Query, Param } from '@nestjs/common';
import { MoviesService } from './movies.service';
import { SearchDto } from './dto/search.dto';

@Controller('movies')
export class MoviesController {
  constructor(private readonly moviesService: MoviesService) {}

  @Get('trending')
  getTrending(@Query('page') page: string) {
    return this.moviesService.getTrending(page ? +page : 1);
  }

  @Get('search')
  search(@Query() query: SearchDto, @Query('page') page: string) {
    return this.moviesService.search(query.q, page ? +page : 1);
  }

  @Get('genres')
  getGenres() {
    return this.moviesService.getGenres();
  }

  @Get('discover')
  discover(@Query() query: any) {
    return this.moviesService.discover(query);
  }

  @Get(':id')
  getDetails(@Param('id') id: string) {
    return this.moviesService.getDetails(+id);
  }
}
