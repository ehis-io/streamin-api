import { Injectable } from '@nestjs/common';
import { TmdbService } from '../tmdb/tmdb.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TvService {
  constructor(
    private tmdbService: TmdbService,
    private prismaService: PrismaService,
  ) {}

  async getTrending(page: number = 1) {
    return this.tmdbService.getTrending('tv', page);
  }

  async search(query: string, page: number = 1) {
    return this.tmdbService.search(query, 'tv', page);
  }

  async getDetails(id: number) {
    const tmdbData = await this.tmdbService.getDetails(id, 'tv');
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
    return this.tmdbService.getGenres('tv');
  }

  async discover(params: any) {
    return this.tmdbService.discover('tv', params);
  }
}
