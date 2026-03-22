import { Controller, Get, Post, Body, Param, Query, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';
import { spawn } from 'child_process';
import axios from 'axios';
import { ProvidersService } from '../providers/providers.service';
import { HlsProxyService } from './hls-proxy.service';
import { HlsDownloadService } from './hls-download.service';
import { GetStreamsDto } from './dto/get-streams.dto';
import { PrefetchStreamsDto } from './dto/prefetch-streams.dto';

@Controller('streams')
export class StreamsController {
  constructor(
    private readonly providersService: ProvidersService,
    private readonly hlsProxyService: HlsProxyService,
    private readonly hlsDownloadService: HlsDownloadService,
  ) { }

  @Post('prefetch')
  async prefetch(@Body() data: PrefetchStreamsDto) {
    this.providersService.prefetchLinks(data.items);
    return { success: true, message: 'Prefetch started' };
  }

  @Get('hls-proxy')
  async proxy(
    @Query('url') url: string,
    @Query('headers') headers: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    return this.hlsProxyService.proxy(url, headers, req, res);
  }

  @Get('proxy') // Legacy support for old cached links
  async legacyProxy(
    @Query('url') url: string,
    @Query('headers') headers: string,
    @Req() req: Request,
    @Res() res: Response
  ) {
    return this.hlsProxyService.proxy(url, headers, req, res);
  }

  @Get('download')
  async downloadHls(
    @Query('url') url: string,
    @Query('headers') headers: string,
    @Query('filename') filename: string,
    @Res() res: Response
  ) {
    return this.hlsDownloadService.download(url, headers, filename || 'video', res);
  }

  @Get(':id')
  async getStreams(
    @Param('id') id: string,
    @Query() query: GetStreamsDto,
  ) {
    return this.providersService.findStreamLinks(
      id,
      query.season,
      query.episode,
      query.type,
      query.mediaType
    );
  }
}
