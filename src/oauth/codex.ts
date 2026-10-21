/**
 * Codex (ChatGPT subscription) login.
 *
 * Uses the public OAuth client shipped with the Codex CLI and the localhost
 * callback it registers (port 1455). Requests are served by the Codex backend
 * Responses endpoint, not api.openai.com.
 *
 * Experimental: this is a personal ChatGPT subscription, not an API key.
 */
import { startCallbackServer } from './callback.js';
import { FetchLike, platformFetch, postForm } from './http.js';
import { createState, createVerifier, challengeFor } from './pkce.js';
import { OAuthAccount, RefreshedTokens, RefreshFn } from './types.js';
import { TokenStore } from './token-store.js';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_REDIRECT_HOST = '127.0.0.1';
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_PATH = '/auth/callback';
export const CODEX_BACKEND_BASE = 'https://chatgpt.com/backend-api/codex';
export const CODEX_SCOPES = 'openid profile email offline_access';

export function codexAuthorizeUrl(verifier: string, state: string, redirectUri: string): string {
  const url = new URL(CODEX_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', CODEX_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  return url.toString();
}

interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  account_id?: string;
}

export function decodeJwtPayload(token: string | undefined): Record<string, any> {
  if (!token) return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

export function codexAccountId(response: CodexTokenResponse): string | undefined {
  if (response.account_id) return response.account_id;
  const payload = decodeJwtPayload(response.id_token);
  const auth = payload['https://api.openai.com/auth'];
  return (
    (auth && typeof auth === 'object' ? auth.chatgpt_account_id : undefined) ??
    payload.chatgpt_account_id ??
    payload.account_id
  );
}

function expiryFrom(response: CodexTokenResponse, now: number): number {
  if (typeof response.expires_in === 'number') return now + response.expires_in * 1000;
  const exp = decodeJwtPayload(response.id_token).exp;
  if (typeof exp === 'number') return exp * 1000;
  return now + 3600_000;
}

function toTokens(response: CodexTokenResponse, now: number): RefreshedTokens {
  if (!response.access_token) throw new Error('Codex token response contained no access token');
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: expiryFrom(response, now),
    scope: response.scope,
    accountId: codexAccountId(response),
    tokenType: response.token_type ?? 'Bearer',
  };
}

export interface ExchangeOptions {
  code: string;
  verifier: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  now?: () => number;
}

export async function exchangeCodexCode(opts: ExchangeOptions): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const response = await postForm<CodexTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? CODEX_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: opts.verifier,
    },
    'Codex token exchange',
  );
  const tokens = toTokens(response, now);
  if (!tokens.refreshToken) throw new Error('Codex did not return a refresh token');
  return tokens;
}

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  now?: () => number;
}

export async function refreshCodexToken(
  account: OAuthAccount,
  opts: RefreshOptions = {},
): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const response = await postForm<CodexTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? CODEX_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: CODEX_CLIENT_ID,
      scope: CODEX_SCOPES,
    },
    'Codex token refresh',
  );
  const tokens = toTokens(response, now);
  return {
    ...tokens,
    refreshToken: tokens.refreshToken ?? account.refreshToken,
    accountId: tokens.accountId ?? account.accountId,
  };
}

export function codexRefresher(opts: RefreshOptions = {}): RefreshFn {
  return (account) => refreshCodexToken(account, opts);
}

export interface CodexLoginDeps {
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  tokenUrl?: string;
  /** Override the fixed callback port (tests use an ephemeral one). */
  port?: number;
  path?: string;
  timeoutMs?: number;
}

export async function loginCodex(
  store: TokenStore,
  label: string,
  deps: CodexLoginDeps = {},
): Promise<OAuthAccount> {
  const verifier = createVerifier();
  const state = createState();
  const port = deps.port ?? CODEX_REDIRECT_PORT;
  const pathname = deps.path ?? CODEX_REDIRECT_PATH;

  let callback;
  try {
    callback = await startCallbackServer(state, {
      port,
      path: pathname,
      timeoutMs: deps.timeoutMs,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      throw new Error(
        `port ${port} is already in use; close any running Codex login (or Codex CLI) and try again`,
      );
    }
    throw err;
  }

  try {
    const url = codexAuthorizeUrl(verifier, state, callback.redirectUri);
    deps.log?.('Open this URL in a browser and authorize miniroute:');
    deps.log?.(url);
    deps.openBrowser?.(url);

    const { code } = await callback.result;
    const tokens = await exchangeCodexCode({
      code,
      verifier,
      redirectUri: callback.redirectUri,
      fetchImpl: deps.fetchImpl,
      tokenUrl: deps.tokenUrl,
      now: deps.now,
    });
    const account: OAuthAccount = {
      id: store.makeId('codex', label),
      label,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      accountId: tokens.accountId,
      tokenType: tokens.tokenType,
    };
    store.upsert('codex', account);
    return account;
  } finally {
    callback.close();
  }
}
