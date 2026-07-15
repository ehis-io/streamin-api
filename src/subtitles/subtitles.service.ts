import { Injectable, Inject, Logger, BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import axios from 'axios';
import * as crypto from 'crypto';
import * as zlib from 'zlib';

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

    constructor(
        private readonly configService: ConfigService,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) { }

    /**
     * `src` is caller-controllable, so the file endpoint must never fetch an arbitrary
     * URL (SSRF). Rather than allowlisting hosts — which silently drops legitimate
     * results whenever the upstream uses a host we didn't predict — we HMAC-sign every
     * src we hand out in search() and only fetch ones carrying a valid signature.
     * That's both a tighter guard (attackers can't forge) and impossible to over-block.
     *
     * The secret piggybacks on WYZIE_API_KEY: without it search returns nothing, so no
     * signed URLs exist to honour anyway. SUBTITLE_SIGNING_SECRET overrides it.
     */
    private signingSecret(): string | null {
        return this.configService.get<string>('SUBTITLE_SIGNING_SECRET')
            || this.configService.get<string>('WYZIE_API_KEY')
            || null;
    }

    private sign(src: string): string {
        const secret = this.signingSecret();
        if (!secret) return '';
        return crypto.createHmac('sha256', secret).update(src).digest('hex').slice(0, 32);
    }

    private verify(src: string, sig?: string): boolean {
        const expected = this.sign(src);
        if (!expected || !sig) return false;
        const a = Buffer.from(expected);
        const b = Buffer.from(sig);
        // Length check first: timingSafeEqual throws on mismatched lengths.
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    /** Defence in depth: even a signed URL must not point at internal infrastructure. */
    private isPubliclyRoutable(raw: string): boolean {
        try {
            const u = new URL(raw);
            if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
            const h = u.hostname.toLowerCase();
            if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')) return false;
            // Literal private / loopback / link-local IPs
            if (/^(127\.|10\.|169\.254\.|192\.168\.|0\.)/.test(h)) return false;
            if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
            if (h === '::1' || h.startsWith('[')) return false;
            return true;
        } catch {
            return false;
        }
    }

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

            const usable = raw.filter((r: any) => typeof r?.url === 'string' && this.isPubliclyRoutable(r.url));
            if (raw.length > 0 && usable.length === 0) {
                // Loud, not silent: an empty CC menu should never be a mystery.
                this.logger.error(
                    `Subtitle search returned ${raw.length} entries but none were usable. ` +
                    `First entry: ${JSON.stringify(raw[0])?.slice(0, 200)}`,
                );
            }

            const results: SubtitleResult[] = usable.map((r: any, i: number) => ({
                id: String(r.id ?? i),
                language: r.language || language,
                display: r.display || r.title || `Subtitle ${i + 1}`,
                url: `/api/v1/subtitles/file?src=${encodeURIComponent(r.url)}&sig=${this.sign(r.url)}`,
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
    async getFileAsVtt(src: string, sig?: string): Promise<string> {
        if (!src) throw new BadRequestException('src query parameter is required');
        // Only fetch URLs this service itself issued (see signingSecret()).
        if (!this.verify(src, sig)) throw new ForbiddenException('invalid or missing signature for src');
        if (!this.isPubliclyRoutable(src)) throw new BadRequestException('src host is not allowed');

        const cacheKey = `subfile:${src}`;
        try {
            const cached = await this.cacheManager.get<string>(cacheKey);
            if (cached) return cached;
        } catch {
            // non-fatal
        }

        let body: Buffer;
        try {
            const res = await axios.get<ArrayBuffer>(src, {
                timeout: 15000,
                // Fetch as bytes: some sources serve gzipped .gz files, which would be
                // mangled into garbage if decoded as text up front.
                responseType: 'arraybuffer',
                maxContentLength: 5 * 1024 * 1024, // subtitles are tiny; cap to avoid abuse
            });
            body = Buffer.from(res.data);
        } catch (e: any) {
            this.logger.error(`Subtitle fetch failed for ${src}: ${e.message}`);
            throw new HttpException('Failed to fetch subtitle', HttpStatus.BAD_GATEWAY);
        }

        // gzip magic bytes — .gz payloads are common from subtitle mirrors.
        if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
            try {
                body = zlib.gunzipSync(body);
            } catch (e: any) {
                this.logger.error(`Subtitle gunzip failed for ${src}: ${e.message}`);
                throw new HttpException('Failed to decompress subtitle', HttpStatus.BAD_GATEWAY);
            }
        }

        const text = body.toString('utf-8');

        // Validate it actually looks like a subtitle. Without this an upstream HTML
        // error page would be wrapped in a WEBVTT header and served as a "subtitle",
        // and <track> would fail silently with no clue why.
        if (!text.includes('-->')) {
            this.logger.error(`Upstream returned a non-subtitle payload for ${src} (no cue timings)`);
            throw new HttpException('Upstream did not return a subtitle file', HttpStatus.BAD_GATEWAY);
        }

        const vtt = this.toVtt(text);
        try {
            await this.cacheManager.set(cacheKey, vtt, this.CACHE_TTL_MS);
        } catch {
            // non-fatal
        }
        return vtt;
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
