import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { getAbsoluteApiUrl } from '../../common/utils/config.utils';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';

@Injectable()
export class MirrorsScraper implements Scraper {
  name = 'MirrorResolver';
  priority = 1; // Low priority, usually called by others or as fallback
  private readonly logger = new Logger(MirrorsScraper.name);

  constructor(
    private puppeteerService: PuppeteerService,
    private configService: ConfigService
  ) {}

  async search(): Promise<ScraperSearchResult[]> {
    // This scraper doesn't search, it resolves
    return [];
  }

  async getStreamLinks(url: string, episode?: any, priority: number = 0): Promise<StreamLink[]> {
    const lowerUrl = url.toLowerCase();
    
    // Supported mirrors that have M3U8
    const isSupported = 
      lowerUrl.includes('streamwish') || 
      lowerUrl.includes('filemoon') || 
      lowerUrl.includes('voe.sx') || 
      lowerUrl.includes('doodstream') ||
      lowerUrl.includes('mixdrop') ||
      lowerUrl.includes('upstream');

    if (!isSupported) return [];

    this.logger.log(`Resolving mirror stream: ${url}`);

    return this.puppeteerService.withPage(async (page) => {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');
      
      const m3u8Links: StreamLink[] = [];
      let isResolved = false;

      page.on('request', (request) => {
        const reqUrl = request.url();
        if (reqUrl.includes('.m3u8')) {
          const headers = request.headers();
          const headersBase64 = Buffer.from(JSON.stringify(headers)).toString('base64');
          const apiUrl = getAbsoluteApiUrl(this.configService);

          
          m3u8Links.push({
            url: `${apiUrl}/api/v1/streams/hls-proxy?url=${encodeURIComponent(reqUrl)}&headers=${headersBase64}`,
            quality: 'Auto (Mirror)',
            isM3U8: true,
            headers: headers
          });
        }
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        
        // Active click to trigger
        await new Promise(r => setTimeout(r, 2000));
        await page.evaluate(() => {
          const playBtn = document.querySelector('#playbtn') || 
                          document.querySelector('.vjs-big-play-button') ||
                          document.querySelector('#player');
          if (playBtn) (playBtn as any).click();
          // Fallback click center
          document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }).catch(() => {});

        await new Promise(r => setTimeout(r, 2000));
      } catch (e) {
        this.logger.warn(`Mirror resolution failed for ${url}: ${e.message}`);
      }

      return m3u8Links;
    }, priority);
  }
}
