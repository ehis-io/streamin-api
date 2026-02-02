import { Injectable, Logger } from '@nestjs/common';
import { Scraper, ScraperSearchResult, StreamLink } from '../scraper.interface';
import axios from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class SimpleScraper implements Scraper {
  name = 'SimpleScraper';
  priority = 5;
  private readonly logger = new Logger(SimpleScraper.name);

  // Define our providers for 2026
  private providers = [
    { name: 'VidSrc', searchUrl: (q) => `https://vidsrc.to/search/${encodeURIComponent(q)}`, selector: '.movie-item a' },
    { name: 'VidLink', searchUrl: (q) => `https://vidlink.pro/search?q=${encodeURIComponent(q)}`, selector: '.result-card a' },
    { name: 'AutoEmbed', searchUrl: (q) => `https://autoembed.to/movie/${encodeURIComponent(q)}`, selector: 'a.play-link' }
  ];

  async search(query: string, tmdbId?: number, imdbId?: string, malId?: number): Promise<ScraperSearchResult[]> {
    this.logger.log(`Searching for "${query}"`);
    const results: ScraperSearchResult[] = [];

    for (const provider of this.providers) {
      try {
        // FAST SEARCH: Cheerio
        const { data } = await axios.get(provider.searchUrl(query), { timeout: 5000 });
        const $ = cheerio.load(data);
        const movieUrl = $(provider.selector).first().attr('href');

        if (movieUrl) {
          const fullUrl = movieUrl.startsWith('http') ? movieUrl : `https://${provider.name.toLowerCase()}.to${movieUrl}`;
          results.push({
            title: query,
            url: fullUrl
          });
          break; // Return first successful result
        }
      } catch (err) {
        this.logger.warn(`${provider.name} search failed: ${err.message}`);
      }
    }

    return results;
  }

  async getStreamLinks(url: string, episode?: { season?: number, episode: number, type?: 'sub' | 'dub' }): Promise<StreamLink[]> {
    this.logger.log(`SimpleScraper: Skipping puppeteer extraction for ${url}`);
    // SimpleScraper is disabled for now due to puppeteer dependency issues
    // Return empty array to let other scrapers handle it
    return [];
  }
}