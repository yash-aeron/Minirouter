import * as path from 'node:path';
import { AppConfig, DEFAULT_BASE_URLS, defaultDataDir, resolveApiKey } from '../config.js';
import { claudeRefresher } from '../oauth/claude-code.js';
import { codexRefresher } from '../oauth/codex.js';
import { geminiRefresher } from '../oauth/gemini-cli.js';
import { OAuthPool } from '../oauth/pool.js';
import { TokenStore } from '../oauth/token-store.js';
import { ClaudeOAuthAdapter } from './claude-oauth.js';
import { CodexAdapter } from './codex.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { GeminiAdapter } from './gemini.js';
import { AnthropicAdapter } from './anthropic.js';
import { OpenAICompatAdapter } from './openai-compat.js';
import { ProviderAdapter } from './types.js';

export type Registry = Map<string, ProviderAdapter>;

export interface RegistryOptions {
  /** where oauth.json lives; defaults to the config's dataDir, then MINIROUTE_HOME */
  dataDir?: string;
  /** inject a store in tests */
  tokenStore?: TokenStore;
}

export function buildRegistry(config: AppConfig, opts: RegistryOptions = {}): Registry {
  const registry: Registry = new Map();
  const store = opts.tokenStore
    ? opts.tokenStore
    : new TokenStore(
        path.join(opts.dataDir ?? config.dataDir ?? defaultDataDir(), 'oauth.json'),
      );

  for (const p of config.providers) {
    const cfg = {
      name: p.name,
      baseUrl: p.baseUrl ?? DEFAULT_BASE_URLS[p.type],
      apiKey: resolveApiKey(p.apiKey),
      models: p.models ?? null,
      timeoutMs: p.timeoutMs,
      headers: p.headers,
    };

    let adapter: ProviderAdapter;
    if (p.auth === 'oauth') {
      const accounts = p.accounts ?? [];
      adapter = buildOAuthAdapter(p.type, p.name, cfg, store, accounts);
    } else {
      adapter =
        p.type === 'anthropic'
          ? new AnthropicAdapter(cfg)
          : p.type === 'gemini'
            ? new GeminiAdapter(cfg)
            : new OpenAICompatAdapter(cfg);
    }
    registry.set(p.name, adapter);
  }
  return registry;
}

function buildOAuthAdapter(
  type: AppConfig['providers'][number]['type'],
  name: string,
  cfg: { name: string; baseUrl: string; apiKey: string; models: string[] | null; timeoutMs?: number; headers?: Record<string, string> },
  store: TokenStore,
  accounts: string[],
): ProviderAdapter {
  switch (type) {
    case 'anthropic': {
      const pool = new OAuthPool('claude', store, accounts, {
        refresh: claudeRefresher(),
        label: name,
      });
      return new ClaudeOAuthAdapter(cfg, pool);
    }
    case 'codex': {
      const pool = new OAuthPool('codex', store, accounts, {
        refresh: codexRefresher(),
        label: name,
      });
      return new CodexAdapter(cfg, pool);
    }
    case 'gemini-cli': {
      const pool = new OAuthPool('gemini', store, accounts, {
        refresh: geminiRefresher(),
        label: name,
      });
      return new GeminiCliAdapter(cfg, pool);
    }
    default:
      throw new Error(`provider "${name}": auth "oauth" is not supported for type "${type}"`);
  }
}
