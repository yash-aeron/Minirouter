import { IRRequest } from '../core/ir.js';
import {
  irToOpenAIChatRequest,
  openaiChatResponseToIR,
  openaiSSEToIREvents,
} from '../core/translate-openai.js';
import { upstreamRequest } from './http.js';
import { ProviderAdapter, ProviderSendResult } from './types.js';

export interface AdapterConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[] | null;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** Covers OpenAI, GLM, DeepSeek, Kimi, MiniMax, Groq, OpenRouter, ... */
export class OpenAICompatAdapter implements ProviderAdapter {
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
    const url = `${this.baseUrl}/chat/completions`;
    const wire = irToOpenAIChatRequest(ir, model);
    const res = await upstreamRequest(this.name, url, {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(wire),
      timeoutMs: this.timeoutMs,
    });

    if (ir.stream) {
      return { events: openaiSSEToIREvents(res.body, model) };
    }
    const json = JSON.parse(await res.text());
    return { response: openaiChatResponseToIR(json, model) };
  }
}
