/**
 * Account pool — rate limit tracking, headroom routing, failover.
 *
 * Activated automatically when `~/.dario/accounts/` contains 2+ accounts.
 * Single-account dario (`~/.dario/credentials.json`) keeps the same code
 * path it has always had; the pool only runs when there are multiple
 * accounts to distribute against.
 */
import { randomUUID } from 'node:crypto';

export interface AccountIdentity {
  deviceId: string;
  accountUuid: string;
  sessionId: string;
}

export interface RateLimitSnapshot {
  status: string;
  util5h: number;
  util7d: number;
  overageUtil: number;
  claim: string;
  reset: number;
  fallbackPct: number;
  updatedAt: number;
}

export const EMPTY_SNAPSHOT: RateLimitSnapshot = {
  status: 'unknown',
  util5h: 0,
  util7d: 0,
  overageUtil: 0,
  claim: 'unknown',
  reset: 0,
  fallbackPct: 0,
  updatedAt: 0,
};

export interface PoolAccount {
  alias: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: AccountIdentity;
  rateLimit: RateLimitSnapshot;
  requestCount: number;
}

export interface PoolStatus {
  accounts: number;
  healthy: number;
  exhausted: number;
  totalHeadroom: number;
  bestAccount: string;
  queued: number;
}

interface QueuedRequest {
  resolve: (account: PoolAccount) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

/** Parse an Anthropic response's rate-limit headers into a snapshot. */
export function parseRateLimits(headers: Headers): RateLimitSnapshot {
  const get = (key: string) => headers.get(`anthropic-ratelimit-unified-${key}`) ?? '';
  return {
    status: get('status') || 'unknown',
    util5h: parseFloat(get('5h-utilization')) || 0,
    util7d: parseFloat(get('7d-utilization')) || 0,
    overageUtil: parseFloat(get('overage-utilization')) || 0,
    claim: get('representative-claim') || 'unknown',
    reset: parseInt(get('reset')) || 0,
    fallbackPct: parseFloat(get('fallback-percentage')) || 0,
    updatedAt: Date.now(),
  };
}

export class AccountPool {
  private accounts: Map<string, PoolAccount> = new Map();
  private queue: QueuedRequest[] = [];
  private queueMaxSize = 50;
  private queueTimeoutMs = 60_000;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  add(alias: string, opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    deviceId: string;
    accountUuid: string;
  }): void {
    const existing = this.accounts.get(alias);
    this.accounts.set(alias, {
      alias,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
      identity: existing?.identity ?? {
        deviceId: opts.deviceId,
        accountUuid: opts.accountUuid,
        sessionId: randomUUID(),
      },
      rateLimit: existing?.rateLimit ?? { ...EMPTY_SNAPSHOT },
      requestCount: existing?.requestCount ?? 0,
    });
  }

  remove(alias: string): boolean {
    return this.accounts.delete(alias);
  }

  get size(): number {
    return this.accounts.size;
  }

