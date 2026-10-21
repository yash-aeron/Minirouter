import { AppConfig, DEFAULT_BASE_URLS, resolveApiKey } from '../config.js';
import { ProviderAdapter } from './types.js';
import { OpenAICompatAdapter } from './openai-compat.js';
import { AnthropicAdapter } from './anthropic.js';
import { GeminiAdapter } from './gemini.js';

export type Registry = Map<string, ProviderAdapter>;

export function buildRegistry(config: AppConfig): Registry {
  const registry: Registry = new Map();
  for (const p of config.providers) {
    const cfg = {
      name: p.name,
      baseUrl: p.baseUrl ?? DEFAULT_BASE_URLS[p.type],
      apiKey: resolveApiKey(p.apiKey),
      models: p.models ?? null,
      timeoutMs: p.timeoutMs,
      headers: p.headers,
    };
    const adapter =
      p.type === 'anthropic'
        ? new AnthropicAdapter(cfg)
        : p.type === 'gemini'
          ? new GeminiAdapter(cfg)
          : new OpenAICompatAdapter(cfg);
    registry.set(p.name, adapter);
  }
  return registry;
}
