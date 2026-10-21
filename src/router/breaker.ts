/**
 * Per-provider circuit breaker: after consecutive failures, the provider is
 * skipped for a cooldown window instead of burning a retry slot on it.
 */
import { ProviderError } from '../providers/types.js';

const OPEN_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export class Breakers {
  private readonly states = new Map<string, BreakerState>();

  isOpen(provider: string, now = Date.now()): boolean {
    const s = this.states.get(provider);
    if (!s || s.openedAt === null) return false;
    if (now - s.openedAt >= COOLDOWN_MS) {
      // cooldown elapsed: half-open, allow one attempt through
      s.openedAt = null;
      s.consecutiveFailures = OPEN_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  recordSuccess(provider: string): void {
    this.states.set(provider, { consecutiveFailures: 0, openedAt: null });
  }

  recordFailure(provider: string, err: ProviderError, now = Date.now()): void {
    // Auth and quota errors don't trip the breaker: the provider is fine, the
    // key isn't. Failover still skips it this request.
    if (err.status === 401 || err.status === 402 || err.status === 403) return;
    const s = this.states.get(provider) ?? { consecutiveFailures: 0, openedAt: null };
    s.consecutiveFailures += 1;
    if (s.consecutiveFailures >= OPEN_THRESHOLD) s.openedAt = now;
    this.states.set(provider, s);
  }
}
