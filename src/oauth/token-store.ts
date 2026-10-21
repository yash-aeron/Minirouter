/**
 * Durable OAuth account store: one JSON file in the data dir, written
 * atomically (temp file + rename) with 0600 permissions where the platform
 * supports them. Tokens only ever live in this file.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactText } from './redact.js';
import { OAuthAccount, OAuthProvider, TokenFile } from './types.js';

export class TokenStoreError extends Error {
  constructor(message: string) {
    super(redactText(message));
    this.name = 'TokenStoreError';
  }
}

function isAccount(value: unknown): value is OAuthAccount {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.accessToken === 'string' &&
    typeof a.refreshToken === 'string' &&
    typeof a.expiresAt === 'number' &&
    Number.isFinite(a.expiresAt)
  );
}

export class TokenStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): TokenFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: {} };
      throw new TokenStoreError(`cannot read ${this.filePath}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new TokenStoreError(`${this.filePath} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== 'object' || !(parsed as any).accounts || typeof (parsed as any).accounts !== 'object') {
      throw new TokenStoreError(`${this.filePath} is missing an "accounts" object`);
    }
    const accounts: TokenFile['accounts'] = {};
    for (const [provider, list] of Object.entries((parsed as any).accounts as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      const valid = list.filter(isAccount);
      if (valid.length !== list.length) {
        throw new TokenStoreError(`${this.filePath} has malformed ${provider} account entries`);
      }
      accounts[provider as OAuthProvider] = valid;
    }
    return { accounts };
  }

  /** Atomic write: a crash can leave a temp file behind, never a truncated store. */
  save(file: TokenFile): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    const payload = `${JSON.stringify(file, null, 2)}\n`;
    try {
      fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best effort; the store itself is untouched
      }
      throw new TokenStoreError(`cannot write ${this.filePath}: ${(err as Error).message}`);
    }
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Windows: ACLs apply instead of POSIX mode bits
    }
  }

  list(provider: OAuthProvider): OAuthAccount[] {
    return [...(this.load().accounts[provider] ?? [])];
  }

  get(provider: OAuthProvider, id: string): OAuthAccount | undefined {
    return this.list(provider).find((a) => a.id === id);
  }

  /** Resolve a config entry by id first, then by label (case-insensitive). */
  resolve(provider: OAuthProvider, spec: string): OAuthAccount | undefined {
    const accounts = this.list(provider);
    return (
      accounts.find((a) => a.id === spec) ??
      accounts.find((a) => a.label.toLowerCase() === spec.toLowerCase())
    );
  }

  resolveOrThrow(provider: OAuthProvider, spec: string): OAuthAccount {
    const account = this.resolve(provider, spec);
    if (!account) {
      throw new TokenStoreError(
        `no ${provider} account named "${spec}"; run "miniroute auth login ${provider}" or "miniroute auth list"`,
      );
    }
    return account;
  }

  upsert(provider: OAuthProvider, account: OAuthAccount): void {
    const file = this.load();
    const list = file.accounts[provider] ?? [];
    const index = list.findIndex((a) => a.id === account.id);
    if (index === -1) list.push(account);
    else list[index] = account;
    file.accounts[provider] = list;
    this.save(file);
  }

  update(provider: OAuthProvider, id: string, patch: Partial<OAuthAccount>): OAuthAccount | undefined {
    const file = this.load();
    const list = file.accounts[provider] ?? [];
    const index = list.findIndex((a) => a.id === id);
    if (index === -1) return undefined;
    const updated = { ...list[index]!, ...patch, id: list[index]!.id };
    list[index] = updated;
    file.accounts[provider] = list;
    this.save(file);
    return updated;
  }

  remove(provider: OAuthProvider, id: string): boolean {
    const file = this.load();
    const list = file.accounts[provider] ?? [];
    const next = list.filter((a) => a.id !== id);
    if (next.length === list.length) return false;
    file.accounts[provider] = next;
    this.save(file);
    return true;
  }

  /** Remove by id across providers; the CLI accepts a bare account id. */
  removeAny(id: string): OAuthProvider | null {
    const file = this.load();
    for (const provider of Object.keys(file.accounts) as OAuthProvider[]) {
      const list = file.accounts[provider] ?? [];
      const next = list.filter(
        (a) => a.id !== id && a.label.toLowerCase() !== id.toLowerCase(),
      );
      if (next.length !== list.length) {
        file.accounts[provider] = next;
        this.save(file);
        return provider;
      }
    }
    return null;
  }

  /** Every account, flattened (used by `auth list` and `auth refresh`). */
  all(): Array<{ provider: OAuthProvider; account: OAuthAccount }> {
    const file = this.load();
    const out: Array<{ provider: OAuthProvider; account: OAuthAccount }> = [];
    for (const [provider, list] of Object.entries(file.accounts)) {
      for (const account of list ?? []) out.push({ provider: provider as OAuthProvider, account });
    }
    return out;
  }

  /** Generate a stable, human-readable id that does not collide. */
  makeId(provider: OAuthProvider, label: string): string {
    const base = `${provider}-${slug(label) || 'account'}`;
    const existing = new Set(this.list(provider).map((a) => a.id));
    if (!existing.has(base)) return base;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
    return `${base}-${crypto.randomBytes(3).toString('hex')}`;
  }
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
