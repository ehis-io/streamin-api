import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';


@Injectable()
export class StreamValidationService {
  private readonly logger = new Logger(StreamValidationService.name);

  constructor(private readonly configService: ConfigService) {}


  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 5000;
  private readonly COOL_DOWN_MS = 30000;
  private readonly MAX_CONCURRENT_PER_DOMAIN = 5;

  private readonly validationQueues = new Map<string, (() => Promise<void>)[]>();
  private readonly activeValidations = new Map<string, number>();
  private readonly coolingDownDomains = new Map<string, number>();

  async validateStream(url: string, priority: number = 0): Promise<boolean> {
    // 🛡️ Skip validation for internal API URLs
    const apiUrl = this.configService.get<string>('API_URL');
    if (apiUrl && url.includes(new URL(apiUrl).host)) {
      this.logger.debug(`Skipping validation for internal link: ${url.substring(0, 80)}`);
      return true;
    }

    const domain = new URL(url).hostname;

    // Auto-accept M3U8 patterns — these are assumed valid since they were actively extracted
    if (url.includes('.m3u8') || url.includes('.m3u')) {
      this.logger.debug(`Auto-accepting M3U8 link: ${url.substring(0, 80)}`);
      return true;
    }

    const isRestricted = domain.includes('vidsrc') ||
      domain.includes('vidlink.pro') ||
      domain.includes('gogoanime') ||
      domain.includes('9animetv.be');

    if (!isRestricted) {
      return this.executeValidation(url);
    }

    const coolDownUntil = this.coolingDownDomains.get(domain);
    if (coolDownUntil && Date.now() < coolDownUntil) {
      this.logger.debug(`Skipping validation for ${domain} due to cool-down until ${new Date(coolDownUntil).toISOString()}`);
      return false;
    }

    return new Promise((resolve) => {
      const queue = this.validationQueues.get(domain) || [];
      const runValidation = async () => {
        const active = this.activeValidations.get(domain) || 0;
        this.activeValidations.set(domain, active + 1);

        try {
          const result = await this.executeValidation(url);
          resolve(result);
        } finally {
          const newActive = (this.activeValidations.get(domain) || 1) - 1;
          this.activeValidations.set(domain, newActive);
          this.processQueue(domain);
        }
      };

      if ((this.activeValidations.get(domain) || 0) < this.MAX_CONCURRENT_PER_DOMAIN) {
        runValidation();
      } else {
        queue.push(runValidation);
        this.validationQueues.set(domain, queue);
      }
    });
  }

  private processQueue(domain: string) {
    const queue = this.validationQueues.get(domain);
    if (queue && queue.length > 0 && (this.activeValidations.get(domain) || 0) < this.MAX_CONCURRENT_PER_DOMAIN) {
      const next = queue.shift();
      if (next) next();
    }
  }

  private async executeValidation(url: string, attempt: number = 1): Promise<boolean> {
    const domain = new URL(url).hostname;
    try {
      try {
        const headResponse = await axios.head(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': url
          },
          timeout: 500 // ⚡ Reduced from 1000ms → 500ms, fail fast and move on
        });
        if (headResponse.status === 200) return true;
      } catch (headError) {
        this.logger.debug(`HEAD validation failed for ${url}, trying GET...`);
      }

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': url
        },
        timeout: 2000,
        responseType: 'stream'
      });

      return new Promise((resolve) => {
        let buffer = '';
        const stream = response.data;

        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lowerData = buffer.toLowerCase();

          if (lowerData.includes("we couldn't find this episode") ||
            lowerData.includes("please check back another time") ||
            lowerData.includes("404 not found") ||
            lowerData.includes("video not found") ||
            lowerData.includes("file was deleted") ||
            lowerData.includes("no longer available")) {
            stream.destroy();
            resolve(false);
          }

          if (buffer.length > 512) {
            stream.destroy();
            resolve(true);
          }
        });

        stream.on('end', () => resolve(true));
        stream.on('error', () => resolve(false));
      });

    } catch (e: any) {
      if (e.response?.status === 429 && attempt <= this.MAX_RETRIES) {
        this.logger.warn(`Rate limited (429) by ${domain}. Retrying in ${this.RETRY_DELAY_MS}ms (Attempt ${attempt}/${this.MAX_RETRIES})`);
        this.coolingDownDomains.set(domain, Date.now() + this.COOL_DOWN_MS);
        await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS));
        return this.executeValidation(url, attempt + 1);
      }

      this.logger.debug(`Stream validation failed for ${url}: ${e.message}`);
      return false;
    }
  }
}
