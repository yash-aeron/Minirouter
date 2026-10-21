/**
 * Per-provider account pool: round-robin across OAuth accounts, proactive
 * refresh near expiry, one transparent refresh-and-retry on 401, and an
 * independent circuit breaker per account so one dead subscription does not
 * take the whole provider out of the chain.
 */
import { Breakers } from '../router/breaker.js';
import { ProviderError } from '../providers/types.js';
import { refreshAccount, RefreshOptions } from './refresh.js';
import { redactError } from './redact.js';
import { TokenStore } from './token-store.js';
import { OAuthAccount, OAuthProvider, RefreshFn } from './types.js';

export interface OAuthPoolOptions {
  refresh: RefreshFn;
  now?: () => number;
  skewMs?: number;
  breakers?: Breakers;
  /** breaker/error label; defaults to the provider kind */
  label?: string;
}

export interface PooledResult<T> {
  result: T;
  account: OAuthAccount;
}

export class OAuthPool {
  readonly provider: OAuthProvider;
  readonly label: string;
  private readonly accounts: OAuthAccount[];
  private readonly store: TokenStore;
  private readonly breakers: Breakers;
  private readonly opts: OAuthPoolOptions;
  private cursor = 0;

  constructor(
    provider: OAuthProvider,
    store: TokenStore,
    specs: string[],
    opts: OAuthPoolOptions,
  ) {
    if (specs.length === 0) {
      throw new Error(`${provider} provider has auth "oauth" but no accounts configured`);
    }
    this.provider = provider;
    this.store = store;
    this.opts = opts;
    this.label = opts.label ?? provider;
    this.breakers = opts.breakers ?? new Breakers();
    this.accounts = specs.map((spec) => store.resolveOrThrow(provider, spec));
  }

  /** Account ids in pool order (does not include tokens). */
  ids(): string[] {
    return this.accounts.map((a) => a.id);
  }

  snapshot(): OAuthAccount[] {
    return this.accounts.map((a) => ({ ...a }));
  }

  private breakerKey(account: OAuthAccount): string {
    return `${this.provider}:${account.id}`;
  }

  private pick(): OAuthAccount {
    const now = this.opts.now?.() ?? Date.now();
    for (let i = 0; i < this.accounts.length; i += 1) {
      const index = (this.cursor + i) % this.accounts.length;
      const account = this.accounts[index]!;
      if (!this.breakers.isOpen(this.breakerKey(account), now)) {
        this.cursor = (index + 1) % this.accounts.length;
        return account;
      }
    }
    throw new ProviderError(`${this.label}: all OAuth accounts are cooling down`, {
      status: 503,
      retryable: true,
      provider: this.label,
    });
  }

  private replace(account: OAuthAccount): void {
    const index = this.accounts.findIndex((a) => a.id === account.id);
    if (index !== -1) this.accounts[index] = account;
  }

  private async fresh(account: OAuthAccount, refreshOpts: RefreshOptions = {}): Promise<OAuthAccount> {
    try {
      const updated = await refreshAccount(this.store, this.provider, account, this.opts.refresh, {
        now: this.opts.now,
        skewMs: this.opts.skewMs,
        ...refreshOpts,
      });
      this.replace(updated);
      return updated;
    } catch (err) {
      // A dead refresh token should fail over to the next provider, not 500.
      throw new ProviderError(`${this.label}: ${redactError(err, [account.accessToken, account.refreshToken])}`, {
        status: 401,
        retryable: true,
        provider: this.label,
      });
    }
  }

  /**
   * Run `fn` with the next healthy account. A 401 from the upstream triggers
   * one forced refresh and one retry; every other error is recorded against
   * that account's breaker and rethrown for the failover engine.
   */
  async run<T>(fn: (account: OAuthAccount) => Promise<T>): Promise<PooledResult<T>> {
    let account = this.pick();
    account = await this.fresh(account);

    try {
      const result = await fn(account);
      this.breakers.recordSuccess(this.breakerKey(account));
      return { result, account };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) {
        let refreshed: OAuthAccount;
        try {
          refreshed = await this.fresh(account, { force: true });
        } catch (refreshErr) {
          if (refreshErr instanceof ProviderError) {
            this.breakers.recordFailure(this.breakerKey(account), refreshErr);
          }
          throw refreshErr;
        }
        try {
          const result = await fn(refreshed);
          this.breakers.recordSuccess(this.breakerKey(refreshed));
          return { result, account: refreshed };
        } catch (retryErr) {
          if (retryErr instanceof ProviderError) {
            this.breakers.recordFailure(this.breakerKey(refreshed), retryErr);
          }
          throw retryErr;
        }
      }
      if (err instanceof ProviderError) {
        this.breakers.recordFailure(this.breakerKey(account), err);
      }
      throw err;
    }
  }
}
