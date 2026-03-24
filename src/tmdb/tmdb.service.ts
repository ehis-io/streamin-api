import { Injectable, Inject, Logger, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';
import * as https from 'https';

@Injectable()
export class TmdbService {
  private readonly baseUrl = 'https://api.themoviedb.org/3';
  private readonly apiKey: string;
  private readonly logger = new Logger(TmdbService.name);
  private readonly httpsAgent = new https.Agent({ family: 4 });
  private readonly inFlightRequests = new Map<string, Promise<any>>();

  constructor(
    private configService: ConfigService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {
    this.apiKey = this.configService.get<string>('TMDB_API_KEY') || '';
  }

  private async getCachedRequest(key: string, url: string, params: any, ttl: number = 604800000) {
    const cacheKey = key.replace(/[:\s?&]/g, '_');
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) {
      return this.filterFutureContent(cached);
    }

    if (!this.apiKey || this.apiKey.includes('your_tmdb_api_key')) {
      this.logger.warn(`TMDB API Key missing or invalid. Returning empty/mock for ${key}`);
      return { results: [], mock: true };
    }

    // Deduplicate concurrent requests for the same TMDB resource
    if (this.inFlightRequests.has(cacheKey)) {
      this.logger.debug(`[Deduplication] Joining in-flight TMDB request for ${cacheKey}`);
      try {
        const responseData = await this.inFlightRequests.get(cacheKey);
        return this.filterFutureContent(responseData);
      } catch (e) {
        // If the in-flight fails, we fall through and try again or just let it throw
        throw e;
      }
    }

    const fetchPromise = (async () => {
      try {
        this.logger.debug(`Fetching TMDB: ${url}`);
        const response = await axios.get(url, { 
          params: { ...params, api_key: this.apiKey },
          httpsAgent: this.httpsAgent,
          timeout: 30000 // Increased to 30s for better reliability on slower networks
        });
        try {
          await this.cacheManager.set(cacheKey, response.data, ttl);
        } catch (cacheError) {
          this.logger.warn(`Failed to cache TMDB response for ${key}: ${cacheError.message}`);
        }
        return response.data;
      } catch (e: any) {
        if (e.response?.status === 404) {
          this.logger.warn(`TMDB content not found for ${url}`);
          throw new NotFoundException('Content not found on TMDB');
        }
        this.logger.error(`TMDB request failed for ${url}: ${e.message}`, e.stack);
        throw new InternalServerErrorException(`TMDB request failed: ${e.message}`);
      } finally {
        this.inFlightRequests.delete(cacheKey);
      }
    })();

    this.inFlightRequests.set(cacheKey, fetchPromise);
    const result = await fetchPromise;
    return this.filterFutureContent(result);
  }

  private filterFutureContent(data: any): any {
    if (!data) return data;

    // Get today's date in YYYY-MM-DD format
    const today = new Date().toISOString().split('T')[0];

    // Helper to check if an item is released
    const isReleased = (item: any) => {
      const releaseDate = item.release_date || item.first_air_date;
      if (!releaseDate) return false; // Exclude if no date (upcoming/TBA)
      return releaseDate <= today;
    };

    // If it's a list response
    if (data.results && Array.isArray(data.results)) {
      return {
        ...data,
        results: data.results.filter(isReleased)
      };
    }

    // If it's a single item response (e.g. details)
    if (data.id && (data.release_date || data.first_air_date || data.status)) {
      return isReleased(data) ? data : null;
    }

    return data;
  }

  async getTrending(type: 'movie' | 'tv' | 'all' = 'movie', page: number = 1) {
    const data = await this.getCachedRequest(`trending:${type}:page:${page}`, `${this.baseUrl}/trending/${type}/day`, { page });
    if (type !== 'all' && data?.results) {
      data.results = data.results.map((item: any) => ({ ...item, media_type: type }));
    }
    return data;
  }

  async search(query: string, type: 'movie' | 'tv' = 'movie', page: number = 1) {
    const data = await this.getCachedRequest(`search:${type}:${query}:page:${page}`, `${this.baseUrl}/search/${type}`, { query, page });
    if (data?.results) {
      data.results = data.results.map((item: any) => ({ ...item, media_type: type }));
    }
    return data;
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
    const {
      page = 1,
      with_genres = '',
      sort_by = 'popularity.desc',
      'primary_release_date.gte': dateGte = '',
      'primary_release_date.lte': dateLte = '',
      'first_air_date.gte': airDateGte = '',
      'first_air_date.lte': airDateLte = '',
      'vote_average.gte': voteGte = ''
    } = params;

    const cacheKey = `discover:${type}:p${page}:g${with_genres}:s${sort_by}:d${dateGte}-${dateLte}:ad${airDateGte}-${airDateLte}:v${voteGte}`;
    const data = await this.getCachedRequest(cacheKey, `${this.baseUrl}/discover/${type}`, params);
    if (data?.results) {
      data.results = data.results.map((item: any) => ({ ...item, media_type: type }));
    }
    return data;
  }

  async getRecommendations(id: number, type: 'movie' | 'tv' = 'movie', page: number = 1) {
    return this.getCachedRequest(`recommendations:${type}:${id}:page:${page}`, `${this.baseUrl}/${type}/${id}/recommendations`, { page });
  }

  async getSeasonDetails(id: number, season: number) {
    return this.getCachedRequest(`tv:${id}:season:${season}`, `${this.baseUrl}/tv/${id}/season/${season}`, {});
  }
}
