import { Controller, Post, Body, Get, Param } from '@nestjs/common';
import { PlaylistsService } from './playlists.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('Playlists')
@Controller('playlists')
export class PlaylistsController {
    constructor(private readonly playlistsService: PlaylistsService) { }

    @Post('generate')
    @ApiOperation({ summary: 'Generate a playlist using AI' })
    async generate(@Body('prompt') prompt: string) {
        return this.playlistsService.generateFromPrompt(prompt);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a playlist by ID' })
    async get(@Param('id') id: string) {
        return this.playlistsService.getById(id);
    }
}
