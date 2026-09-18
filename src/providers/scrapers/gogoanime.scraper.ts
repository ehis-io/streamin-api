import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import { IframeResolverService } from '../iframe-resolver.service';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class GogoAnimeScraper implements Scraper {
    name = 'GogoAnime';
    priority = 15;
    supportedTypes = ['anime', 'tv'];
    private readonly logger = new Logger(GogoAnimeScraper.name);
    private readonly baseUrl = 'https://gogoanime.by';
    constructor(private configService: ConfigService, private iframeResolver: IframeResolverService) { }
    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    };

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
        this.logger.log(`Searching for anime: ${query} [Priority: ${priority}]`);
        try {
            const searchUrl = `${this.baseUrl}/?s=${encodeURIComponent(query).replace(/%20/g, '+')}`;
            this.logger.log(`GogoAnime searching: ${searchUrl}`);

            const response = await axios.get(searchUrl, {
                headers: this.headers,
                timeout: 15000
            });

            const $ = cheerio.load(response.data);
            const results: ScraperSearchResult[] = [];

            // Parse search results from a.tip elements
            $('a.tip').each((_, element) => {
                const $elem = $(element);

                // Get title from .tt.tts or title attribute
                const title = ($elem.find('.tt.tts').text()?.trim() || $elem.attr('title')?.trim())?.replace(/\s+/g, ' ');

                // Get poster image
                const poster = $elem.find('img').attr('src');

                // Get URL
                let url = $elem.attr('href');

                if (url && title) {
                    // Make URL absolute if it's relative
                    if (!url.startsWith('http')) {
                        url = this.baseUrl + url;
                    }

                    results.push({
                        title,
                        url,
                        poster: poster || undefined
                    });
                }
            });

            this.logger.log(`GogoAnime found ${results.length} results for: ${query}`);
            return results;

        } catch (e) {
            this.logger.error(`GogoAnime search failed: ${e.message}`);
            return [];
        }
    }

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
        if (!episode || !episode.episode) return [];

        try {
            let slug = '';
            if (url.includes('/series/')) {
                slug = url.split('/series/')[1].split('/')[0];
            } else if (url.includes('/category/')) {
                slug = url.split('/category/')[1].split('/')[0];
            } else {
                const lastPart = url.split('/').filter(Boolean).pop() || '';
                if (lastPart.includes('-episode-')) {
                    slug = lastPart.replace(/-episode-\d+(-english-(subbed|dubbed))?$/, '');
                } else {
                    slug = lastPart;
                }
            }

            slug = slug.replace(/-(eng|dub|sub)$/, '');

            // Fetch both sub and dub in parallel for better performance and complete results
            // This addresses the user suggestion to "scrap both subbed and dubbed links"
            const subUrl = `${this.baseUrl}/${slug}-episode-${episode.episode}-english-subbed`;
            const dubUrl = `${this.baseUrl}/${slug}-episode-${episode.episode}-english-dubbed`;

            const results = await Promise.all([
                this.extractFromPage(subUrl, 'sub', priority).catch(() => []),
                this.extractFromPage(dubUrl, 'dub', priority).catch(() => [])
            ]);

            const allLinks = results.flat();
            this.logger.log(`GogoAnime found ${allLinks.length} total links (${results[0].length} sub, ${results[1].length} dub) for episode ${episode.episode}`);

            return allLinks;

        } catch (e) {
            this.logger.error(`GogoAnime scraping failed: ${e.message}`);
            return [];
        }
    }

    /**
     * Each server on an episode page is a `.player-type-link` whose `data-src` points at
     * gogoanime.by/player/, which wraps the real embed (e.g. megavid.buzz) in an iframe.
     * The player page 403s without a gogoanime Referer, and the embed only plays when
     * framed by it, so the browser can't iframe either from our origin. Instead we load
     * the player page in Puppeteer with that Referer and return the HLS stream it
     * requests (proxied downstream, since it carries the embed's Referer).
     */
    private async extractFromPage(url: string, type: 'sub' | 'dub', priority: number): Promise<StreamLink[]> {
        let pageData: string;
        try {
            // Episode URLs 301 to their trailing-slash form; request that directly.
            const response = await axios.get(url.replace(/\/?$/, '/'), { headers: this.headers, timeout: 30000 });
            pageData = response.data;
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) return [];
            throw e;
        }

        const $ = cheerio.load(pageData);
        const servers = $('.player-type-link')
            .map((_, el) => ({ playerUrl: $(el).attr('data-src'), name: $(el).text().trim() || 'Server' }))
            .get()
            // Blogger serves an IP-bound googlevideo file rather than an embed; skip it.
            .filter(s => s.playerUrl?.startsWith('http') && !s.playerUrl.includes('source=blogger'));

        const results = await Promise.all(servers.map(async ({ playerUrl, name }) => {
            const links = await this.iframeResolver.resolve(playerUrl!, priority, `${this.baseUrl}/`);
            return links.map(l => ({ ...l, quality: name, type }));
        }));

        return results.flat();
    }
}
