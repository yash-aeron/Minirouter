/**
 * Token refresh with a 5-minute skew and single-flight locking per account:
 * concurrent requests that all notice an expired token must trigger exactly
 * one refresh, not a stampede.
 */
import { redactError } from './redact.js';
import { TokenStore } from './token-store.js';
import { OAuthAccount, OAuthProvider, RefreshFn } from './types.js';

export interface RefreshOptions {
  /** Refresh tokens that expire within this window (default 5 minutes). */
  skewMs?: number;
  now?: () => number;
  /** Ignore the skew and refresh unconditionally (`auth refresh`). */
  force?: boolean;
}

export const DEFAULT_REFRESH_SKEW_MS = 5 * 60_000;

const inflight = new Map<string, Promise<OAuthAccount>>();

export function isExpiring(account: OAuthAccount, opts: RefreshOptions = {}): boolean {
  const now = opts.now?.() ?? Date.now();
  const skew = opts.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  return account.expiresAt - now <= skew;
}

export async function refreshAccount(
  store: TokenStore,
  provider: OAuthProvider,
  account: OAuthAccount,
  refresh: RefreshFn,
  opts: RefreshOptions = {},
): Promise<OAuthAccount> {
  if (!opts.force && !isExpiring(account, opts)) return account;

  const key = `${provider}:${account.id}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const pending = (async (): Promise<OAuthAccount> => {
    let tokens;
    try {
      tokens = await refresh(account);
    } catch (err) {
      throw new Error(
        `${provider} token refresh failed: ${redactError(err, [account.accessToken, account.refreshToken])}`,
      );
    }
    const updated: OAuthAccount = {
      ...account,
      ...tokens,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken ?? account.refreshToken,
    };
    store.update(provider, account.id, updated);
    return updated;
  })();

  const tracked = pending.finally(() => {
    if (inflight.get(key) === tracked) inflight.delete(key);
  });
  inflight.set(key, tracked);
  return tracked;
}

/** Test hook: drop pending refreshes (they are per-process and short-lived). */
export function clearRefreshState(): void {
  inflight.clear();
}
