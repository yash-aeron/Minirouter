/** Resolve a client-requested model into an ordered fallback chain. */
import { AppConfig } from '../config.js';

export interface Candidate {
  provider: string;
  model: string;
}

export class ChainResolver {
  constructor(private readonly config: AppConfig) {}

  /**
   * Returns candidates for a model name. Throws if nothing can serve it.
   * Entries that cannot be used are reported through `warnings` rather than
   * being dropped silently, so a typo cannot quietly shorten a fallback chain.
   */
  resolve(requestedModel: string, warnings: string[] = []): Candidate[] {
    const chain = this.config.routes?.[requestedModel];
    if (chain?.length) {
      const candidates = this.expand(chain, warnings);
      if (!candidates.length) {
        throw new Error(
          `route "${requestedModel}" resolves to no usable candidates` +
            (warnings.length ? `: ${warnings.join('; ')}` : ''),
        );
      }
      return candidates;
    }

    const prefixed = this.parsePrefixed(requestedModel);
    if (prefixed) {
      const [providerName, rest] = prefixed;
      if (this.config.providers.some((p) => p.name === providerName)) {
        return [{ provider: providerName, model: rest }];
      }
      warnings.push(
        `model "${requestedModel}" is provider-prefixed but provider "${providerName}" is not configured`,
      );
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

  private expand(chain: string[], warnings: string[]): Candidate[] {
    const out: Candidate[] = [];
    for (const entry of chain) {
      const prefixed = this.parsePrefixed(entry);
      if (!prefixed) {
        warnings.push(`route entry "${entry}" is not provider-prefixed and was ignored`);
        continue;
      }
      const [providerName, model] = prefixed;
      if (!this.config.providers.some((p) => p.name === providerName)) {
        warnings.push(`route entry "${entry}" references unknown provider "${providerName}" and was ignored`);
        continue;
      }
      out.push({ provider: providerName, model });
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