  /** Select the best account for the next request. */
  select(): PoolAccount | null {
    if (this.accounts.size === 0) return null;

    const now = Date.now();
    const all = [...this.accounts.values()];

    const eligible = all.filter(a =>
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = 1 - Math.max(best.rateLimit.util5h, best.rateLimit.util7d);
        const currHeadroom = 1 - Math.max(curr.rateLimit.util5h, curr.rateLimit.util7d);
        return currHeadroom > bestHeadroom ? curr : best;
      });
    }

    // All accounts exhausted — return the one with the earliest reset
    const withReset = all.filter(a => a.rateLimit.reset > 0);
    if (withReset.length > 0) {
      return withReset.reduce((a, b) => a.rateLimit.reset < b.rateLimit.reset ? a : b);
    }

    // No rate-limit data at all — least-used first
    return all.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
  }

  /** Select the next-best account, excluding the given set of aliases. */
  selectExcluding(excluded: Set<string>): PoolAccount | null {
    if (this.accounts.size <= 1) return null;

    const now = Date.now();
    const candidates = [...this.accounts.values()].filter(a => !excluded.has(a.alias));

    const eligible = candidates.filter(a =>
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );

    if (eligible.length > 0) {
      return eligible.reduce((best, curr) => {
        const bestHeadroom = 1 - Math.max(best.rateLimit.util5h, best.rateLimit.util7d);
        const currHeadroom = 1 - Math.max(curr.rateLimit.util5h, curr.rateLimit.util7d);
        return currHeadroom > bestHeadroom ? curr : best;
      });
    }

    if (candidates.length > 0) {
      return candidates.reduce((a, b) => a.requestCount < b.requestCount ? a : b);
    }

    return null;
  }

  updateRateLimits(alias: string, snapshot: RateLimitSnapshot): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rateLimit = snapshot;
    account.requestCount++;
  }

  markRejected(alias: string, snapshot: RateLimitSnapshot): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.rateLimit = { ...snapshot, status: 'rejected' };
  }

  updateTokens(alias: string, accessToken: string, refreshToken: string, expiresAt: number): void {
    const account = this.accounts.get(alias);
    if (!account) return;
    account.accessToken = accessToken;
    account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
  }

  get(alias: string): PoolAccount | undefined {
    return this.accounts.get(alias);
  }

  all(): PoolAccount[] {
    return [...this.accounts.values()];
  }

  status(): PoolStatus {
    const all = this.all();
    const now = Date.now();
    const healthy = all.filter(a =>
      a.rateLimit.status !== 'rejected' &&
      a.expiresAt > now + 30_000,
    );
    const headrooms = all.map(a => 1 - Math.max(a.rateLimit.util5h, a.rateLimit.util7d));
    const avgHeadroom = headrooms.length > 0 ? headrooms.reduce((a, b) => a + b, 0) / headrooms.length : 0;
    const best = this.select();

    return {
      accounts: all.length,
      healthy: healthy.length,
      exhausted: all.length - healthy.length,
      totalHeadroom: Math.round(avgHeadroom * 100),
      bestAccount: best?.alias ?? 'none',
      queued: this.queue.length,
    };
  }

  /**
   * Wait for an available account. If all accounts are exhausted, queues
   * the request and resolves when an account becomes available via
   * updateRateLimits reducing utilization below threshold.
   */
  async waitForAccount(): Promise<PoolAccount> {
    const immediate = this.select();
    if (immediate) {
      const headroom = 1 - Math.max(immediate.rateLimit.util5h, immediate.rateLimit.util7d);
      if (headroom > 0.02) return immediate;
    }

    if (this.queue.length >= this.queueMaxSize) {
      throw new Error('Queue full — all accounts exhausted');
    }

    if (!this.drainTimer) {
      this.drainTimer = setInterval(() => this.drainQueue(), 5_000);
      this.drainTimer.unref();
    }

    return new Promise<PoolAccount>((resolve, reject) => {
      const entry: QueuedRequest = { resolve, reject, enqueuedAt: Date.now() };
      this.queue.push(entry);

      setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          reject(new Error('Queue timeout — no accounts available within 60s'));
        }
      }, this.queueTimeoutMs);
    });
  }

  private drainQueue(): void {
    if (this.queue.length === 0) {
      if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
      return;
    }

    const now = Date.now();
    this.queue = this.queue.filter(entry => {
      if (now - entry.enqueuedAt > this.queueTimeoutMs) {
        entry.reject(new Error('Queue timeout — no accounts available within 60s'));
        return false;
      }
      return true;
    });

    while (this.queue.length > 0) {
      const account = this.select();
      if (!account) break;
      const headroom = 1 - Math.max(account.rateLimit.util5h, account.rateLimit.util7d);
      if (headroom <= 0.02) break;

      const entry = this.queue.shift();
      if (entry) entry.resolve(account);
    }

    if (this.queue.length === 0 && this.drainTimer) {
      clearInterval(this.drainTimer);
      this.drainTimer = null;
    }
  }
}
