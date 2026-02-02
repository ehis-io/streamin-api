import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class GogoAnimeScraper implements Scraper {
    name = 'GogoAnime';
    priority = 15;
    supportedTypes = ['anime', 'tv'];
    private readonly logger = new Logger(GogoAnimeScraper.name);
    private readonly baseUrl = 'https://gogoanime.by';
    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1'
    };

    async search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]> {
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

    async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]> {
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
                this.extractFromPage(subUrl, 'sub').catch(() => []),
                this.extractFromPage(dubUrl, 'dub').catch(() => [])
            ]);

            const allLinks = results.flat();
            this.logger.log(`GogoAnime found ${allLinks.length} total links (${results[0].length} sub, ${results[1].length} dub) for episode ${episode.episode}`);

            return allLinks;

        } catch (e) {
            this.logger.error(`GogoAnime scraping failed: ${e.message}`);
            return [];
        }
    }

    private async extractFromPage(url: string, type: 'sub' | 'dub'): Promise<StreamLink[]> {
        try {
            const response = await axios.get(url, {
                headers: this.headers,
                timeout: 10000
            });

            const $ = cheerio.load(response.data);
            const streamLinks: StreamLink[] = [];

            // Method 1: Extract from .player-type-link elements (newer structure)
            $('.player-type-link').each((_, element) => {
                const $elem = $(element);
                const serverType = $elem.attr('data-type');
                const serverName = $elem.text().trim() || 'Unknown Server';

                const encryptedUrl1 = $elem.attr('data-encrypted-url1');
                const encryptedUrl2 = $elem.attr('data-encrypted-url2');
                const encryptedUrl3 = $elem.attr('data-encrypted-url3');
                const dataRef = $elem.attr('data-ref');

                if (encryptedUrl1 && serverType) {
                    const params = new URLSearchParams();
                    params.append(serverType, encryptedUrl1);
                    if (encryptedUrl2) params.append('url2', encryptedUrl2);
                    if (encryptedUrl3) params.append('url3', encryptedUrl3);
                    params.append('ref', dataRef || this.baseUrl);
                    params.append('feature_image', url);
                    params.append('user_agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36');

                    const playerUrl = `https://9animetv.be/wp-content/plugins/video-player/includes/player/player.php?${params.toString()}`;

                    streamLinks.push({
                        url: playerUrl,
                        quality: serverName,
                        isM3U8: false,
                        type,
                        headers: {
                            'Referer': this.baseUrl,
                            'Origin': this.baseUrl
                        }
                    });
                }
            });

            // Method 2: Extract from traditional .anime_muti_link structure (fallback)
            if (streamLinks.length === 0) {
                $('.anime_muti_link ul li a').each((_, element) => {
                    const $elem = $(element);
                    const dataVideo = $elem.attr('data-video');
                    const serverName = $elem.text()?.replace('Choose this server', '').trim() || 'Unknown Server';

                    if (dataVideo) {
                        const videoUrl = dataVideo.startsWith('//') ? 'https:' + dataVideo : dataVideo;
                        streamLinks.push({
                            url: videoUrl,
                            quality: serverName,
                            isM3U8: videoUrl.includes('.m3u8'),
                            type,
                            headers: {
                                'Referer': this.baseUrl,
                                'Origin': this.baseUrl
                            }
                        });
                    }
                });
            }

            // Method 3: Extract iframe src directly (last resort)
            if (streamLinks.length === 0) {
                const iframeSrc = $('#player iframe, .player-embed iframe, .video-player iframe').attr('src');
                if (iframeSrc) {
                    streamLinks.push({
                        url: iframeSrc,
                        quality: 'Main Server',
                        isM3U8: iframeSrc.includes('.m3u8'),
                        type,
                        headers: {
                            'Referer': this.baseUrl,
                            'Origin': this.baseUrl
                        }
                    });
                }
            }

            return streamLinks;
        } catch (e) {
            if (axios.isAxiosError(e) && e.response?.status === 404) {
                return [];
            }
            throw e;
        }
    }
}
