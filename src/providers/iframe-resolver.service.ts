import { Injectable, Logger } from '@nestjs/common';
import { PuppeteerService } from '../puppeteer/puppeteer.service';
import { StreamLink } from './scraper.interface';

/** Domains known to host video players behind embed iframes */
const KNOWN_EMBED_PATTERNS = [
  'streamwish', 'filemoon', 'voe.sx', 'doodstream', 'mixdrop',
  'upstream', 'mp4upload', 'streamtape', 'vidoza', 'kwik',
  'rapidcloud', 'megacloud', 'vidplay', 'mycloud', 'vizcloud',
  'rabbitstream', 'dokicloud', '9animetv', 'gogocdn', 'embtaku', 'vidcloud', 'upcloud', 'vidsrc', 'vidlink',
];

/** Ad/tracking domains to block during resolution */
const AD_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'googlesyndication.com', 'adsbygoogle', 'facebook.net',
  'popads.net', 'popcash.net', 'propellerads.com', 'exoclick.com',
  'juicyads.com', 'trafficjunky.com', 'adsterra.com', 'clickadu.com',
  'hilltopads.net', 'a-ads.com', 'monetag.com', 'richpush.com',
  'pushground.com', 'galaksion.com', 'profitablegatecpm.com',
  'betterjtv.com', 'onclickmax.com', 'onclicksuper.com',
  'trkclick.com', 'syndication.realsrv.com', 'tsyndicate.com',
  'bidgear.com', 'dolohen.com', 'adskeeper.co.uk', 'sentry.io',
  'hotjar.com', 'mixpanel.com', 'onesignal.com', 'crashlytics.com',
  'cloudeff.com', 'cloudflareresolve.com', 'jads.co', 'shorte.st',
  'ouo.io', 'adf.ly', 'bit.ly', 'cpmrevenuegate.com', 'onclkds.com'
];

@Injectable()
export class IframeResolverService {
  private readonly logger = new Logger(IframeResolverService.name);

  constructor(private puppeteerService: PuppeteerService) {}

  /** Check if a URL is a known embed/mirror that we can deep-resolve */
  isResolvableEmbed(url: string): boolean {
    const lower = url.toLowerCase();
    return KNOWN_EMBED_PATTERNS.some(p => lower.includes(p));
  }

