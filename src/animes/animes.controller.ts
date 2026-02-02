import { Controller, Get, Query, Param } from '@nestjs/common';
import { AnimesService } from './animes.service';
import { SearchDto } from '../common/dto/search.dto';
import { DiscoverDto } from '../common/dto/discover.dto';
import { PaginationDto } from '../common/dto/pagination.dto';

@Controller('animes')
export class AnimesController {
    constructor(private readonly animesService: AnimesService) { }

    @Get('trending')
    getTrending(@Query() query: PaginationDto) {
        return this.animesService.getTrending(query.page);
    }

    @Get('search')
    search(@Query() query: SearchDto) {
        return this.animesService.search(query.q, query.page);
    }

    @Get('genres')
    getGenres() {
        return this.animesService.getGenres();
    }

    @Get('producers')
    getProducers() {
        return this.animesService.getProducers();
    }

    @Get('discover')
    discover(@Query() query: DiscoverDto) {
        return this.animesService.discover(query);
    }

    @Get(':id/recommendations')
    getRecommendations(@Param('id') id: string) {
        return this.animesService.getRecommendations(+id);
    }

    @Get(':id')
    getDetails(@Param('id') id: string) {
        return this.animesService.getDetails(+id);
    }
}
