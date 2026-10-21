/** Resolve a client-requested model into an ordered fallback chain. */
import { AppConfig } from '../config.js';

export interface Candidate {
  provider: string;
  model: string;
}

export class ChainResolver {
  constructor(private readonly config: AppConfig) {}

  /** Returns candidates for a model name. Throws if nothing can serve it. */
  resolve(requestedModel: string): Candidate[] {
    const chain = this.config.routes?.[requestedModel];
    if (chain?.length) return this.expand(chain);

    const prefixed = this.parsePrefixed(requestedModel);
    if (prefixed) {
      const [providerName, rest] = prefixed;
      if (this.config.providers.some((p) => p.name === providerName)) {
        return [{ provider: providerName, model: rest }];
      }
    }

    // Unprefixed: any provider whose allowlist contains the model, in config order.
    const matches: Candidate[] = [];
    for (const p of this.config.providers) {
      if (!p.models || p.models.includes(requestedModel)) {
        matches.push({ provider: p.name, model: requestedModel });
      }
    }
    if (matches.length) return matches;

    throw new Error(
      `no provider can serve model "${requestedModel}": not a route alias, not provider-prefixed, and no provider allowlist contains it`,
    );
  }

  private expand(chain: string[]): Candidate[] {
    const out: Candidate[] = [];
    for (const entry of chain) {
      const prefixed = this.parsePrefixed(entry);
      if (!prefixed) {
        // route entry referencing another route is not supported; ignore
        continue;
      }
      const [providerName, model] = prefixed;
      if (this.config.providers.some((p) => p.name === providerName)) {
        out.push({ provider: providerName, model });
      }
    }
    return out;
  }

  private parsePrefixed(name: string): [string, string] | null {
    const idx = name.indexOf('/');
    if (idx <= 0 || idx === name.length - 1) return null;
    return [name.slice(0, idx), name.slice(idx + 1)];
  }

  /** All known model ids for /v1/models: prefixed provider models + route aliases. */
  listModels(): string[] {
    const out = new Set<string>();
    for (const p of this.config.providers) {
      for (const m of p.models ?? []) out.add(`${p.name}/${m}`);
    }
    for (const alias of Object.keys(this.config.routes ?? {})) out.add(alias);
    return [...out].sort();
  }
}
