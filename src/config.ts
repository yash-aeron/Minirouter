import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';

const providerSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'provider name: alphanumerics, - and _'),
  type: z.enum(['openai-compat', 'anthropic', 'gemini']),
  baseUrl: z.string().url().optional(),
  /** literal key, or "env:VAR_NAME" to read from the environment (preferred) */
  apiKey: z.string().optional(),
  models: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  headers: z.record(z.string()).optional(),
});

export const configSchema = z.object({
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  auth: z.boolean().optional(),
  dataDir: z.string().optional(),
  providers: z.array(providerSchema).min(1),
  routes: z.record(z.string(), z.array(z.string())).optional(),
});

export type AppConfig = z.infer<typeof configSchema>;

export function defaultDataDir(): string {
  return process.env.MINIROUTE_HOME ?? path.join(os.homedir(), '.miniroute');
}

export function defaultConfigPath(): string {
  return path.join(defaultDataDir(), 'config.json');
}

export interface LoadedConfig {
  config: AppConfig;
  warnings: string[];
}

export function loadConfig(filePath: string): LoadedConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`config is not valid JSON: ${filePath}: ${err instanceof Error ? err.message : err}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid config ${filePath}: ${issues}`);
  }
  const config = result.data;

  const warnings: string[] = [];
  const names = new Set<string>();
  for (const p of config.providers) {
    if (names.has(p.name)) throw new Error(`invalid config: duplicate provider name "${p.name}"`);
    names.add(p.name);
    if (p.apiKey?.startsWith('env:')) {
      const varName = p.apiKey.slice(4);
      if (!process.env[varName]) warnings.push(`provider "${p.name}": ${varName} is not set`);
    } else if (!p.apiKey) {
      warnings.push(`provider "${p.name}": no apiKey configured`);
    }
  }
  return { config, warnings };
}

export function resolveApiKey(spec: string | undefined): string {
  if (!spec) return '';
  if (spec.startsWith('env:')) return process.env[spec.slice(4)] ?? '';
  return spec;
}

export const DEFAULT_BASE_URLS: Record<AppConfig['providers'][number]['type'], string> = {
  'openai-compat': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

/** Debounced config watcher; returns a stop function. */
export function watchConfig(filePath: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(filePath, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
  } catch {
    // config may not exist yet; reload is best-effort
  }
  return () => {
    clearTimeout(timer);
    watcher?.close();
  };
}
