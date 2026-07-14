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
  private queue: { priority: number; resolve: (val: { page: Page; context: any }) => void; reject: (err: any) => void }[] = [];
  private activeTasks = new Set<{ pageObj: { page: Page; context: any }, priority: number }>();

  private readonly proxyUrls: string[];
  private proxyIndex = 0;

  constructor(private configService: ConfigService) {
    puppeteer.use(StealthPlugin());
    this.maxPages = this.configService.get<number>('PUPPETEER_MAX_PAGES', 6);

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
    // Pre-warm the pool with more pages to handle initial bursts
    const prewarmCount = Math.min(6, this.maxPages);
    this.logger.log(`Pre-warming Puppeteer page pool (${prewarmCount} pages)...`);
    const warmTasks = Array(prewarmCount).fill(null).map(() => this.createNewPage());
    const results = await Promise.all(warmTasks);
    results.forEach(warmed => {
      if (warmed) this.pagePool.push(warmed);
    });
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
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-breakpad',
        '--disable-client-side-phishing-detection',
        '--disable-default-apps',
        '--disable-hang-monitor',
        '--disable-ipc-flooding-protection',
        '--disable-notifications',
        '--disable-prompt-on-repost',
        '--disable-renderer-backgrounding',
        '--disable-sync',
        '--force-color-profile=srgb',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-features=Translate,OptimizationHints,MediaRouter,DefaultBrowserFreeOfferPrompt,IsolateOrigins,site-per-process',
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
        protocolTimeout: 300000, // 5 minutes
        timeout: 60000, // 1 minute launch timeout
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
      const blockedResources = ['image', 'stylesheet', 'font', 'manifest', 'texttrack', 'eventsource', 'websocket', 'media', 'other'];
      const blockedDomains = [
        'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
        'onesignal.com', 'adsbygoogle', 'crashlytics.com', 'facebook.net'
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

      // 🛡️ Global Stealth & Anti-Ad settings (applied once per page)
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        (window as any).open = () => null;
        (window as any).alert = () => {};
        (window as any).confirm = () => true;
        (window as any).prompt = () => null;
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      );

      page.setDefaultNavigationTimeout(60000);
      page.setDefaultTimeout(60000);

      return { page, context };
    } catch (e) {
      this.logger.error(`Failed to create new page: ${e.message}`);
      return null;
    }
  }

  async withPage<T>(fn: (page: Page) => Promise<T>, priority: number = 0): Promise<T> {
    let pageObj: { page: Page; context: any } | null = null;
    const reservedSlots = 2; // Always keep 2 slots for priority 0 requests
    const capacityLimit = priority <= 0 ? this.maxPages : Math.max(1, this.maxPages - reservedSlots);

    if (this.pagePool.length > 0 && this.activePages < capacityLimit) {
      pageObj = this.pagePool.shift()!;
      this.activePages++;
    } else if (this.activePages < capacityLimit) {
      this.activePages++;
      pageObj = await this.createNewPage();
      if (!pageObj) {
        // Creation failed — roll back the reservation. Otherwise the queue path
        // below re-increments on resolve, permanently leaking a slot (+1 per
        // failure) until every request eventually deadlocks in the queue.
        this.activePages--;
      }
    }

    if (!pageObj) {
      this.logger.debug(`Capacity reached (${this.activePages}/${this.maxPages}, limit: ${capacityLimit}). Queuing request with priority ${priority}...`);
      pageObj = await new Promise<{ page: Page; context: any }>((resolve, reject) => {
        this.queue.push({ priority, resolve, reject });
        this.queue.sort((a, b) => a.priority - b.priority);
      });
      this.activePages++;
    }

    const taskRecord = { pageObj, priority };
    this.activeTasks.add(taskRecord);

    try {
      return await fn(pageObj.page);
    } catch (error: any) {
      this.logger.error(`Error during Puppeteer task: ${error.message}`);
      throw error;
    } finally {
      this.activeTasks.delete(taskRecord);
      // Reset the page instead of closing it
      try {
        const { page } = pageObj;
        if (!page.isClosed()) {
          // Clean up listeners from the previous task
          page.removeAllListeners('request');
          // RE-ATTACH the blocking listener
          page.on('request', (request) => {
            const url = request.url().toLowerCase();
            const resourceType = request.resourceType();
            if (url.includes('.m3u8')) { request.continue(); return; }
            const blockedResources = ['image', 'stylesheet', 'font', 'manifest', 'texttrack', 'eventsource', 'websocket', 'media', 'other'];
            const blockedDomains = ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'onesignal.com', 'adsbygoogle', 'crashlytics.com', 'facebook.net'];
            
            if (blockedResources.includes(resourceType) || blockedDomains.some(domain => url.includes(domain))) {
              request.abort().catch(() => {});
            } else {
              request.continue().catch(() => {});
            }
          });

          await page.goto('about:blank');
          const client = await (page as any).target().createCDPSession();
          await client.send('Network.clearBrowserCookies');
          await client.send('Network.clearBrowserCache');

          this.pagePool.push(pageObj);
        }
      } catch (resetError: any) {
        this.logger.warn(`Failed to reset page, closing it instead: ${resetError.message}`);
        await pageObj.context.close().catch(() => { });
      }

      this.activePages--;
      this.processQueue();
    }
  }

  private processQueue() {
    if (this.queue.length === 0) return;

    const next = this.queue[0];
    const reservedSlots = 2;
    const capacityLimit = next.priority <= 0 ? this.maxPages : Math.max(1, this.maxPages - reservedSlots);

    if (this.activePages < capacityLimit && (this.pagePool.length > 0 || this.activePages < this.maxPages)) {
      const { resolve, reject } = this.queue.shift()!;

      let pageObj: { page: Page; context: any } | null = null;
      if (this.pagePool.length > 0) {
        pageObj = this.pagePool.shift()!;
      }

      if (pageObj) {
        resolve(pageObj);
      } else {
        // The waiting withPage() increments activePages only when this promise
        // RESOLVES (see the queue block there). On failure nothing was counted
        // for this item, so we must NOT decrement here — doing so drained a slot
        // that belonged to another in-flight task.
        this.createNewPage().then(p => {
          if (p) {
            resolve(p);
          } else {
            reject(new Error("Puppeteer connection timeout: could not allocate a new browser page."));
          }
        }).catch(err => {
          reject(err);
        });
      }
    }
  }

  public abortTasksWithPriority(minPriority: number) {
    let abortedCount = 0;
    
    // Clear from queue
    this.queue = this.queue.filter(item => {
      if (item.priority >= minPriority) {
        item.reject(new Error('Task aborted due to higher priority resolve request'));
        abortedCount++;
        return false;
      }
      return true;
    });

    // Force close active tasks
    for (const task of this.activeTasks) {
      if (task.priority >= minPriority) {
        task.pageObj.context.close().catch(() => {});
        abortedCount++;
      }
    }

    if (abortedCount > 0) {
      this.logger.log(`Aborted ${abortedCount} lower priority (>=${minPriority}) tasks to prioritize user resolve`);
    }
  }
}
