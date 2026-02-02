import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import {
    JikanClient,
    AnimeEndpoint,
    MangaEndpoint,
    SeasonsEndpoint,
    TopEndpoint,
    GenresEndpoint,
    ProducersEndpoint
} from 'myanimelist-wrapper';

@Injectable()
export class MALService {
    private readonly logger = new Logger(MALService.name);

    constructor(
        private configService: ConfigService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
        private jikanClient: JikanClient,
        private animeEndpoint: AnimeEndpoint,
        private mangaEndpoint: MangaEndpoint,
        private seasonsEndpoint: SeasonsEndpoint,
        private topEndpoint: TopEndpoint,
        private genresEndpoint: GenresEndpoint,
        private producersEndpoint: ProducersEndpoint,
    ) { }

    private async getCachedRequest<T>(key: string, requestFn: () => Promise<T>, ttl: number = 604800000): Promise<T> {
        const cached = await this.cacheManager.get<T>(key);
        if (cached) {
            return cached;
        }

        try {
            const data = await requestFn();
            await this.cacheManager.set(key, data, ttl);
            return data;
        } catch (e) {
            this.logger.error(`MAL request failed for key ${key}: ${e.message}`);
            throw e;
        }
    }

    async getTrending(page: number = 1) {
        return this.getCachedRequest(`mal:trending:page:${page}`, () =>
            this.seasonsEndpoint.getCurrent({ page })
        );
    }

    async search(query: string, page: number = 1) {
        return this.getCachedRequest(`mal:search:${query}:page:${page}`, () =>
            this.animeEndpoint.search({ q: query, page })
        );
    }

    async getDetails(id: number) {
        return this.getCachedRequest(`mal:details:${id}`, () =>
            this.animeEndpoint.getById(id)
        );
    }

    async getGenres() {
        return this.getCachedRequest(`mal:genres`, () =>
            this.genresEndpoint.getAnimeGenres()
        );
    }

    async getProducers() {
        return this.getCachedRequest(`mal:producers`, () =>
            this.producersEndpoint.getAll()
        );
    }

    async getRecommendations(id: number) {
        return this.getCachedRequest(`mal:recommendations:${id}`, () =>
            this.animeEndpoint.getRecommendations(id)
        );
    }

    async discover(params: any) {
        const page = params.page ? parseInt(params.page) : 1;
        const genres = params.with_genres;
        const producers = params.producers;
        const minScore = params['vote_average.gte'];
        const sortByParam = params.sort_by || 'popularity.desc';
        const [sortField, sortDirection] = sortByParam.split('.');

        let orderBy = 'popularity';
        let sort = sortDirection || 'desc';

        if (sortField === 'vote_average') {
            orderBy = 'score';
        } else if (sortField === 'primary_release_date') {
            orderBy = 'start_date';
        }

        const queryParams: any = {
            page,
            order_by: orderBy,
            sort,
            sfw: true
        };

        if (genres) {
            queryParams.genres = genres;
        }

        if (producers) {
            queryParams.producers = producers;
        }

        if (minScore) {
            queryParams.min_score = minScore;
        }

        // Map standard TMDB date params to Jikan params
        if (params['primary_release_date.gte']) {
            queryParams.start_date = params['primary_release_date.gte'];
        }
        if (params['primary_release_date.lte']) {
            queryParams.end_date = params['primary_release_date.lte'];
        }

        return this.getCachedRequest(`mal:discover:${JSON.stringify(queryParams)}`, () =>
            this.animeEndpoint.search(queryParams)
        );
    }
}