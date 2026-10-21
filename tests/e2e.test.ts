import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server.js';
import { AppConfig } from '../src/config.js';
import { buildRegistry } from '../src/providers/registry.js';
import { Breakers } from '../src/router/breaker.js';
import { ChainResolver } from '../src/router/chain.js';
import { UsageStore } from '../src/usage/store.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let upstream: http.Server;
let upstreamUrl: string;
let requestLog: Array<{ path: string; auth: string | undefined; body: any }> = [];

const enc = new TextEncoder();

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data || '{}');
      requestLog.push({ path: req.url ?? '', auth: req.headers.authorization, body });
      if (req.url?.includes('/flaky')) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      if (req.url?.includes('/chat/completions')) {
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (d: unknown) => `data: ${JSON.stringify(d)}\n\n`;
          res.write(chunk({ choices: [{ delta: { role: 'assistant', content: 'stream-' } }] }));
          res.write(chunk({ choices: [{ delta: { content: 'ok' } }] }));
          res.write(chunk({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3 } }));
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address() as AddressInfo;
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  upstream.close();
});

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-test-'));

function makeApp(config: AppConfig, apiKey: string, authEnabled = true) {
  return createApp({
    configPath: 'unused',
    apiKey,
    authEnabled,
    state: {
      config,
      registry: buildRegistry(config),
      breakers: new Breakers(),
      chain: new ChainResolver(config),
      usage: new UsageStore(tmpDataDir),
    },
    rebuild: () => {},
  });
}

const apiKey = 'test-key-123';

function makeConfig(): AppConfig {
  return {
    providers: [
      { name: 'flaky', type: 'openai-compat', baseUrl: `${upstreamUrl}/flaky/v1`, apiKey: 'k' },
      { name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k' },
    ],
    routes: { 'my-model': ['flaky/m1', 'good/m1'] },
  };
}

describe('e2e through the Hono app', () => {
  it('rejects unauthenticated requests', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'good/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(401);
  });

  it('non-streaming chat with failover from 429 provider to good provider', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'my-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('hello from mock');
    expect(json.usage.prompt_tokens).toBe(5);
    // the request hit flaky first (which 429'd), then good
    expect(requestLog.filter((r) => r.path.includes('/flaky/')).length).toBeGreaterThanOrEqual(1);
  });

  it('streaming chat end to end', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'good/m1', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('stream-');
    expect(text).toContain('[DONE]');
    const final = text
      .split('\n\n')
      .map((s) => s.replace(/^data: /, '').trim())
      .filter((s) => s && s !== '[DONE]')
      .map((s) => JSON.parse(s));
    const usageChunk = final.find((c) => c.usage);
    expect(usageChunk.usage.total_tokens).toBe(5);
  });

  it('anthropic-style client against openai-compat provider', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'my-model',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.type).toBe('message');
    expect(json.content[0].text).toBe('hello from mock');
    expect(json.stop_reason).toBe('end_turn');
    // provider must have received an OpenAI-format request
    const hit = requestLog.at(-1)!;
    expect(hit.path).toContain('/chat/completions');
    expect(hit.body.messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('usage summary records requests', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'good/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = await app.request('/v1/usage/summary', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const summary = await res.json();
    expect(summary.totals.requests).toBeGreaterThanOrEqual(1);
    expect(summary.totals.input_tokens).toBeGreaterThanOrEqual(5);
  });

  it('returns a structured error when the whole chain fails', async () => {
    const app = makeApp(
      {
        providers: [{ name: 'flaky', type: 'openai-compat', baseUrl: `${upstreamUrl}/flaky`, apiKey: 'k' }],
        routes: { 'only-flaky': ['flaky/m1'] },
      },
      apiKey,
      true,
    );
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'only-flaky', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.message).toContain('429');
  });

  it('unprefixed unknown model falls back to any-model providers and succeeds', async () => {
    const app = makeApp(makeConfig(), apiKey, false);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('hello from mock');
  });

  it('truly unknown model with strict allowlists errors clearly', async () => {
    const strictConfig = makeConfig();
    strictConfig.providers = strictConfig.providers.map((p) => ({ ...p, models: ['m1'] }));
    const app = makeApp(strictConfig, apiKey, false);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('no provider can serve');
  });
});
