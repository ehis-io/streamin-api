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
     * GET /api/v1/subtitles/file?src=<encoded upstream url> -> WebVTT
     * `src` is host-allowlisted in the service to avoid an SSRF hole.
     */
    @Get('file')
    async file(@Query('src') src: string, @Res() res: Response) {
        const vtt = await this.subtitlesService.getFileAsVtt(src);
        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=21600'); // 6h, matches service TTL
        res.send(vtt);
    }
}
