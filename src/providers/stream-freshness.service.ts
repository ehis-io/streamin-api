import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StreamValidationService } from './stream-validation.service';

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class StreamFreshnessService implements OnModuleInit {
  private readonly logger = new Logger(StreamFreshnessService.name);
  private isRunning = false;

  /** Re-validate M3U8 links that are older than 3 days (before their 7-day TTL) */
  private readonly STALE_THRESHOLD_DAYS = 3;
  private readonly BATCH_SIZE = 50;

  constructor(
    private prisma: PrismaService,
    private validationService: StreamValidationService,
  ) {}

  onModuleInit() {
    // Run once after a 2-minute startup delay, then every 12 hours
    setTimeout(() => this.validateStaleLinks(), 120_000);
    setInterval(() => this.validateStaleLinks(), TWELVE_HOURS_MS);
  }

  async validateStaleLinks() {
    if (this.isRunning) {
      this.logger.debug('Freshness check already in progress, skipping');
      return;
    }

    this.isRunning = true;
    this.logger.log('Starting stream freshness validation...');

    try {
      const staleThreshold = new Date(Date.now() - this.STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);
      const expiredThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Hard-purge M3U8 links past their 7-day TTL. They're already filtered out at
      // read time, but nothing deleted them, so the table grew unbounded.
      try {
        const expired = await (this.prisma as any).streamedLink.deleteMany({
          where: { isM3U8: true, createdAt: { lt: expiredThreshold } },
        });
        if (expired.count > 0) {
          this.logger.log(`Purged ${expired.count} expired (>7d) M3U8 link(s)`);
        }
      } catch (e: any) {
        this.logger.warn(`Failed to purge expired M3U8 links: ${e.message}`);
      }

      // Find M3U8 links that are between 3-7 days old
      const staleLinks = await (this.prisma as any).streamedLink.findMany({
        where: {
          isM3U8: true,
          createdAt: {
            gte: expiredThreshold,
            lte: staleThreshold,
          },
        },
        take: this.BATCH_SIZE,
        orderBy: { createdAt: 'asc' },
      });

      if (staleLinks.length === 0) {
        this.logger.debug('No stale links to validate');
        return;
      }

      this.logger.log(`Validating ${staleLinks.length} stale M3U8 links`);

      let purged = 0;
      let valid = 0;

      // Validate in small parallel batches to avoid overwhelming sources
      const batchSize = 5;
      for (let i = 0; i < staleLinks.length; i += batchSize) {
        const batch = staleLinks.slice(i, i + batchSize);

        const results = await Promise.all(
          batch.map(async (link: any) => {
            try {
              const headers = link.headers ? (typeof link.headers === 'string' ? JSON.parse(link.headers) : link.headers) : undefined;
              const isValid = await this.validationService.validateStream(link.url, headers);
              return { id: link.id, isValid };
            } catch {
              return { id: link.id, isValid: false };
            }
          }),
        );

        const deadIds = results.filter(r => !r.isValid).map(r => r.id);
        if (deadIds.length > 0) {
          await (this.prisma as any).streamedLink.deleteMany({
            where: { id: { in: deadIds } },
          });
          purged += deadIds.length;
        }
        valid += results.filter(r => r.isValid).length;

        // Brief pause between batches
        if (i + batchSize < staleLinks.length) {
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      this.logger.log(`Freshness check complete: ${valid} valid, ${purged} purged`);
    } catch (error: any) {
      this.logger.error(`Freshness validation failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
