/**
 * Gemini CLI (Google account) login.
 *
 * Uses a Google OAuth client supplied by the user (see README) and the Code
 * Assist backend. A Cloud project id is discovered during login and cached in
 * the account (the backend requires it on every request).
 *
 * Experimental: this is a personal Google account, not an API key.
 */
import { startCallbackServer } from './callback.js';
import { FetchLike, getJson, platformFetch, postForm, postJson } from './http.js';
import { challengeFor, createState, createVerifier } from './pkce.js';
import { OAuthAccount, RefreshedTokens, RefreshFn } from './types.js';
import { TokenStore } from './token-store.js';

export const GEMINI_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GEMINI_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GEMINI_CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
export const GEMINI_REDIRECT_PATH = '/oauth2callback';
export const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export interface GeminiClientCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolve the Google OAuth client used by login and token refresh. Explicit
 * values win over the environment; tests inject them instead of touching it.
 */
export function geminiCredentials(
  overrides: Partial<GeminiClientCredentials> = {},
): GeminiClientCredentials {
  const clientId = overrides.clientId || process.env.MINIROUTE_GEMINI_CLIENT_ID;
  const clientSecret = overrides.clientSecret || process.env.MINIROUTE_GEMINI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Gemini login needs a Google OAuth client: set MINIROUTE_GEMINI_CLIENT_ID and MINIROUTE_GEMINI_CLIENT_SECRET',
    );
  }
  return { clientId, clientSecret };
}

export function geminiAuthorizeUrl(
  verifier: string,
  state: string,
  redirectUri: string,
  clientId: string,
): string {
  const url = new URL(GEMINI_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GEMINI_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challengeFor(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

function toTokens(response: GoogleTokenResponse, now: number): RefreshedTokens {
  if (!response.access_token) throw new Error('Google token response contained no access token');
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt: now + (response.expires_in ?? 3600) * 1000,
    scope: response.scope,
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
  clientId?: string;
  clientSecret?: string;
}

export async function exchangeGeminiCode(opts: ExchangeOptions): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const { clientId, clientSecret } = geminiCredentials(opts);
  const response = await postForm<GoogleTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? GEMINI_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: opts.code,
      code_verifier: opts.verifier,
      redirect_uri: opts.redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    },
    'Gemini token exchange',
  );
  const tokens = toTokens(response, now);
  if (!tokens.refreshToken) throw new Error('Gemini did not return a refresh token');
  return tokens;
}

export interface RefreshOptions {
  fetchImpl?: FetchLike;
  tokenUrl?: string;
  now?: () => number;
  clientId?: string;
  clientSecret?: string;
}

export async function refreshGeminiToken(
  account: OAuthAccount,
  opts: RefreshOptions = {},
): Promise<RefreshedTokens> {
  const now = opts.now?.() ?? Date.now();
  const { clientId, clientSecret } = geminiCredentials(opts);
  const response = await postForm<GoogleTokenResponse>(
    opts.fetchImpl ?? platformFetch,
    opts.tokenUrl ?? GEMINI_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    },
    'Gemini token refresh',
  );
  const tokens = toTokens(response, now);
  return {
    ...tokens,
    refreshToken: tokens.refreshToken ?? account.refreshToken,
    projectId: account.projectId,
  };
}

export function geminiRefresher(opts: RefreshOptions = {}): RefreshFn {
  return (account) => refreshGeminiToken(account, opts);
}
/* ---------------------------- Code Assist project discovery ---------------------------- */

function projectIdOf(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.id === 'string' && record.id) return record.id;
    if (typeof record.projectId === 'string' && record.projectId) return record.projectId;
  }
  return undefined;
}

export interface DiscoveryOptions {
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** delay between onboarding polls; tests set 0 */
  pollMs?: number;
}

/**
 * Ask Code Assist which Cloud project this account should use. Falls back to
 * onboarding a free-tier project, as the Gemini CLI does on first run.
 */
