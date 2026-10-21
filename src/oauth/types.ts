/**
 * OAuth subscription pooling: shared types.
 *
 * These accounts are personal subscriptions (Claude Code, Codex, Gemini CLI),
 * not API keys. They are opt-in, stored locally, and never logged.
 */

export type OAuthProvider = 'claude' | 'codex' | 'gemini';

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = ['claude', 'codex', 'gemini'];

export interface OAuthAccount {
  /** local, stable id used in config (`accounts: ["work"]`) and `auth remove` */
  id: string;
  label: string;
  accessToken: string;
  refreshToken: string;
  /** epoch milliseconds */
  expiresAt: number;
  scope?: string;
  /** provider-side account id (Claude organization/account uuid, ChatGPT account id) */
  accountId?: string;
  /** Google Cloud project id used by the Code Assist backend */
  projectId?: string;
  tokenType?: string;
}

export interface TokenFile {
  accounts: Partial<Record<OAuthProvider, OAuthAccount[]>>;
}

/** A token refresh result, merged into the stored account. */
export interface RefreshedTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  accountId?: string;
  projectId?: string;
  tokenType?: string;
}

export type RefreshFn = (account: OAuthAccount) => Promise<RefreshedTokens>;

/** Public view of an account: `auth list` prints exactly these fields. */
export interface AccountSummary {
  id: string;
  provider: OAuthProvider;
  label: string;
  expiresAt: string;
  expired: boolean;
  accountId?: string;
  projectId?: string;
}

export function summarizeAccount(provider: OAuthProvider, account: OAuthAccount, now = Date.now()): AccountSummary {
  return {
    id: account.id,
    provider,
    label: account.label,
    expiresAt: new Date(account.expiresAt).toISOString(),
    expired: account.expiresAt <= now,
    ...(account.accountId ? { accountId: account.accountId } : {}),
    ...(account.projectId ? { projectId: account.projectId } : {}),
  };
}

/** Provider names as they appear in CLI output and config. */
export const OAUTH_PROVIDER_LABEL: Record<OAuthProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

export function isOAuthProvider(value: string): value is OAuthProvider {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}
