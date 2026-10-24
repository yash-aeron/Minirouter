import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyTokenSaver, compressToolText } from '../src/core/token-saver.js';
import { createApp } from '../src/server.js';
import { AppConfig } from '../src/config.js';
import { buildRegistry } from '../src/providers/registry.js';
import { Breakers } from '../src/router/breaker.js';
import { ChainResolver } from '../src/router/chain.js';
import { TokenStore } from '../src/oauth/token-store.js';
import { UsageStore } from '../src/usage/store.js';

describe('compressToolText', () => {
  it('collapses runs of identical lines with a marker', () => {
    const log = Array.from({ length: 20 }, (_, i) => (i < 5 ? `step ${i}` : 'repeated line')).join('\n');
    const result = compressToolText(log, 10);
    expect(result.savedChars).toBeGreaterThan(0);
    expect(result.text).toContain('[miniroute: collapsed 15 identical consecutive lines]');
    // kept 2 + marker
    expect(result.text.split('\n').filter((l) => l === 'repeated line')).toHaveLength(2);
  });

  it('never compresses blank-line runs (savings cannot cover the marker)', () => {
    const text = `${Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')}\n\n\n\n\n\nend`;
    expect(compressToolText(text, 10).savedChars).toBe(0);
  });

  it('leaves short or incompressible text alone', () => {
    const few = 'a\nb\nc';
    expect(compressToolText(few, 10)).toEqual({ text: few, savedChars: 0 });
    const varied = Array.from({ length: 30 }, (_, i) => `unique line ${i}`).join('\n');
    expect(compressToolText(varied, 10).savedChars).toBe(0);
  });
});

describe('applyTokenSaver', () => {
  it('compresses tool-role text blocks and reports savings', () => {
    const log = Array.from({ length: 20 }, () => 'same build line').join('\n');
    const ir = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'build it' }] },
        { role: 'tool', content: [{ type: 'text', text: log }] },
      ],
    };
    const summary = applyTokenSaver(ir as any);
    expect(summary.blocksCompressed).toBe(1);
    expect(summary.savedTokens).toBeGreaterThan(0);
    expect((ir.messages[1]!.content[0] as any).text).toContain('[miniroute: collapsed');
  });

  it('never touches user or assistant text', () => {
    const log = Array.from({ length: 20 }, () => 'dup').join('\n');
    const ir = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: log }] },
        { role: 'assistant', content: [{ type: 'text', text: log }] },
      ],
    };
    const summary = applyTokenSaver(ir as any);
    expect(summary.blocksCompressed).toBe(0);
  });
});

/* ---------------- /v1/status and /dashboard ---------------- */

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-dash-'));
const apiKey = 'dash-key';

const tokenStore = new TokenStore(path.join(tmpDataDir, 'oauth.json'));
tokenStore.upsert('claude', {
  id: 'claude-main',
  label: 'main',
  accessToken: 'at-test',
  refreshToken: 'rt-test',
  expiresAt: Date.now() + 3600_000,
});

function makeApp(config: AppConfig) {
  return createApp({
    configPath: 'unused',
    apiKey,
    authEnabled: true,
    state: {
      config,
      registry: buildRegistry(config, { tokenStore }),
      breakers: new Breakers(),
      chain: new ChainResolver(config),
      usage: new UsageStore(tmpDataDir),
      tokenStore,
    },
    rebuild: () => {},
  });
}

const config: AppConfig = {
  providers: [
    { name: 'glm', type: 'openai-compat', models: ['glm-4.7'] },
    { name: 'sub', type: 'anthropic', auth: 'oauth', accounts: ['claude-main'] },
  ],
  tokenSaver: { minLines: 5 },
};

describe('dashboard and status', () => {
  let app: ReturnType<typeof makeApp>;

  beforeAll(() => {
    app = makeApp(config);
  });

  it('serves the dashboard shell without auth and without data', async () => {
    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('miniroute');
    expect(html).toContain('Local API key required');
    expect(html).not.toContain('glm-4.7');
  });

  it('/v1/status is behind auth', async () => {
    const res = await app.request('/v1/status');
    expect(res.status).toBe(401);
  });

  it('/v1/status reports providers, breakers, and token-saver settings', async () => {
    const res = await app.request('/v1/status', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const status = await res.json();
    expect(status.tokenSaver).toEqual({ enabled: true, minLines: 5 });
    expect(status.providers).toHaveLength(2);
    const glm = status.providers.find((p: any) => p.name === 'glm');
    expect(glm).toMatchObject({ type: 'openai-compat', auth: 'api-key', accounts: '-' });
    expect(glm.breaker).toEqual({ consecutiveFailures: 0, open: false, cooldownMsLeft: 0 });
    const sub = status.providers.find((p: any) => p.name === 'sub');
    expect(sub.auth).toBe('oauth');
    expect(sub.accounts).toContain('claude account(s)');
  });
});
