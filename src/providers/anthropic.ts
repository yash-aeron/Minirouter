import { IRRequest } from '../core/ir.js';
import {
  anthropicRequestToIR,
  anthropicResponseToIR,
  anthropicSSEToIREvents,
  irToAnthropicRequest,
} from '../core/translate-anthropic.js';
import { upstreamRequest } from './http.js';
import { AdapterConfig } from './openai-compat.js';
import { ProviderAdapter, ProviderSendResult } from './types.js';

/** Native Anthropic API provider. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name: string;
  readonly models: string[] | null;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs?: number;
  private readonly extraHeaders: Record<string, string>;

  constructor(cfg: AdapterConfig) {
    this.name = cfg.name;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.apiKey = cfg.apiKey;
    this.models = cfg.models && cfg.models.length ? cfg.models : null;
    this.timeoutMs = cfg.timeoutMs;
    this.extraHeaders = cfg.headers ?? {};
  }

  async send(ir: IRRequest, model: string): Promise<ProviderSendResult> {
    const url = `${this.baseUrl}/v1/messages`;
    const wire = irToAnthropicRequest(ir, model);
    // Forward the client's anthropic-* headers verbatim: beta capabilities are
    // paired with body fields, and stripping them silently disables features.
    const passthrough = ir.clientHeaders ?? {};
    const res = await upstreamRequest(this.name, url, {
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': passthrough['anthropic-version'] ?? '2023-06-01',
        ...passthrough,
        ...this.extraHeaders,
      },
      body: JSON.stringify(wire),
      timeoutMs: this.timeoutMs,
    });

    if (ir.stream) {
      return { events: anthropicSSEToIREvents(res.body) };
    }
    const json = JSON.parse(await res.text());
    return { response: anthropicResponseToIR(json, model) };
  }
}

// anthropicRequestToIR is re-exported for tests; keep tsc honest about usage.
export { anthropicRequestToIR };
