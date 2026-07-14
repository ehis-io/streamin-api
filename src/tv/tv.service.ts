import { Injectable, NotFoundException } from '@nestjs/common';
import { TmdbService } from '../tmdb/tmdb.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TvService {
  constructor(
    private tmdbService: TmdbService,
    private prismaService: PrismaService,
  ) { }

  async getTrending(page: number = 1) {
    return this.tmdbService.getTrending('tv', page);
  }

  async search(query: string, page: number = 1) {
    return this.tmdbService.search(query, 'tv', page);
  }

  async getDetails(id: number) {
    const tmdbData = await this.tmdbService.getDetails(id, 'tv');
    // filterFutureContent returns null for unreleased titles — surface a real 404
    // instead of a `{ localProviders: [] }` stub with no id/title/overview.
    if (!tmdbData || !tmdbData.id) {
      throw new NotFoundException('TV show not found or not yet released');
    }

    // tmdbId is globally unique across movies AND tv, so filter by type to avoid
    // returning a movie record's providers for a tv request (and vice-versa).
    const dbData = await this.prismaService.movie.findFirst({
      where: { tmdbId: id, type: 'tv' },
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

  async getRecommendations(id: number) {
    return this.tmdbService.getRecommendations(id, 'tv');
  }

  async getSeasonDetails(id: number, season: number) {
    return this.tmdbService.getSeasonDetails(id, season);
  }
}
