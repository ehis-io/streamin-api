import { Injectable, Inject, Logger, BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';

export interface SubtitleResult {
    id: string;
    language: string;
    display: string;
    /** Relative path — the frontend prefixes NEXT_PUBLIC_API_URL itself. */
    url: string;
}

/**
 * Subtitle search + delivery.
 *
 * Search is backed by Wyzie Subs (https://sub.wyzie.io), which is keyed by TMDB id
 * and returns the shape the frontend already expects ({ id, language, display, url }).
 * It requires a free API key — set WYZIE_API_KEY. Without one we return an empty
 * list rather than erroring, so the CC menu simply shows "Off".
 *
 * Files are proxied through this API rather than handed to the browser directly:
 *  - the player does fetch() + Blob(), which needs CORS; our own origin already allows it
 *  - upstream files are often SRT, which <track> can't parse — we convert to VTT
 */
@Injectable()
export class SubtitlesService {
    private readonly logger = new Logger(SubtitlesService.name);
    private readonly searchUrl = 'https://sub.wyzie.io/search';
    private readonly CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

    /**
     * Hosts we're willing to fetch subtitle files from. `src` is attacker-controllable,
     * so without this the file endpoint would be an SSRF hole into the internal network.
     */
    private readonly ALLOWED_FILE_HOSTS = [
        'sub.wyzie.io',
        'sub.wyzie.ru',
        'opensubtitles.com',
        'opensubtitles.org',
        'vip.opensubtitles.org',
        'dl.opensubtitles.org',
    ];

    constructor(
        private configService: ConfigService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) { }

    async search(tmdbId: number, season?: number, episode?: number, language = 'en'): Promise<{ results: SubtitleResult[] }> {
        const apiKey = this.configService.get<string>('WYZIE_API_KEY');
        if (!apiKey) {
            this.logger.warn('WYZIE_API_KEY is not set — subtitle search disabled, returning empty list');
            return { results: [] };
        }

        const cacheKey = `subs:${tmdbId}:s${season ?? ''}:e${episode ?? ''}:${language}`;
        try {
            const cached = await this.cacheManager.get<{ results: SubtitleResult[] }>(cacheKey);
            if (cached) return cached;
        } catch (e: any) {
            this.logger.warn(`Subtitle cache read failed: ${e.message}`);
        }

        try {
            const params: Record<string, string> = { id: String(tmdbId), language, key: apiKey };
            if (season !== undefined) params.season = String(season);
            if (episode !== undefined) params.episode = String(episode);

            const res = await axios.get(this.searchUrl, { params, timeout: 12000 });
            const raw = Array.isArray(res.data) ? res.data : (res.data?.results || []);

            const results: SubtitleResult[] = raw
                .filter((r: any) => r?.url && this.isAllowedFileUrl(r.url))
                .map((r: any, i: number) => ({
                    id: String(r.id ?? i),
                    language: r.language || language,
                    display: r.display || r.title || `Subtitle ${i + 1}`,
                    url: `/api/v1/subtitles/file?src=${encodeURIComponent(r.url)}`,
                }));

            const payload = { results };
            try {
                await this.cacheManager.set(cacheKey, payload, this.CACHE_TTL_MS);
            } catch (e: any) {
                this.logger.warn(`Subtitle cache write failed: ${e.message}`);
            }
            return payload;
        } catch (e: any) {
            this.logger.error(`Subtitle search failed for tmdb ${tmdbId}: ${e.message}`);
            return { results: [] };
        }
    }

    /** Fetch an upstream subtitle file and return it as WebVTT. */
    async getFileAsVtt(src: string): Promise<string> {
        if (!src) throw new BadRequestException('src query parameter is required');
        if (!this.isAllowedFileUrl(src)) {
            // Never fetch arbitrary URLs on behalf of a caller.
            throw new BadRequestException('src host is not allowed');
        }

        const cacheKey = `subfile:${src}`;
        try {
            const cached = await this.cacheManager.get<string>(cacheKey);
            if (cached) return cached;
        } catch {
            // non-fatal
        }

        try {
            const res = await axios.get(src, {
                timeout: 15000,
                responseType: 'text',
                maxContentLength: 5 * 1024 * 1024, // subtitles are tiny; cap to avoid abuse
                transformResponse: (d) => d,
            });

            const vtt = this.toVtt(String(res.data ?? ''));
            try {
                await this.cacheManager.set(cacheKey, vtt, this.CACHE_TTL_MS);
            } catch {
                // non-fatal
            }
            return vtt;
        } catch (e: any) {
            this.logger.error(`Subtitle fetch failed for ${src}: ${e.message}`);
            throw new HttpException('Failed to fetch subtitle', HttpStatus.BAD_GATEWAY);
        }
    }

    private isAllowedFileUrl(raw: string): boolean {
        try {
            const u = new URL(raw);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
            const host = u.hostname.toLowerCase();
            return this.ALLOWED_FILE_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
        } catch {
            return false;
        }
    }

    /**
     * Convert SRT to WebVTT. Already-VTT input is passed through (just normalized).
     * SRT differs from VTT in two ways that matter to <track>: the missing WEBVTT
     * header, and comma decimal separators in cue timings.
     */
    private toVtt(input: string): string {
        // Strip BOM and normalize line endings.
        let text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (/^\s*WEBVTT/.test(text)) return text;

        // 00:00:01,234 --> 00:00:02,345  =>  00:00:01.234 --> 00:00:02.345
        text = text.replace(
            /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
            '$1.$2 --> $3.$4',
        );

        return `WEBVTT\n\n${text.trim()}\n`;
    }
}
