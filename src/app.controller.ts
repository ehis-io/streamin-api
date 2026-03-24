import { Controller, Get, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
  ) { }

  @Get('config-debug')
  getConfig() {
    return {
      PORT: process.env.PORT,
      API_URL: this.configService.get('API_URL'),
      NODE_ENV: process.env.NODE_ENV,
    };
  }

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
