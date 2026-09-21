import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, BrowserContext, HTTPRequest, Page } from 'puppeteer';

type PageObj = { page: Page; context: BrowserContext; uses: number; idleSince: number };

const BLOCKED_RESOURCES = ['image', 'stylesheet', 'font', 'manifest', 'texttrack', 'eventsource', 'websocket', 'media', 'other'];
const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'onesignal.com', 'adsbygoogle', 'crashlytics.com', 'facebook.net'
];

@Injectable()
export class PuppeteerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PuppeteerService.name);
  private browser: Browser | null = null;
  private launching: Promise<void> | null = null;
  private restarting: Promise<void> | null = null;
  // Set when Chrome is over its memory budget while tasks are running; the browser is
  // restarted as soon as the last task finishes instead of killing work mid-scrape.
  private restartPending = false;
  private housekeepingTimer: NodeJS.Timeout | null = null;

  private readonly maxPages: number;
  private readonly prewarmPages: number;
  // A reused page keeps every heap, JIT cache and leaked listener of the scraper sites it
  // visited. Retiring it after N tasks caps how far a single renderer can grow.
  private readonly pageMaxUses: number;
  private readonly idlePageTtlMs: number;
  private readonly maxMemoryMb: number;

  private activePages = 0;
  private readonly pagePool: PageObj[] = [];
  private queue: { priority: number; resolve: (val: PageObj) => void; reject: (err: any) => void }[] = [];
  private activeTasks = new Set<{ pageObj: PageObj, priority: number }>();

  private readonly proxyUrls: string[];
  private proxyIndex = 0;

  constructor(private configService: ConfigService) {
    puppeteer.use(StealthPlugin());
    // Env values arrive as strings; coerce so the capacity maths is numeric.
    const num = (key: string, fallback: number) => {
      const n = Number(this.configService.get(key));
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    this.maxPages = num('PUPPETEER_MAX_PAGES', 6);
    this.prewarmPages = Math.min(num('PUPPETEER_PREWARM_PAGES', 2), this.maxPages);
    this.pageMaxUses = num('PUPPETEER_PAGE_MAX_USES', 25);
    this.idlePageTtlMs = num('PUPPETEER_IDLE_PAGE_TTL_MS', 5 * 60 * 1000);
    this.maxMemoryMb = num('PUPPETEER_MAX_MEMORY_MB', 1536);

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
    await this.prewarm();
    this.housekeepingTimer = setInterval(() => {
      this.housekeeping().catch(e => this.logger.warn(`Puppeteer housekeeping failed: ${e.message}`));
    }, 60 * 1000);
    this.housekeepingTimer.unref();
  }

  async onModuleDestroy() {
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  private async prewarm() {
    this.logger.log(`Pre-warming Puppeteer page pool (${this.prewarmPages} pages)...`);
    const results = await Promise.all(Array(this.prewarmPages).fill(null).map(() => this.createNewPage()));
    results.forEach(warmed => {
      if (warmed) this.pagePool.push(warmed);
    });
  }

  private async ensureBrowser() {
    if (this.restarting) await this.restarting;
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
    // Several pages can be requested at once while the browser is down; launch it once.
    if (!this.launching) {
      this.launching = this.launchBrowser().finally(() => { this.launching = null; });
    }
    await this.launching;
  }

  private async launchBrowser() {
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
        // No shell here, so quotes would be passed through literally and the flag ignored.
        '--js-flags=--max-old-space-size=256',
        '--disk-cache-size=33554432',
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

  /** Close Chrome and start a fresh one, returning all of its memory to the OS. */
  private restartBrowser(reason: string): Promise<void> {
    if (this.restarting) return this.restarting;
    this.restartPending = false;
    this.logger.warn(`Restarting Puppeteer browser: ${reason}`);
    this.restarting = (async () => {
      const old = this.browser;
      this.browser = null;
      this.pagePool.length = 0;
      await old?.close().catch(() => {});
      await this.launchBrowser();
    })()
      .catch(e => this.logger.error(`Browser restart failed: ${e.message}`))
      .finally(() => { this.restarting = null; });
    return this.restarting.then(() => this.prewarm());
  }

  private async housekeeping() {
    if (this.restarting) return;

    // Drop pages that have sat unused in the pool, keeping the prewarmed minimum.
    const now = Date.now();
    for (let i = this.pagePool.length - 1; i >= 0 && this.pagePool.length > this.prewarmPages; i--) {
      if (now - this.pagePool[i].idleSince > this.idlePageTtlMs) {
        const [stale] = this.pagePool.splice(i, 1);
        await stale.context.close().catch(() => {});
      }
    }

    const usedMb = await this.browserMemoryMb();
    if (usedMb === null || usedMb <= this.maxMemoryMb) return;
    if (this.activePages === 0) {
      await this.restartBrowser(`using ${usedMb}MB (limit ${this.maxMemoryMb}MB)`);
    } else if (!this.restartPending) {
      this.restartPending = true;
      this.logger.warn(`Browser using ${usedMb}MB (limit ${this.maxMemoryMb}MB); restarting once ${this.activePages} active task(s) finish`);
    }
  }

  /**
   * Proportional memory (PSS) of Chrome and all its child processes, in MB. PM2's
   * max_memory_restart only sees the Node process, so this is the only guard on Chrome.
   * Linux only; returns null elsewhere.
   */
  private async browserMemoryMb(): Promise<number | null> {
    const rootPid = this.browser?.process()?.pid;
    if (!rootPid || process.platform !== 'linux') return null;

    const children = new Map<number, number[]>();
    for (const entry of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await fs.readFile(`/proc/${entry}/stat`, 'utf8');
        // Fields after the ")" of the command name: state, ppid, ...
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid)!.push(Number(entry));
      } catch { /* process exited */ }
    }

    let totalKb = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop()!;
      stack.push(...(children.get(pid) || []));
      try {
        const rollup = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
        const match = rollup.match(/^Pss:\s+(\d+)/m);
        if (match) totalKb += Number(match[1]);
      } catch { /* process exited */ }
    }
    return Math.round(totalKb / 1024);
  }

  private attachRequestBlocking(page: Page) {
    page.on('request', (request: HTTPRequest) => {
      const url = request.url().toLowerCase();
      if (url.includes('.m3u8')) {
        request.continue().catch(() => {});
        return;
      }
      if (BLOCKED_RESOURCES.includes(request.resourceType()) || BLOCKED_DOMAINS.some(domain => url.includes(domain))) {
        request.abort().catch(() => {});
      } else {
        request.continue().catch(() => {});
      }
    });
  }

  private async createNewPage(): Promise<PageObj | null> {
    try {
      await this.ensureBrowser();
      const context = await this.browser!.createBrowserContext();
      const page = await context.newPage();

      await page.setRequestInterception(true);
      this.attachRequestBlocking(page);

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

      return { page, context, uses: 0, idleSince: Date.now() };
    } catch (e) {
      this.logger.error(`Failed to create new page: ${e.message}`);
      return null;
    }
  }

  /** Take a live page from the pool, discarding any that died (e.g. after a browser crash). */
  private takePooledPage(): PageObj | null {
    while (this.pagePool.length > 0) {
      const pageObj = this.pagePool.shift()!;
      if (!pageObj.page.isClosed()) return pageObj;
    }
    return null;
  }

  async withPage<T>(fn: (page: Page) => Promise<T>, priority: number = 0): Promise<T> {
    let pageObj: PageObj | null = null;
    const reservedSlots = 2; // Always keep 2 slots for priority 0 requests
    const capacityLimit = priority <= 0 ? this.maxPages : Math.max(1, this.maxPages - reservedSlots);

    if (this.activePages < capacityLimit) {
      this.activePages++;
      pageObj = this.takePooledPage() ?? await this.createNewPage();
      if (!pageObj) {
        // Creation failed — roll back the reservation. Otherwise the queue path
        // below re-increments on resolve, permanently leaking a slot (+1 per
        // failure) until every request eventually deadlocks in the queue.
        this.activePages--;
      }
    }

    if (!pageObj) {
      this.logger.debug(`Capacity reached (${this.activePages}/${this.maxPages}, limit: ${capacityLimit}). Queuing request with priority ${priority}...`);
      pageObj = await new Promise<PageObj>((resolve, reject) => {
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
      await this.releasePage(pageObj);

      this.activePages--;
      if (this.restartPending && this.activePages === 0) {
        // Not awaited: the caller shouldn't wait on a relaunch. Queued work waits
        // for it in ensureBrowser().
        void this.restartBrowser(`over ${this.maxMemoryMb}MB memory limit`);
      }
      this.processQueue();
    }
  }

  /** Reset a finished page and return it to the pool, or close it if it is worn out. */
  private async releasePage(pageObj: PageObj) {
    const { page, context } = pageObj;
    pageObj.uses++;
    if (page.isClosed()) return;
    if (pageObj.uses >= this.pageMaxUses || this.restartPending) {
      await context.close().catch(() => {});
      return;
    }

    try {
      // Clean up listeners from the previous task, then re-attach the blocking one.
      page.removeAllListeners('request');
      this.attachRequestBlocking(page);

      await page.goto('about:blank');
      const client = await page.createCDPSession();
      try {
        await client.send('Network.clearBrowserCookies');
        await client.send('Network.clearBrowserCache');
      } finally {
        // A session per reset that is never detached accumulates in both Chrome and Node.
        await client.detach().catch(() => {});
      }

      pageObj.idleSince = Date.now();
      this.pagePool.push(pageObj);
    } catch (resetError: any) {
      this.logger.warn(`Failed to reset page, closing it instead: ${resetError.message}`);
      await context.close().catch(() => { });
    }
  }

  private processQueue() {
    if (this.queue.length === 0) return;

    const next = this.queue[0];
    const reservedSlots = 2;
    const capacityLimit = next.priority <= 0 ? this.maxPages : Math.max(1, this.maxPages - reservedSlots);

    if (this.activePages < capacityLimit && (this.pagePool.length > 0 || this.activePages < this.maxPages)) {
      const { resolve, reject } = this.queue.shift()!;

      const pageObj = this.takePooledPage();
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
