import { IRRequest } from '../core/ir.js';
import {
  geminiResponseToIR,
  geminiSSEToIREvents,
  irToGeminiRequest,
} from '../core/translate-gemini.js';
import { upstreamRequest } from './http.js';
import { AdapterConfig } from './openai-compat.js';
import { ProviderAdapter, ProviderSendResult } from './types.js';

/** Native Google Gemini (generativelanguage) API provider. */
export class GeminiAdapter implements ProviderAdapter {
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
    const method = ir.stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${this.baseUrl}/models/${encodeURIComponent(model)}:${method}`;
    const wire = irToGeminiRequest(ir);
    const res = await upstreamRequest(this.name, url, {
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.apiKey,
        ...this.extraHeaders,
      },
      body: JSON.stringify(wire),
      timeoutMs: this.timeoutMs,
    });

    if (ir.stream) {
      return { events: geminiSSEToIREvents(res.body) };
    }
    const json = JSON.parse(await res.text());
    return { response: geminiResponseToIR(json, model) };
  }
}
