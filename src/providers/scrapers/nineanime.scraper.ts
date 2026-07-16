import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * Scraper for 9anime.or.at (WordPress "9animetv" theme).
 *
 * Flow:
 *  - search: GET /?s=<query> renders `.flw-item` result cards linking to /anime/<slug>/
 *  - episode pages live at /<slug>-episode-<n>-english-(subbed|dubbed)/ and expose the
 *    current episode id via `data-active="<id>"`
 *  - GET /ajax/episode/servers/?id=<episodeId> returns JSON whose `html` contains
 *    `.server-item` elements; each carries `data-type` (sub|dub) and a base64
 *    `data-embed` that decodes to the player URL (e.g. https://my.1anime.site/?action=play&file=<name>.mp4)
 *  - that player's `?file=<name>.mp4` maps to a directly-fetchable, range-seekable
 *    MP4 at https://<host>/videos/<name>.mp4, so we return that direct URL (no
 *    Puppeteer resolution needed). Unknown embed hosts are returned as-is so the
 *    IframeResolverService can still deep-resolve them.
 */
@Injectable()
export class NineAnimeScraper implements Scraper {
    name = 'NineAnime';
    priority = 14;
    supportedTypes = ['anime', 'tv'];
    private readonly logger = new Logger(NineAnimeScraper.name);
    private readonly baseUrl = 'https://9anime.or.at';

    constructor(private configService: ConfigService) { }

    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    };

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number, priority: number = 0, mediaType?: string): Promise<ScraperSearchResult[]> {
        this.logger.log(`Searching for anime: ${query} [Priority: ${priority}]`);
        try {
            const searchUrl = `${this.baseUrl}/?s=${encodeURIComponent(query).replace(/%20/g, '+')}`;
            const response = await axios.get(searchUrl, { headers: this.headers, timeout: 15000 });

            const $ = cheerio.load(response.data);
            const results: ScraperSearchResult[] = [];

            $('.film_list-wrap .flw-item').each((_, element) => {
                const $elem = $(element);
                const $link = $elem.find('.film-name a').first();

                const title = ($link.text()?.trim() || $link.attr('title')?.trim())?.replace(/\s+/g, ' ');
                let url = $link.attr('href') || $elem.find('a.film-poster-ahref').attr('href');
                const poster = $elem.find('img.film-poster-img').attr('data-src')
                    || $elem.find('img.film-poster-img').attr('src');

                if (url && title) {
                    if (!url.startsWith('http')) url = this.baseUrl + url;
                    results.push({ title, url, poster: poster || undefined });
                }
            });

            this.logger.log(`NineAnime found ${results.length} results for: ${query}`);
            return results;
        } catch (e) {
            this.logger.error(`NineAnime search failed: ${e.message}`);
            return [];
        }
    }

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }, priority: number = 0): Promise<StreamLink[]> {
        if (!episode || !episode.episode) return [];

        try {
            const slug = this.deriveSlug(url);
            if (!slug) {
                this.logger.warn(`NineAnime: could not derive slug from ${url}`);
                return [];
            }

            // Fetch both sub and dub episode pages in parallel (dub may 404 → []).
            const subUrl = `${this.baseUrl}/${slug}-episode-${episode.episode}-english-subbed/`;
            const dubUrl = `${this.baseUrl}/${slug}-episode-${episode.episode}-english-dubbed/`;

            const results = await Promise.all([
                this.extractFromEpisodePage(subUrl).catch(() => []),
                this.extractFromEpisodePage(dubUrl).catch(() => []),
            ]);

            // Dedupe by embed URL (a page can list overlapping servers).
            const seen = new Set<string>();
            const allLinks = results.flat().filter(l => (seen.has(l.url) ? false : seen.add(l.url)));

            this.logger.log(`NineAnime found ${allLinks.length} links (${results[0].length} sub, ${results[1].length} dub) for episode ${episode.episode}`);
            return allLinks;
        } catch (e) {
            this.logger.error(`NineAnime scraping failed: ${e.message}`);
            return [];
        }
    }

    /** Pull the anime slug out of a /anime/<slug>/ url (or a bare episode url as a fallback). */
    private deriveSlug(url: string): string | null {
        if (url.includes('/anime/')) {
            return url.split('/anime/')[1].split('/').filter(Boolean)[0] || null;
        }
        const last = url.split('/').filter(Boolean).pop() || '';
        const m = last.match(/^(.*)-episode-\d+-english-(subbed|dubbed)$/);
        return m ? m[1] : (last || null);
    }

    private async extractFromEpisodePage(epUrl: string): Promise<StreamLink[]> {
        let pageData: string;
        try {
            const response = await axios.get(epUrl, { headers: this.headers, timeout: 20000 });
            pageData = response.data;
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) return [];
            throw e;
        }

        // The current episode id is exposed as data-active="<id>" on the episodes section.
        const idMatch = pageData.match(/data-active="(\d+)"/) || pageData.match(/episodeId\s*:\s*(\d+)/);
        if (!idMatch) return [];
        const episodeId = idMatch[1];

        // NOTE: the trailing slash matters — /ajax/episode/servers?id= 301-redirects.
        const serversRes = await axios.get(`${this.baseUrl}/ajax/episode/servers/?id=${episodeId}`, {
            headers: { ...this.headers, 'X-Requested-With': 'XMLHttpRequest', 'Referer': epUrl },
            timeout: 15000,
        });

        const html: string | undefined = serversRes.data?.html;
        if (!html) return [];

        const $ = cheerio.load(html);
        const links: StreamLink[] = [];

        $('.server-item').each((_, element) => {
            const $elem = $(element);
            const type = ($elem.attr('data-type') === 'dub' ? 'dub' : 'sub') as 'sub' | 'dub';
            const serverName = $elem.find('a').text().trim() || 'Server';
            const embedB64 = $elem.attr('data-embed');
            if (!embedB64) return;

            let embed = '';
            try {
                embed = Buffer.from(embedB64, 'base64').toString('utf-8');
            } catch {
                return;
            }
            if (!embed.startsWith('http')) return;

            const direct = this.toDirectMedia(embed);
            links.push({
                url: direct || embed,
                quality: serverName,
                isM3U8: (direct || embed).includes('.m3u8'),
                type,
                // The direct /videos/ file is openly fetchable (verified: 206 + Range
                // support with no Referer), so deliberately send NO headers — attaching
                // a Referer would flag it as needing the proxy, and proxying it would
                // cost a hop and break seeking for no benefit. The embed fallback still
                // needs the Referer.
                ...(direct ? {} : { headers: { 'Referer': `${this.baseUrl}/`, 'Origin': this.baseUrl } }),
            });
        });

        return links;
    }

    /**
     * The player embed `https://<host>/?action=play&file=<name>` maps to a direct,
     * range-seekable file at `https://<host>/videos/<name>`. Convert it so we return a
     * playable/proxyable URL instead of an iframe. Returns null for unrecognized embeds.
     */
    private toDirectMedia(embed: string): string | null {
        try {
            const u = new URL(embed);
            const file = u.searchParams.get('file');
            if (u.searchParams.get('action') === 'play' && file) {
                return `${u.origin}/videos/${file}`;
            }
        } catch {
            // fall through
        }
        return null;
    }
}
