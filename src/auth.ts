/**
 * Local API key: generated randomly on first run and persisted 0600 — never a
 * shipped default (9Router's CVE-2026-49352 was a hardcoded fallback secret).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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

export function checkAuth(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
