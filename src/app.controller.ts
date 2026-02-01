import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('trending')
  getTrending(@Query('page') page: string) {
    return this.appService.getTrending(page ? +page : 1);
  }

  @Get('search')
  search(@Query('q') q: string, @Query('page') page: string) {
    return this.appService.search(q, page ? +page : 1);
  }
}
