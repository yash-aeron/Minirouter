/**
 * Gemini CLI adapter: Google Code Assist backend (`cloudcode-pa.googleapis.com`),
 * authenticated with a Gemini CLI OAuth account and scoped to a Cloud project.
 *
 * The backend wraps the native Gemini payload in `{ model, project, request }`
 * and wraps responses in `{ response: ... }`; this adapter unwraps both so the
 * existing Gemini translators can be reused.
 *
 * Experimental. Not a public API.
 */
import { IRRequest, IRStreamEvent } from '../core/ir.js';
import { parseSSE, sseFormat } from '../core/sse.js';
import { geminiResponseToIR, geminiSSEToIREvents, irToGeminiRequest } from '../core/translate-gemini.js';
import { OAuthPool } from '../oauth/pool.js';
import { upstreamRequest } from './http.js';
import { AdapterConfig } from './openai-compat.js';
import { ProviderAdapter, ProviderError, ProviderSendResult } from './types.js';

export class GeminiCliAdapter implements ProviderAdapter {
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
    const stream = ir.stream;
    const url = stream ? `${this.baseUrl}:streamGenerateContent?alt=sse` : `${this.baseUrl}:generateContent`;

    const { result } = await this.pool.run(async (account) => {
      if (!account.projectId) {
        throw new ProviderError(
          `${this.name}: account "${account.label}" has no Code Assist project; run "miniroute auth login gemini" again`,
          { status: 400, retryable: false, provider: this.name },
        );
      }
      const wire = {
        model,
        project: account.projectId,
        request: irToGeminiRequest(ir),
      };
      const res = await upstreamRequest(this.name, url, {
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.accessToken}`,
          'user-agent': 'miniroute',
          ...this.extraHeaders,
        },
        body: JSON.stringify(wire),
        timeoutMs: this.timeoutMs,
      });

      if (stream) {
        const events: AsyncIterable<IRStreamEvent> = geminiSSEToIREvents(unwrapCodeAssistSSE(res.body));
        return { events } satisfies ProviderSendResult;
      }
      const json = JSON.parse(await res.text());
      const inner = json.response ?? json;
      if (inner?.error) {
        throw new ProviderError(String(inner.error.message ?? 'Gemini upstream error'), {
          status: 502,
          retryable: true,
          provider: this.name,
          rawBody: JSON.stringify(inner),
        });
      }
      return { response: geminiResponseToIR(inner, model) } satisfies ProviderSendResult;
    });
    return result;
  }
}

/** Strip the Code Assist `{ response: ... }` envelope, re-emitting plain Gemini SSE. */
export async function* unwrapCodeAssistSSE(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  for await (const event of parseSSE(body)) {
    let parsed: any;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      continue;
    }
    const inner = parsed?.response ?? parsed;
    yield encoder.encode(sseFormat(JSON.stringify(inner)));
  }
}
