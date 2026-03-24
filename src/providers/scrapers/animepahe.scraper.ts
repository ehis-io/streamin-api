import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { PuppeteerService } from '../../puppeteer/puppeteer.service';
import { getAbsoluteApiUrl } from '../../common/utils/config.utils';

@Injectable()
export class AnimePaheScraper implements Scraper {
    name = 'AnimePahe';
    priority = 10;
    private readonly logger = new Logger(AnimePaheScraper.name);
    private readonly baseUrl = 'https://animepahe.si';

    constructor(private puppeteerService: PuppeteerService, private configService: ConfigService) { }

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
        return this.puppeteerService.withPage(async (page) => {
            // Set User-Agent to look like a real browser
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // 1. Go to homepage
            await page.goto(this.baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // 2. Click/Find search box and type
            const searchInputSelector = '.input-search';
            await page.waitForSelector(searchInputSelector, { timeout: 30000 });
            await page.click(searchInputSelector);
            await page.type(searchInputSelector, query, { delay: 100 });

            // 3. Wait for results to appear in the wrap
            const resultsWrapSelector = '.search-results-wrap';
            await page.waitForFunction((selector) => {
                const wrap = document.querySelector(selector);
                return wrap && wrap.children.length > 0;
            }, { timeout: 15000 }, resultsWrapSelector);

            // 4. Extract results from the popup
            const results = await page.evaluate((baseUrl) => {
                const items = Array.from(document.querySelectorAll('.search-results-wrap a'));
                return items.map(item => {
                    const title = item.textContent?.trim();
                    let url = item.getAttribute('href');
                    if (url && !url.startsWith('http')) {
                        // URL usually looks like /anime/session-id
                        url = baseUrl + url;
                    }
                    const poster = item.querySelector('img')?.getAttribute('src');

                    if (title && url) {
                        return { title, url, poster };
                    }
                    return null;
                }).filter(i => i !== null);
            }, this.baseUrl);

            return results as ScraperSearchResult[];
        }, priority).catch(e => {
            this.logger.error(`AnimePahe Puppeteer search failed: ${e.message}`);
            return [];
        });
    }

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
        if (!episode || !episode.episode) return [];

        return this.puppeteerService.withPage(async (page) => {
            const session = url.split('/').pop();
            if (!session) return [];

            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // 1. Get Episode Session
            // We use the API via Puppeteer to bypass CF
            // Loop pages to find episode
            let targetEpisodeSession = '';
            let pageNum = 1;
            let found = false;

            while (!found && pageNum <= 5) {
                const epApiUrl = `${this.baseUrl}/api?m=release&id=${session}&sort=episode_asc&page=${pageNum}`;
                await page.goto(epApiUrl, { waitUntil: 'networkidle0' }); // fast load for API

                const content = await page.evaluate(() => document.body.innerText);
                let epData;
                try {
                    epData = JSON.parse(content);
                } catch {
                    const pre = await page.evaluate(() => (document.querySelector('pre') as any)?.innerText);
                    if (pre) epData = JSON.parse(pre);
                }

                if (!epData || !epData.data) break;

                const episodes = epData.data;
                const target = episodes.find((ep: any) => ep.episode === episode.episode);

                if (target) {
                    targetEpisodeSession = target.session;
                    found = true;
                } else {
                    if (epData.last_page === pageNum) break;
                    pageNum++;
                }
            }

            if (!targetEpisodeSession) {
                this.logger.warn(`AnimePahe: Episode ${episode.episode} not found via Puppeteer`);
                return [];
            }

            // 2. Get Stream Page
            const playUrl = `${this.baseUrl}/play/${session}/${targetEpisodeSession}`;
            this.logger.log(`Puppeteer loading play page: ${playUrl}`);
            await page.goto(playUrl, { waitUntil: 'domcontentloaded' });

            const m3u8Links: StreamLink[] = [];
            page.on('request', (request) => {
                const reqUrl = request.url();
                if (reqUrl.includes('.m3u8')) {
                    const headers = request.headers();
                    const headersBase64 = Buffer.from(JSON.stringify(headers)).toString('base64');
                    const apiUrl = getAbsoluteApiUrl(this.configService);

                    m3u8Links.push({
                        url: `${apiUrl}/api/v1/streams/hls-proxy?url=${encodeURIComponent(reqUrl)}&headers=${headersBase64}`,
                        quality: 'Auto (Captured)',
                        isM3U8: true,
                        headers: headers
                    });
                }
            });

            // 3. Try to trigger player
            try {
                await page.waitForSelector('#resolutionMenu > button', { timeout: 5000 });
                // Click the first resolution button to trigger M3U8
                await page.click('#resolutionMenu > button');
                await new Promise(r => setTimeout(r, 4000));
            } catch {
                this.logger.warn('Timeout waiting for resolution menu in AnimePahe');
            }

            const links = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('#resolutionMenu > button'));
                return buttons.map(btn => ({
                    url: btn.getAttribute('data-src') || '',
                    quality: btn.textContent?.trim() || 'Unknown',
                    isM3U8: (btn.getAttribute('data-src') || '').includes('.m3u8')
                })).filter(l => l.url);
            });

            // Merge captured M3U8s with evaluated links
            const finalLinks: StreamLink[] = [...(links as StreamLink[])];
            m3u8Links.forEach(m => {
                const mUrlPart = m.url.split('url=')[1]?.split('&')[0] || '';
                if (!finalLinks.some(l => l.url.includes(encodeURIComponent(mUrlPart)))) {
                    finalLinks.push({
                        url: m.url,
                        quality: m.quality || 'Auto',
                        isM3U8: true,
                        headers: m.headers
                    });
                }
            });
            return finalLinks;
        }, priority).catch(e => {
            this.logger.error(`AnimePahe Puppeteer scraping failed: ${e.message}`);
            return [];
        });
    }
}
