import { Controller, Get, Post, Delete, Body, Param, Query, Res, Req, HttpException, HttpStatus, Inject, Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ProvidersService } from '../providers/providers.service';
import { HlsProxyService } from './hls-proxy.service';
import { HlsDownloadService } from './hls-download.service';
import { PrismaService } from '../prisma/prisma.service';
import { GetStreamsDto } from './dto/get-streams.dto';
import { PrefetchStreamsDto } from './dto/prefetch-streams.dto';

@Controller('streams')
export class StreamsController {
  private readonly logger = new Logger(StreamsController.name);

  constructor(
    private readonly providersService: ProvidersService,
    private readonly hlsProxyService: HlsProxyService,
    private readonly hlsDownloadService: HlsDownloadService,
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) { }

  @Post('prefetch')
  async prefetch(@Body() data: PrefetchStreamsDto) {
    this.providersService.prefetchLinks(data.items);
    return { success: true, message: 'Prefetch started' };
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

  /**
   * Admin endpoint: purge all localhost-cached stream links from DB + Redis.
   * Call once after deploying to production to clear stale localhost URLs.
   * DELETE /api/v1/streams/cache/localhost
   */
  @Delete('cache/localhost')
  async purgeLocalhostCache() {
    this.logger.warn('Admin: Purging all localhost-cached stream links...');

    // 1. Delete from MongoDB - Deep purge of all stale patterns
    const result = await (this.prisma as any).streamedLink.deleteMany({
      where: {
        OR: [
          { url: { contains: 'localhost' } },
          { url: { startsWith: '/api' } },
          { url: { contains: 'api/v1/streams/hls-proxy' } }
        ]
      }
    });
    this.logger.log(`Deleted ${result.count} localhost link(s) from DB.`);

    // 2. Flush Redis (removes all stream keys including stale ones)
    try {
      await (this.cacheManager.stores as any)[0]?.reset?.();
      this.logger.log('Redis cache flushed.');
    } catch (e: any) {
      this.logger.warn(`Redis flush failed (may not be supported): ${e.message}`);
    }

    return {
      success: true,
      deletedFromDb: result.count,
      message: 'Stale localhost cache entries purged. Re-deploy and restart the backend if API_URL is not yet updated.',
    };
  }
}
