/**
 * Claude subscription adapter: native Anthropic messages endpoint, but
 * authenticated with an OAuth bearer token from the account pool.
 *
 * OAuth requests must not send `x-api-key`; they need the OAuth beta flag and
 * `Authorization: Bearer`. Client betas are merged in, not replaced.
 */
import { IRRequest } from '../core/ir.js';
import {
  anthropicResponseToIR,
  anthropicSSEToIREvents,
  irToAnthropicRequest,
} from '../core/translate-anthropic.js';
import { CLAUDE_OAUTH_BETA } from '../oauth/claude-code.js';
import { OAuthPool } from '../oauth/pool.js';
import { upstreamRequest } from './http.js';
import { AdapterConfig } from './openai-compat.js';
import { ProviderAdapter, ProviderSendResult } from './types.js';

export class ClaudeOAuthAdapter implements ProviderAdapter {
  readonly name: string;
  readonly models: string[] | null;
  private readonly baseUrl: string;
  private readonly timeoutMs?: number;
  private readonly extraHeaders: Record<string, string>;
  private readonly pool: OAuthPool;

  constructor(cfg: AdapterConfig, pool: OAuthPool) {
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.models = cfg.models && cfg.models.length ? cfg.models : null;
    this.timeoutMs = cfg.timeoutMs;
    this.extraHeaders = cfg.headers ?? {};
    this.pool = pool;
  }

  async send(ir: IRRequest, model: string): Promise<ProviderSendResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const wire = irToAnthropicRequest(ir, model);
    const passthrough = { ...(ir.clientHeaders ?? {}) };
    delete passthrough['x-api-key'];
    delete passthrough.authorization;

    const { result } = await this.pool.run(async (account) => {
      const res = await upstreamRequest(this.name, url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.accessToken}`,
          'anthropic-version': passthrough['anthropic-version'] ?? '2023-06-01',
          ...passthrough,
          'anthropic-beta': mergeBetas(passthrough['anthropic-beta'], CLAUDE_OAUTH_BETA),
          ...this.extraHeaders,
        },
        body: JSON.stringify(wire),
        timeoutMs: this.timeoutMs,
      });

      if (ir.stream) {
        return { events: anthropicSSEToIREvents(res.body) } satisfies ProviderSendResult;
      }
      const json = JSON.parse(await res.text());
      return { response: anthropicResponseToIR(json, model) } satisfies ProviderSendResult;
    });
    return result;
  }
}

/** Merge comma-separated beta flags, preserving client order and adding `required`. */
export function mergeBetas(existing: string | undefined, required: string): string {
  const values = (existing ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  if (!values.includes(required)) values.push(required);
  return values.join(',');
}