  /**
   * Load an iframe/embed URL in Puppeteer with aggressive ad blocking.
   * Intercepts video network requests (M3U8, MP4) and returns clean StreamLinks.
   */
  async resolve(embedUrl: string, priority: number = 0): Promise<StreamLink[]> {
    this.logger.log(`Resolving embed: ${embedUrl}`);

    return this.puppeteerService.withPage(async (page) => {
      const foundLinks: StreamLink[] = [];
      let earlyResolveFn: (() => void) | null = null;
      const earlyResolvePromise = new Promise<void>(resolve => { earlyResolveFn = resolve; });

      // Remove default request listener from the page pool — we attach our own.
      // DO NOT call setRequestInterception again; it's already enabled by PuppeteerService.
      page.removeAllListeners('request');

      // Single unified request handler: ad blocking + video URL capture
      page.on('request', (request) => {
        const reqUrl = request.url();
        const reqUrlLower = reqUrl.toLowerCase();
        const resourceType = request.resourceType();

        // Capture M3U8 video URLs
        if (reqUrlLower.includes('.m3u8') && !reqUrlLower.includes('heartbeat')) {
          const exists = foundLinks.some(l => l.url === reqUrl);
          if (!exists) {
            foundLinks.push({
              url: reqUrl,
              quality: reqUrlLower.includes('master') || reqUrlLower.includes('index.m3u8') ? 'Auto' : 'Unknown',
              isM3U8: true,
              originalUrl: embedUrl,
              headers: request.headers(),
            });
            this.logger.debug(`Captured M3U8: ${reqUrl.substring(0, 100)}`);
          }

          // Fast exit on master playlist
          if (reqUrlLower.includes('master') || reqUrlLower.includes('index.m3u8')) {
            earlyResolveFn?.();
          }

          request.continue();
          return;
        }

        // Always allow .mpd and .mp4
        if (reqUrlLower.includes('.mpd') || reqUrlLower.includes('.mp4')) {
          request.continue();
          return;
        }

        // Block ads aggressively
        if (AD_DOMAINS.some(d => reqUrlLower.includes(d))) {
          request.abort();
          return;
        }

        // Block non-essential resource types
        if (['image', 'stylesheet', 'font', 'media', 'manifest', 'texttrack'].includes(resourceType)) {
          request.abort();
          return;
        }

        // Block popup/redirect scripts
        if (resourceType === 'script' && (
          reqUrlLower.includes('pop') || reqUrlLower.includes('ads') || reqUrlLower.includes('track') ||
          reqUrlLower.includes('syndication') || reqUrlLower.includes('analytics')
        )) {
          request.abort();
          return;
        }

        request.continue();
      });

      // Also capture MP4 video from responses (content-type based)
      page.on('response', async (response) => {
        const url = response.url();
        const contentType = response.headers()['content-type'] || '';

        if (url.includes('.mp4') && contentType.includes('video')) {
          const exists = foundLinks.some(l => l.url === url);
          if (!exists) {
            foundLinks.push({
              url,
              quality: 'Direct',
              isM3U8: false,
              originalUrl: embedUrl,
              headers: { 'Referer': embedUrl },
            });
            this.logger.debug(`Captured MP4: ${url.substring(0, 100)}`);
          }
        }
      });

      // Disable window.open to prevent popups
      await page.evaluateOnNewDocument(() => {
        window.open = () => null;
        window.alert = () => {};
        window.confirm = () => true;
        window.prompt = () => null;
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      );

      try {
        await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });

        // Try to auto-click play buttons if present
        await this.tryClickPlay(page);

        // Fast exit if we already have links after play click
        if (foundLinks.length > 0) {
          this.logger.debug(`Fast exit: links found immediately after play click`);
          return foundLinks;
        }

        // Wait for video source: either early resolve (master found) or 2s timeout
        if (foundLinks.length === 0) {
          await Promise.race([
            earlyResolvePromise,
            new Promise(r => setTimeout(r, 2000)),
          ]);
        }

        // Try to extract video src from DOM as fallback
        if (foundLinks.length === 0) {
          const domLinks = await this.extractVideoFromDom(page, embedUrl);
          foundLinks.push(...domLinks);
        }

        // Try to extract from nested iframes
        if (foundLinks.length === 0) {
          const iframeLinks = await this.extractFromIframes(page, embedUrl);
          foundLinks.push(...iframeLinks);
        }
      } catch (e: any) {
        this.logger.warn(`Navigation failed for ${embedUrl}: ${e.message}`);
      }

      this.logger.log(`Resolved ${foundLinks.length} links from embed: ${embedUrl}`);
      return foundLinks;
    }, priority).catch((error) => {
      this.logger.error(`Iframe resolution failed for ${embedUrl}: ${error.message}`);
      return [];
    });
  }

  /** Try clicking common play button selectors and center of viewport */
  private async tryClickPlay(page: any): Promise<void> {
    const playSelectors = [
      '.play-button', '.btn-play', '#play', '[data-play]',
      '.jw-icon-display', '.vjs-big-play-button', '.plyr__control--overlaid',
      'button[aria-label="Play"]', '.play-overlay', '.video-play',
    ];

    let clicked = false;
    for (const selector of playSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          await el.click();
          this.logger.debug(`Clicked play button: ${selector}`);
          clicked = true;
          break;
        }
      } catch {
        // Selector not found, try next
      }
    }

    // Try center screen coordinate clicks to bypass invisible ad layers
    // Often 2 clicks are needed (1 for ad pop, 1 for play)
    try {
      this.logger.debug(`Performing coordinate center-click (bypass overlays)`);
      const viewport = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      if (viewport.w > 0 && viewport.h > 0) {
        await page.mouse.click(viewport.w / 2, viewport.h / 2);
        await new Promise(r => setTimeout(r, 500));
        await page.mouse.click(viewport.w / 2, viewport.h / 2); // Double click to clear overlay + play
      }
    } catch {}

    // Brief wait for network activity after clicks
    await new Promise(r => setTimeout(r, 500));
  }

  /** Extract video source URLs directly from DOM elements */
  private async extractVideoFromDom(page: any, referer: string): Promise<StreamLink[]> {
    try {
      const sources = await page.evaluate(() => {
        const results: { url: string; type: string }[] = [];

        // Check <video> and <source> elements
        document.querySelectorAll('video, video source').forEach((el) => {
          const src = el.getAttribute('src') || (el as HTMLVideoElement).src;
          if (src && src.startsWith('http')) {
            results.push({ url: src, type: src.includes('.m3u8') ? 'm3u8' : 'direct' });
          }
        });

        // Check JWPlayer if present
        if ((window as any).jwplayer) {
          try {
            const player = (window as any).jwplayer();
            const playlist = player.getPlaylistItem?.();
            if (playlist?.file) {
              results.push({ url: playlist.file, type: playlist.file.includes('.m3u8') ? 'm3u8' : 'direct' });
            }
            playlist?.sources?.forEach((s: any) => {
              if (s.file) results.push({ url: s.file, type: s.file.includes('.m3u8') ? 'm3u8' : 'direct' });
            });
          } catch {}
        }

        // Check Plyr
        if ((window as any).player?.source) {
          const src = (window as any).player.source;
          if (typeof src === 'string') results.push({ url: src, type: 'direct' });
        }

        return results;
      });

      return sources.map((s: any) => ({
        url: s.url,
        quality: 'Auto',
        isM3U8: s.type === 'm3u8',
        originalUrl: referer,
        headers: { 'Referer': referer },
      }));
    } catch {
      return [];
    }
  }

  /** Check nested iframes for video sources */
  private async extractFromIframes(page: any, referer: string): Promise<StreamLink[]> {
    try {
      const iframeSrcs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('iframe'))
          .map(f => f.src)
          .filter(src => src && src.startsWith('http'));
      });

      const links: StreamLink[] = [];
      for (const src of iframeSrcs.slice(0, 3)) {
        if (this.isResolvableEmbed(src)) {
          links.push({
            url: src,
            quality: 'Embed',
            isM3U8: false,
            originalUrl: referer,
            headers: { 'Referer': referer },
          });
        }
      }

      return links;
    } catch {
      return [];
    }
  }
}
