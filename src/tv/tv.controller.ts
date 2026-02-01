import { Controller, Get, Query, Param } from '@nestjs/common';
import { TvService } from './tv.service';
import { IsString, IsNotEmpty } from 'class-validator';

class SearchDto {
  @IsString()
  @IsNotEmpty()
  q: string;
}

@Controller('tv')
export class TvController {
  constructor(private readonly tvService: TvService) {}

  @Get('trending')
  getTrending(@Query('page') page: string) {
    return this.tvService.getTrending(page ? +page : 1);
  }

  @Get('search')
  search(@Query() query: SearchDto, @Query('page') page: string) {
    return this.tvService.search(query.q, page ? +page : 1);
  }

  @Get('genres')
  getGenres() {
    return this.tvService.getGenres();
  }

  @Get('discover')
  discover(@Query() query: any) {
    return this.tvService.discover(query);
  }

  @Get(':id')
  getDetails(@Param('id') id: string) {
    return this.tvService.getDetails(+id);
  }
}
