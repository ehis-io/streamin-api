import { Injectable, NotFoundException } from '@nestjs/common';
import { TmdbService } from '../tmdb/tmdb.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MoviesService {
  constructor(
    private tmdbService: TmdbService,
    private prismaService: PrismaService,
  ) { }

  async getTrending(page: number = 1) {
    return this.tmdbService.getTrending('movie', page);
  }

  async search(query: string, page: number = 1) {
    return this.tmdbService.search(query, 'movie', page);
  }

  async getDetails(id: number) {
    const tmdbData = await this.tmdbService.getDetails(id);
    // filterFutureContent returns null for unreleased titles — surface a real 404
    // instead of a `{ localProviders: [] }` stub with no id/title/overview.
    if (!tmdbData || !tmdbData.id) {
      throw new NotFoundException('Movie not found or not yet released');
    }

    // tmdbId is globally unique across movies AND tv, so filter by type to avoid
    // returning a TV record's providers for a movie request (and vice-versa).
    const dbData = await this.prismaService.movie.findFirst({
      where: { tmdbId: id, type: 'movie' },
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

  async getRecommendations(id: number) {
    return this.tmdbService.getRecommendations(id, 'movie');
  }
}
