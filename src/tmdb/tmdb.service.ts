import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

@Injectable()
export class TmdbService {
  private readonly baseUrl = 'https://api.themoviedb.org/3';
  private readonly apiKey: string;
  private readonly logger = new Logger(TmdbService.name);

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    this.apiKey = this.configService.get<string>('TMDB_API_KEY') || '';
  }

  private async getCachedRequest(key: string, url: string, params: any, ttl: number = 3600000) {
    const cached = await this.cacheManager.get(key);
    if (cached) {
      return cached;
    }

    if (!this.apiKey || this.apiKey.includes('your_tmdb_api_key')) {
        this.logger.warn(`TMDB API Key missing or invalid. Returning empty/mock for ${key}`);
        // Return minimal mock to prevent crash during setup
        return { results: [], mock: true };
    }
    
    try {
        const response = await axios.get(url, { params: { ...params, api_key: this.apiKey } });
        await this.cacheManager.set(key, response.data, ttl);
        return response.data;
    } catch (e) {
        this.logger.error(`TMDB request failed: ${e.message}`);
        throw e;
    }
  }

  async getTrending(type: 'movie' | 'tv' | 'all' = 'movie', page: number = 1) {
    return this.getCachedRequest(`trending:${type}:page:${page}`, `${this.baseUrl}/trending/${type}/day`, { page });
  }

  async search(query: string, type: 'movie' | 'tv' = 'movie', page: number = 1) {
     return this.getCachedRequest(`search:${type}:${query}:page:${page}`, `${this.baseUrl}/search/${type}`, { query, page });
  }

  async searchMulti(query: string, page: number = 1) {
     return this.getCachedRequest(`search:multi:${query}:page:${page}`, `${this.baseUrl}/search/multi`, { query, page });
  }

  async getDetails(id: number, type: 'movie' | 'tv' = 'movie') {
     return this.getCachedRequest(`details:${type}:${id}`, `${this.baseUrl}/${type}/${id}`, {});
  }

  async getGenres(type: 'movie' | 'tv' = 'movie') {
    return this.getCachedRequest(`genres:${type}`, `${this.baseUrl}/genre/${type}/list`, {});
  }

  async discover(type: 'movie' | 'tv' = 'movie', params: any = {}) {
    // Generate a simpler cache key for discovery to prevent massive key proliferation
    // In a real app, you might want more robust key generation
    const { page = 1, with_genres = '', sort_by = 'popularity.desc' } = params;
    const cacheKey = `discover:${type}:p${page}:g${with_genres}:s${sort_by}`;
    return this.getCachedRequest(cacheKey, `${this.baseUrl}/discover/${type}`, params);
  }
}
