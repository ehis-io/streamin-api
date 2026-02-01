import { Injectable } from '@nestjs/common';
import { TmdbService } from './tmdb/tmdb.service';

@Injectable()
export class AppService {
  constructor(private tmdbService: TmdbService) {}

  getHello(): string {
    return 'Hello World!';
  }

  async getTrending(page: number = 1) {
    return this.tmdbService.getTrending('all', page);
  }

  async search(query: string, page: number = 1) {
    return this.tmdbService.searchMulti(query, page);
  }
}
