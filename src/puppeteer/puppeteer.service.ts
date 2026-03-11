import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, Page } from 'puppeteer';

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: Browser | null = null;
  private readonly maxPages: number;
  private activePages = 0;
  private readonly pagePool: { page: Page; context: any }[] = [];
  private queue: { priority: number; resolve: (val: { page: Page; context: any }) => void }[] = [];

  private readonly proxyUrls: string[];
  private proxyIndex = 0;

  constructor(private configService: ConfigService) {
    puppeteer.use(StealthPlugin());
    this.maxPages = this.configService.get<number>('PUPPETEER_MAX_PAGES', 10);

    const proxyConfig = this.configService.get<string>('PROXY_URLS', '');
    this.proxyUrls = proxyConfig
      ? proxyConfig.split(',').map(u => u.trim()).filter(Boolean)
      : [];
    if (this.proxyUrls.length > 0) {
      this.logger.log(`Proxy rotation enabled with ${this.proxyUrls.length} proxies`);
    }
  }

  private getNextProxy(): string | null {
    if (this.proxyUrls.length === 0) return null;
    const proxy = this.proxyUrls[this.proxyIndex % this.proxyUrls.length];
    this.proxyIndex++;
    return proxy;
  }

  async onModuleInit() {
    await this.ensureBrowser();
    // Pre-warm the pool with a couple of pages
    this.logger.log('Pre-warming Puppeteer page pool...');
    for (let i = 0; i < 2; i++) {
      const warmed = await this.createNewPage();
      if (warmed) this.pagePool.push(warmed);
    }
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
        this.pagePool.length = 0; // Clear stale pool
      }
    }

    try {
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--no-first-run',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-features=Translate,OptimizationHints,MediaRouter,DefaultBrowserFreeOfferPrompt',
        '--blink-settings=imagesEnabled=false',
        '--js-flags="--max-old-space-size=256"'
      ];

      const proxy = this.getNextProxy();
      if (proxy) {
        launchArgs.push(`--proxy-server=${proxy}`);
        this.logger.log(`Launching browser with proxy: ${proxy}`);
      }

      this.browser = await (puppeteer as any).launch({
        headless: true,
        args: launchArgs,
      }) as Browser;
      this.logger.log('Puppeteer browser launched successfully');
    } catch (error) {
      this.logger.error(`Failed to launch browser: ${error.message}`);
      throw error;
    }
  }

  private async createNewPage(): Promise<{ page: Page; context: any } | null> {
    try {
      await this.ensureBrowser();
      const context = await this.browser!.createBrowserContext();
      const page = await context.newPage();

      await page.setRequestInterception(true);
      const blockedResources = ['image', 'stylesheet', 'font', 'media', 'other', 'manifest', 'texttrack', 'eventsource', 'websocket'];
      const blockedDomains = [
        'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
        'onesignal.com', 'adsbygoogle', 'crashlytics.com', 'facebook.net',
        'cloudfront.net', 'hotjar.com', 'sentry.io', 'mixpanel.com',
        'amazon-adsystem.com', 'adnxs.com', 'pubmatic.com', 'rubiconproject.com'
      ];

      page.on('request', (request) => {
        const url = request.url().toLowerCase();
        const resourceType = request.resourceType();
        if (url.includes('.m3u8')) {
          request.continue();
          return;
        }
        if (blockedResources.includes(resourceType) || blockedDomains.some(domain => url.includes(domain))) {
          request.abort();
        } else {
          request.continue();
        }
      });

      page.setDefaultNavigationTimeout(30000);
      page.setDefaultTimeout(30000);

      return { page, context };
    } catch (e) {
      this.logger.error(`Failed to create new page: ${e.message}`);
      return null;
    }
  }

  async withPage<T>(fn: (page: Page) => Promise<T>, priority: number = 0): Promise<T> {
    let pageObj: { page: Page; context: any } | null = null;

    if (this.pagePool.length > 0) {
      pageObj = this.pagePool.shift()!;
      this.activePages++;
    } else if (this.activePages < this.maxPages) {
      this.activePages++;
      pageObj = await this.createNewPage();
    }

    if (!pageObj) {
      this.logger.debug(`No pages available. Queuing request with priority ${priority}...`);
      pageObj = await new Promise<{ page: Page; context: any }>((resolve) => {
        this.queue.push({ priority, resolve });
        this.queue.sort((a, b) => a.priority - b.priority);
      });
      this.activePages++;
    }

    try {
      return await fn(pageObj.page);
    } catch (error) {
      this.logger.error(`Error during Puppeteer task: ${error.message}`);
      throw error;
    } finally {
      // Reset the page instead of closing it
      try {
        const { page } = pageObj;
        // Clean up listeners from the previous task
        page.removeAllListeners('request');
        // RE-ATTACH the blocking listener
        page.on('request', (request) => {
          const url = request.url().toLowerCase();
          const resourceType = request.resourceType();
          if (url.includes('.m3u8')) { request.continue(); return; }
          if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType)) {
            request.abort();
          } else {
            request.continue();
          }
        });

        await page.goto('about:blank');
        const client = await (page as any).target().createCDPSession();
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');

        this.pagePool.push(pageObj);
      } catch (resetError) {
        this.logger.warn(`Failed to reset page, closing it instead: ${resetError.message}`);
        await pageObj.context.close().catch(() => { });
      }

      this.activePages--;
      this.processQueue();
    }
  }

  private processQueue() {
    if (this.queue.length > 0 && (this.pagePool.length > 0 || this.activePages < this.maxPages)) {
      const { resolve } = this.queue.shift()!;

      let pageObj: { page: Page; context: any } | null = null;
      if (this.pagePool.length > 0) {
        pageObj = this.pagePool.shift()!;
      }

      if (pageObj) {
        resolve(pageObj);
      } else {
        // If no pooled page but we have capacity, it will be handled by the next tick of withPage's queue processing
        // Actually, we should create it here if we have capacity
        this.createNewPage().then(p => {
          if (p) resolve(p);
        });
      }
    }
  }
}
