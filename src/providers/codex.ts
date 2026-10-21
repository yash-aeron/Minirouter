/**
 * Codex adapter: OpenAI Responses request shape against the ChatGPT Codex
 * backend, authenticated with a Codex CLI OAuth account.
 *
 * Experimental. The backend is not a public API; fields and headers mirror the
 * official CLI and may change without notice.
 */
import { IRRequest } from '../core/ir.js';
import {
  irToResponsesRequest,
  responsesResponseToIR,
  responsesSSEToIREvents,
} from '../core/translate-responses.js';
import { OAuthPool } from '../oauth/pool.js';
import { upstreamRequest } from './http.js';
import { AdapterConfig } from './openai-compat.js';
import { ProviderAdapter, ProviderSendResult, ProviderError } from './types.js';

export class CodexAdapter implements ProviderAdapter {
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
    const url = `${this.baseUrl}/responses`;
    const wire = { ...irToResponsesRequest(ir, model), store: false };

    const { result } = await this.pool.run(async (account) => {
      const res = await upstreamRequest(this.name, url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.accessToken}`,
          'openai-beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          'user-agent': 'miniroute',
          ...(account.accountId ? { 'chatgpt-account-id': account.accountId } : {}),
          ...this.extraHeaders,
        },
        body: JSON.stringify(wire),
        timeoutMs: this.timeoutMs,
      });

      if (ir.stream) {
        return { events: responsesSSEToIREvents(res.body) } satisfies ProviderSendResult;
      }
      const json = JSON.parse(await res.text());
      if (json.error) {
        throw new ProviderError(String(json.error.message ?? 'Codex upstream error'), {
          status: 502,
          retryable: true,
          provider: this.name,
          rawBody: JSON.stringify(json),
        });
      }
      return { response: responsesResponseToIR(json, model) } satisfies ProviderSendResult;
    });
    return result;
  }
}
