import { Controller, Get, Post, Body, Param, Query, Res, Req, HttpException, HttpStatus } from '@nestjs/common';
import { Response, Request } from 'express';
import { spawn } from 'child_process';
import axios from 'axios';
import { ProvidersService } from '../providers/providers.service';
import { GetStreamsDto } from './dto/get-streams.dto';
import { PrefetchStreamsDto } from './dto/prefetch-streams.dto';

@Controller('streams')
export class StreamsController {
  constructor(private readonly providersService: ProvidersService) { }

  @Post('prefetch')
  async prefetch(@Body() data: PrefetchStreamsDto) {
    this.providersService.prefetchLinks(data.items);
    return { success: true, message: 'Prefetch started' };
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

  // @Get('proxy/download')
  // async downloadStream(
  //   @Query('url') url: string,
  //   @Query('filename') filename: string,
  //   @Query('headers') headersStr: string,
  //   @Res() res: Response,
  //   @Req() req: Request
  // ) {
  //   console.log('Proxy download URL:', url);
  //   if (!url) {
  //     throw new HttpException('URL is required', HttpStatus.BAD_REQUEST);
  //   }

  //   try {
  //     let headers: Record<string, string> = {
  //       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  //     };
  //     if (headersStr) {
  //       try {
  //         const parsed = JSON.parse(decodeURIComponent(headersStr));
  //         headers = { ...headers, ...parsed };
  //       } catch (e) {
  //         // ignore parsing error
  //       }
  //     }

  //     // Automatically handle M3U8 files using FFmpeg to stitch chunks into an MP4
  //     if (url.includes('.m3u8')) {
  //       res.setHeader('Content-Type', 'video/mp4');
  //       const safeFilename = filename ? filename.replace(/[^a-z0-9.-]/gi, '_').replace(/\.m3u8$/i, '.mp4') : 'download.mp4';

  //       // Ensure the filename ends with .mp4
  //       const finalFilename = safeFilename.endsWith('.mp4') ? safeFilename : `${safeFilename}.mp4`;
  //       res.setHeader('Content-Disposition', `attachment; filename="${finalFilename}"`);

  //       const ffmpegArgs = [];
  //       const headersArray = [];
  //       for (const [key, value] of Object.entries(headers)) {
  //         if (key.toLowerCase() !== 'user-agent') {
  //           headersArray.push(`${key}: ${value}`);
  //         }
  //       }

  //       if (headersArray.length > 0) {
  //         ffmpegArgs.push('-headers', headersArray.join('\r\n') + '\r\n');
  //       }

  //       const userAgent = headers['User-Agent'] || headers['user-agent'];
  //       if (userAgent) {
  //         ffmpegArgs.push('-user_agent', userAgent);
  //       }



  //       const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

  //       ffmpegProcess.stdout.pipe(res);

  //       ffmpegProcess.stderr.on('data', (data) => {
  //         console.error(`ffmpeg: ${data}`);
  //       });

  //       ffmpegProcess.on('close', (code) => {
  //         if (code !== 0 && code !== 255) {
  //           console.error(`ffmpeg process exited with code ${code}`);
  //         }
  //       });

  //       // Kill ffmpeg if the user cancels the download
  //       req.on('close', () => {
  //         if (!ffmpegProcess.killed) {
  //           ffmpegProcess.kill('SIGKILL');
  //         }
  //       });

  //       return;
  //     }

  //     if (url.includes('.m3u8')) {
  //         // ffmpeg code here
  //     }

  //     // DEBUG: If we reached here, M3U8 was false
  //     throw new HttpException(`DEBUG NOT M3U8: url is -> ${url}`, HttpStatus.BAD_REQUEST);

  //     /* temporarily comment out axios
  //     const response = await axios.get(url, {
  //       headers,
  //       responseType: 'stream',
  //       // Important: accept any encoding to avoid axios trying to decompress it
  //       decompress: false
  //     });

  //     // Set headers for download
  //     res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');

  //     const safeFilename = filename ? filename.replace(/[^a-z0-9.-]/gi, '_') : 'download.mp4';
  //     res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

  //     if (response.headers['content-length']) {
  //       res.setHeader('Content-Length', response.headers['content-length']);
  //     }

  //     // Pipe the stream
  //     response.data.pipe(res);
  //     */

  //   } catch (error: any) {
  //     // Log the exact error to the console for debugging
  //     console.error('Proxy download failed:', error.message, error.response?.status, error.response?.headers);

  //     throw new HttpException(
  //       {
  //         message: error.message || 'Failed to download stream',
  //         status: error.response?.status,
  //         data: error.response?.data?.toString()
  //       }, 
  //       error.response?.status || HttpStatus.INTERNAL_SERVER_ERROR
  //     );
  //   }
  // }
}
