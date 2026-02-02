import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import * as puppeteer from 'puppeteer';

@Injectable()
export class AnimePaheScraper implements Scraper {
    name = 'AnimePahe';
    priority = 10;
    private readonly logger = new Logger(AnimePaheScraper.name);
    private readonly baseUrl = 'https://animepahe.si';

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]> {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            // Set User-Agent to look like a real browser
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // 1. Go to homepage
            await page.goto(this.baseUrl, { waitUntil: 'networkidle2', timeout: 30000 });

            // 2. Click/Find search box and type
            const searchInputSelector = '.input-search';
            await page.waitForSelector(searchInputSelector, { timeout: 10000 });
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
        } catch (e) {
            this.logger.error(`AnimePahe Puppeteer search failed: ${e.message}`);
            return [];
        } finally {
            if (browser) await browser.close();
        }
    }

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]> {
        if (!episode || !episode.episode) return [];

        let browser;
        try {
            const session = url.split('/').pop();
            if (!session) return [];

            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
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
                    const pre = await page.evaluate(() => document.querySelector('pre')?.innerText);
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

            // 3. Extract Kwik Links
            // Wait for resolution buttons
            try {
                await page.waitForSelector('#resolutionMenu > button', { timeout: 5000 });
            } catch {
                this.logger.warn('Timeout waiting for resolution menu');
            }

            const links = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('#resolutionMenu > button'));
                return buttons.map(btn => ({
                    url: btn.getAttribute('data-src') || '',
                    quality: btn.textContent?.trim() || 'Unknown',
                    isM3U8: (btn.getAttribute('data-src') || '').includes('.m3u8')
                })).filter(l => l.url);
            });

            return links.map(l => ({
                ...l,
                headers: {
                    'Referer': 'https://kwik.cx/',
                    'Origin': 'https://kwik.cx'
                }
            }));

        } catch (e) {
            this.logger.error(`AnimePahe Puppeteer scraping failed: ${e.message}`);
            return [];
        } finally {
            if (browser) await browser.close();
        }
    }
}