export async function discoverGeminiProject(
  accessToken: string,
  opts: DiscoveryOptions = {},
): Promise<string | undefined> {
  const fetchImpl = opts.fetchImpl ?? platformFetch;
  const base = (opts.baseUrl ?? GEMINI_CODE_ASSIST_BASE).replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${accessToken}` };

  const loaded = await postJson<Record<string, any>>(
    fetchImpl,
    `${base}:loadCodeAssist`,
    { metadata: { pluginType: 'GEMINI_CLI' } },
    'Gemini Code Assist project lookup',
    headers,
  );
  const existing = projectIdOf(loaded.cloudaicompanionProject) ?? projectIdOf(loaded.response?.cloudaicompanionProject);
  if (existing) return existing;

  const tierId =
    (Array.isArray(loaded.allowedTiers)
      ? loaded.allowedTiers.find((tier: Record<string, unknown>) => tier?.isDefault)?.id
      : undefined) ?? 'free-tier';
  const operation = await postJson<Record<string, any>>(
    fetchImpl,
    `${base}:onboardUser`,
    { tierId, metadata: { pluginType: 'GEMINI_CLI' } },
    'Gemini Code Assist onboarding',
    headers,
  );

  let current = operation;
  const pollMs = opts.pollMs ?? 1000;
  for (let attempt = 0; attempt < 10 && !current.done; attempt += 1) {
    if (typeof current.name !== 'string') break;
    if (pollMs > 0) await new Promise((resolve) => setTimeout(resolve, pollMs));
    current = await getJson<Record<string, any>>(
      fetchImpl,
      `${base}/${current.name.replace(/^\/+/, '')}`,
      'Gemini Code Assist onboarding status',
      headers,
    );
  }
  return projectIdOf(current.response?.cloudaicompanionProject);
}

export interface GeminiLoginDeps {
  fetchImpl?: FetchLike;
  openBrowser?: (url: string) => void;
  log?: (line: string) => void;
  now?: () => number;
  tokenUrl?: string;
  port?: number;
  path?: string;
  timeoutMs?: number;
  codeAssistBaseUrl?: string;
  clientId?: string;
  clientSecret?: string;
  /** skip project discovery (tests that only exercise the token exchange) */
  skipProjectDiscovery?: boolean;
}

export async function loginGemini(
  store: TokenStore,
  label: string,
  deps: GeminiLoginDeps = {},
): Promise<OAuthAccount> {
  const { clientId, clientSecret } = geminiCredentials(deps);
  const verifier = createVerifier();
  const state = createState();
  const callback = await startCallbackServer(state, {
    port: deps.port ?? 0,
    path: deps.path ?? GEMINI_REDIRECT_PATH,
    timeoutMs: deps.timeoutMs,
  });

  try {
    const url = geminiAuthorizeUrl(verifier, state, callback.redirectUri, clientId);
    deps.log?.('Open this URL in a browser and authorize miniroute:');
    deps.log?.(url);
    deps.openBrowser?.(url);

    const { code } = await callback.result;
    const tokens = await exchangeGeminiCode({
      code,
      verifier,
      redirectUri: callback.redirectUri,
      fetchImpl: deps.fetchImpl,
      tokenUrl: deps.tokenUrl,
      now: deps.now,
      clientId,
      clientSecret,
    });

    let projectId: string | undefined;
    if (!deps.skipProjectDiscovery) {
      try {
        projectId = await discoverGeminiProject(tokens.accessToken, {
          fetchImpl: deps.fetchImpl,
          baseUrl: deps.codeAssistBaseUrl,
        });
      } catch (err) {
        // Login still succeeds; the adapter will report a clear error if the
        // backend needs a project.
        deps.log?.(`warning: could not discover a Code Assist project: ${(err as Error).message}`);
      }
    }

    const account: OAuthAccount = {
      id: store.makeId('gemini', label),
      label,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? '',
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      projectId,
      tokenType: tokens.tokenType,
    };
    store.upsert('gemini', account);
    return account;
  } finally {
    callback.close();
  }
}
