/**
 * Usage log backed by node:sqlite (bundled with Node >= 22, no native build).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface UsageRecord {
  ts: number;
  route: string;
  provider: string;
  model: string;
  stream: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export class UsageStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'usage.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        ts INTEGER NOT NULL,
        route TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        stream INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT,
        duration_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
    `);
  }

  insert(r: UsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO requests
         (ts, route, provider, model, stream, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, ok, error, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.ts,
        r.route,
        r.provider,
        r.model,
        r.stream ? 1 : 0,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.ok ? 1 : 0,
        r.error ?? null,
        r.durationMs,
      );
  }

  summary(): Record<string, unknown> {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN ok THEN 1 ELSE 0 END), 0) AS ok_requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
         FROM requests`,
      )
      .get() as Record<string, number>;
    const byProvider = this.db
      .prepare(
        `SELECT provider, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM requests GROUP BY provider ORDER BY requests DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const byModel = this.db
      .prepare(
        `SELECT model, COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM requests GROUP BY model ORDER BY requests DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    const recent = this.db
      .prepare(
        `SELECT ts, route, provider, model, stream, input_tokens, output_tokens,
                cache_read_tokens, cache_write_tokens, ok, error, duration_ms
         FROM requests ORDER BY ts DESC LIMIT 50`,
      )
      .all() as Array<Record<string, unknown>>;
    return { totals, byProvider, byModel, recent };
  }

  close(): void {
    this.db.close();
  }
}
