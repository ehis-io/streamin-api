import { Controller, Get, Query, Res, ParseIntPipe, DefaultValuePipe } from '@nestjs/common';
import { Response } from 'express';
import { SubtitlesService } from './subtitles.service';

@Controller('subtitles')
export class SubtitlesController {
    constructor(private readonly subtitlesService: SubtitlesService) { }

    /**
     * GET /api/v1/subtitles/search?tmdbId=123[&season=1&episode=2][&language=en]
     * -> { results: [{ id, language, display, url }] }  (url is relative)
     */
    @Get('search')
    async search(
        @Query('tmdbId', ParseIntPipe) tmdbId: number,
        @Query('season') season?: string,
        @Query('episode') episode?: string,
        @Query('language') language?: string,
    ) {
        const s = season !== undefined && season !== '' ? Number(season) : undefined;
        const e = episode !== undefined && episode !== '' ? Number(episode) : undefined;
        return this.subtitlesService.search(
            tmdbId,
            Number.isNaN(s as number) ? undefined : s,
            Number.isNaN(e as number) ? undefined : e,
            language || 'en',
        );
    }

    /**
     * GET /api/v1/subtitles/file?src=<encoded upstream url>&sig=<hmac> -> WebVTT
     * `src` is caller-controlled, so only signatures issued by /search are honoured
     * (see SubtitlesService.signingSecret) — otherwise this would be an SSRF hole.
     */
    @Get('file')
    async file(@Query('src') src: string, @Query('sig') sig: string, @Res() res: Response) {
        const vtt = await this.subtitlesService.getFileAsVtt(src, sig);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=21600'); // 6h, matches service TTL
        res.send(vtt);
    }
}
