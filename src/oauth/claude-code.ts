/**
 * Claude Code subscription login.
 *
 * Mirrors the official CLI's public OAuth client. The flow is a paste-the-code
 * flow: the browser shows `code#state`, which the user pastes back.
 *
 * This uses a personal Claude subscription, not an API key. Anthropic's terms
 * may not permit third-party clients; opt in deliberately.
 */
import { challengeFor, createState, createVerifier } from './pkce.js';
import { FetchLike, platformFetch, postJson } from './http.js';
import { OAuthAccount, RefreshedTokens, RefreshFn } from './types.js';
import { TokenStore } from './token-store.js';

export const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
export const CLAUDE_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
export const CLAUDE_OAUTH_PROVIDER = 'claude' as const;

export function claudeAuthorizeUrl(verifier: string, state: string): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
  url.searchParams.set('scope', CLAUDE_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

interface ClaudeTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  account?: { uuid?: string; id?: string } | string;
}

export interface ExchangeOptions {
  code: string;
  verifier: string;
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  now?: () => number;
}

function accountIdOf(response: ClaudeTokenResponse): string | undefined {
  if (typeof response.account === 'string') return response.account;
  return response.account?.uuid ?? response.account?.id;
}

export async function exchangeClaudeCode(opts: ExchangeOptions): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const response = await postJson<ClaudeTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? CLAUDE_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: opts.verifier,
    },
    'Claude Code token exchange',
  );
  if (!response.access_token) throw new Error('Claude Code token exchange returned no access token');
  if (!response.refresh_token) throw new Error('Claude Code token exchange returned no refresh token');
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now + (response.expires_in ?? 3600) * 1000,
    scope: response.scope,
    accountId: accountIdOf(response),
    tokenType: response.token_type ?? 'Bearer',
  };
}

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  now?: () => number;
}

export async function refreshClaudeToken(
  account: OAuthAccount,
  opts: RefreshOptions = {},
): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const response = await postJson<ClaudeTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? CLAUDE_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: CLAUDE_CLIENT_ID,
    },
    'Claude Code token refresh',
  );
  if (!response.access_token) throw new Error('Claude Code token refresh returned no access token');
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now + (response.expires_in ?? 3600) * 1000,
    scope: response.scope ?? account.scope,
    accountId: accountIdOf(response) ?? account.accountId,
    tokenType: response.token_type ?? account.tokenType ?? 'Bearer',
  };
}

export function claudeRefresher(opts: RefreshOptions = {}): RefreshFn {
  return (account) => refreshClaudeToken(account, opts);
}

export interface LoginDeps {  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => void;
  prompt: (question: string) => Promise<string>;
  log?: (line: string) => void;
  now?: () => number;
  tokenUrl?: string;
}

/** Interactive login. Returns the stored account (tokens are never printed). */
export async function loginClaude(
  store: TokenStore,
  label: string,
  deps: LoginDeps,
): Promise<OAuthAccount> {
  const verifier = createVerifier();
  const state = createState();
  const url = claudeAuthorizeUrl(verifier, state);

  deps.log?.('Open this URL in a browser and authorize miniroute:');
  deps.log?.(url);
  deps.openBrowser?.(url);

  const pasted = (await deps.prompt('Paste the authorization code:')).trim();
  if (!pasted) throw new Error('no authorization code provided');
  const [code, pastedState] = pasted.split('#');
  if (!code) throw new Error('no authorization code provided');
  if (pastedState && pastedState !== state) {
    throw new Error('OAuth state mismatch; start the login again');
  }

  const tokens = await exchangeClaudeCode({
    code,
    verifier,
    fetchImpl: deps.fetchImpl,
    tokenUrl: deps.tokenUrl,
    now: deps.now,
  });
  if (!tokens.refreshToken) throw new Error('Claude did not return a refresh token');

  const account: OAuthAccount = {
    id: store.makeId('claude', label),
    label,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    accountId: tokens.accountId,
    tokenType: tokens.tokenType,
  };
  store.upsert('claude', account);
  return account;
}
