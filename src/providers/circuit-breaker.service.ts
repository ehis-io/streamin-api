import { Injectable, Logger } from '@nestjs/common';

export interface ScraperHealth {
  name: string;
  consecutiveFailures: number;
  totalRequests: number;
  totalFailures: number;
  totalSuccesses: number;
  lastFailureTime: number | null;
  lastSuccessTime: number | null;
  state: 'closed' | 'open' | 'half-open';
  avgDurationMs: number;
}

@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  private readonly FAILURE_THRESHOLD = 5;
  private readonly RECOVERY_TIMEOUT_MS = 60_000; // 1 minute before half-open
  private readonly HALF_OPEN_MAX_ATTEMPTS = 2;

  private readonly healthMap = new Map<string, ScraperHealth>();
  private readonly halfOpenAttempts = new Map<string, number>();

  private getOrCreate(scraperName: string): ScraperHealth {
    if (!this.healthMap.has(scraperName)) {
      this.healthMap.set(scraperName, {
        name: scraperName,
        consecutiveFailures: 0,
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastFailureTime: null,
        lastSuccessTime: null,
        state: 'closed',
        avgDurationMs: 0,
      });
    }
    return this.healthMap.get(scraperName)!;
  }

  isAvailable(scraperName: string): boolean {
    const health = this.getOrCreate(scraperName);

    if (health.state === 'closed') return true;

    if (health.state === 'open') {
      const elapsed = Date.now() - (health.lastFailureTime || 0);
      if (elapsed >= this.RECOVERY_TIMEOUT_MS) {
        health.state = 'half-open';
        this.halfOpenAttempts.set(scraperName, 0);
        this.logger.log(`Circuit for ${scraperName} moved to half-open after ${Math.round(elapsed / 1000)}s`);
        return true;
      }
      return false;
    }

    // half-open: allow limited attempts
    const attempts = this.halfOpenAttempts.get(scraperName) || 0;
    return attempts < this.HALF_OPEN_MAX_ATTEMPTS;
  }

  recordSuccess(scraperName: string, durationMs: number): void {
    const health = this.getOrCreate(scraperName);
    health.consecutiveFailures = 0;
    health.totalRequests++;
    health.totalSuccesses++;
    health.lastSuccessTime = Date.now();

    // Rolling average duration
    health.avgDurationMs = health.totalSuccesses === 1
      ? durationMs
      : health.avgDurationMs * 0.8 + durationMs * 0.2;

    if (health.state !== 'closed') {
      this.logger.log(`Circuit for ${scraperName} closed after successful recovery`);
      health.state = 'closed';
      this.halfOpenAttempts.delete(scraperName);
    }
  }

  recordFailure(scraperName: string, durationMs: number, error?: string): void {
    const health = this.getOrCreate(scraperName);
    health.consecutiveFailures++;
    health.totalRequests++;
    health.totalFailures++;
    health.lastFailureTime = Date.now();

    if (health.state === 'half-open') {
      const attempts = (this.halfOpenAttempts.get(scraperName) || 0) + 1;
      this.halfOpenAttempts.set(scraperName, attempts);

      if (attempts >= this.HALF_OPEN_MAX_ATTEMPTS) {
        health.state = 'open';
        this.logger.warn(`Circuit for ${scraperName} re-opened after failed half-open recovery`);
      }
      return;
    }

    if (health.consecutiveFailures >= this.FAILURE_THRESHOLD) {
      health.state = 'open';
      this.logger.warn(
        `Circuit OPEN for ${scraperName} after ${health.consecutiveFailures} consecutive failures. ` +
        `Last error: ${error || 'unknown'}`,
      );
    }
  }

  getHealth(scraperName: string): ScraperHealth {
    return { ...this.getOrCreate(scraperName) };
  }

  getAllHealth(): ScraperHealth[] {
    return Array.from(this.healthMap.values()).map(h => ({ ...h }));
  }

  /** Force-reset a scraper's circuit (for manual intervention) */
  reset(scraperName: string): void {
    this.healthMap.delete(scraperName);
    this.halfOpenAttempts.delete(scraperName);
    this.logger.log(`Circuit for ${scraperName} manually reset`);
  }
}
