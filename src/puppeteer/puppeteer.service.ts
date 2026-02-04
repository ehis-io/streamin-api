import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: Browser | null = null;
  private readonly maxPages = 3; // Keep it low to avoid OOM
  private activePages = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor() {
    puppeteer.use(StealthPlugin());
  }

  async onModuleInit() {
    await this.ensureBrowser();
  }

  async onModuleDestroy() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async ensureBrowser() {
    if (this.browser) {
      try {
        await this.browser.version();
        return;
      } catch (e) {
        this.logger.warn('Browser instance is disconnected or crashed, restarting...');
        this.browser = null;
      }
    }

    try {
      this.browser = await (puppeteer as any).launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--no-first-run',
        ],
      }) as Browser;
      this.logger.log('Puppeteer browser launched successfully');
    } catch (error) {
      this.logger.error(`Failed to launch browser: ${error.message}`);
      throw error;
    }
  }

  async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    if (this.activePages >= this.maxPages) {
      this.logger.debug(`Max pages reached (${this.maxPages}). Queuing request...`);
      await new Promise<void>((resolve) => {
        this.queue.push(async () => {
          resolve();
        });
      });
    }

    this.activePages++;
    await this.ensureBrowser();

    let page: Page | null = null;
    try {
      page = await this.browser!.newPage();
      
      // Speed Optimization: Block unnecessary resources and ads/tracking
      await page.setRequestInterception(true);
      
      const blockedResources = ['image', 'stylesheet', 'font', 'media'];
      const blockedDomains = [
        'google-analytics.com',
        'googletagmanager.com',
        'doubleclick.net',
        'onesignal.com',
        'adsbygoogle',
        'crashlytics.com',
        'facebook.net'
      ];

      page.on('request', (request) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();

        if (
          blockedResources.includes(resourceType) ||
          blockedDomains.some(domain => url.includes(domain))
        ) {
          request.abort();
        } else {
          request.continue();
        }
      });

      // Set reasonable default timeouts
      page.setDefaultNavigationTimeout(30000);
      page.setDefaultTimeout(30000);
      
      return await fn(page);
    } catch (error) {
      this.logger.error(`Error during Puppeteer task: ${error.message}`);
      throw error;
    } finally {
      if (page) {
        await page.close().catch(e => this.logger.warn(`Failed to close page: ${e.message}`));
      }
      this.activePages--;
      this.processQueue();
    }
  }

  private processQueue() {
    if (this.queue.length > 0 && this.activePages < this.maxPages) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }
}
