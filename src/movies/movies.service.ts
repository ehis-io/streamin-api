import { Injectable } from '@nestjs/common';
import { TmdbService } from '../tmdb/tmdb.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MoviesService {
  constructor(
    private tmdbService: TmdbService,
    private prismaService: PrismaService,
  ) {}

  async getTrending(page: number = 1) {
    return this.tmdbService.getTrending('movie', page);
  }

  async search(query: string, page: number = 1) {
    return this.tmdbService.search(query, 'movie', page);
  }

  async getDetails(id: number) {
    const tmdbData = await this.tmdbService.getDetails(id);
    const dbData = await this.prismaService.movie.findUnique({
      where: { tmdbId: id },
      include: { providers: true },
    });

    return {
      ...tmdbData,
      localProviders: dbData?.providers || [],
    };
  }

  async getGenres() {
    return this.tmdbService.getGenres('movie');
  }

  async discover(params: any) {
    return this.tmdbService.discover('movie', params);
  }
}
