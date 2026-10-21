/**
 * Local API key: generated randomly on first run and persisted 0600 — never a
 * shipped default (9Router's CVE-2026-49352 was a hardcoded fallback secret).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface ClientCredentials {
  /** `Authorization: Bearer <key>` */
  authorization?: string;
  /** `x-api-key: <key>` — what Anthropic SDKs and Claude Code send */
  xApiKey?: string;
}

export function ensureApiKey(dataDir: string): string {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'api-key');
  if (fs.existsSync(file)) {
    const key = fs.readFileSync(file, 'utf8').trim();
    if (key) return key;
  }
  const key = `mr-${crypto.randomBytes(24).toString('base64url')}`;
  fs.writeFileSync(file, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: chmod is a no-op best-effort; ACLs apply instead
  }
  return key;
}

export function checkAuth(creds: ClientCredentials, expected: string): boolean {
  const candidates: string[] = [];
  const header = creds.authorization;
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) candidates.push(m[1]!);
  }
  if (creds.xApiKey) candidates.push(creds.xApiKey.trim());
  return candidates.some((candidate) => safeEqual(candidate, expected));
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
