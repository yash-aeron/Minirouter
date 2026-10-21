import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { createApp, runServer } from '../src/server.js';
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
let requestLog: Array<{ path: string; headers: http.IncomingHttpHeaders; body: any }> = [];

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let body: any = {};
      try {
        body = JSON.parse(data || '{}');
      } catch {
        body = {};
      }
      const url = req.url ?? '';
      requestLog.push({ path: url, headers: req.headers, body });

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };

      const sse = (chunks: string[], opts: { gapMs?: number; dieAfter?: number } = {}) => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        let i = 0;
        const tick = () => {
          if (opts.dieAfter !== undefined && i >= opts.dieAfter) {
            res.destroy();
            return;
          }
          if (i >= chunks.length) {
            res.end();
            return;
          }
          res.write(chunks[i++]!);
          if (opts.gapMs) setTimeout(tick, opts.gapMs);
          else tick();
        };
        tick();
      };

      if (url.includes('/flaky')) {
        json(429, { error: 'rate limited' }, { 'retry-after': '7' });
        return;
      }
      if (url.includes('/bad')) {
        json(400, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' },
        });
        return;
      }
      if (url.includes('/model404')) {
        json(404, {
          type: 'error',
          error: { type: 'not_found_error', message: 'model: nope does not exist' },
        });
        return;
      }
      if (url.includes('/path404')) {
        json(404, { error: 'no such endpoint' });
        return;
      }
      if (url.includes('/err500')) {
        json(500, { error: 'boom' });
        return;
      }

      /* ---- truncation / slow / empty streams ---- */
      if (url.includes('/die')) {
        if (url.includes('/v1/messages')) {
          sse(
            [
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: { id: 'msg_die', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 4 } },
              })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
              })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'partial answer' },
              })}\n\n`,
            ],
            { gapMs: 5, dieAfter: 3 },
          );
        } else {
          sse(
            [
              `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'partial-' } }] })}\n\n`,
              `data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' } }] })}\n\n`,
            ],
            { gapMs: 5, dieAfter: 2 },
          );
        }
        return;
      }
      if (url.includes('/slow')) {
        sse(
          [
            `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'slow-' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
            'data: [DONE]\n\n',
          ],
          { gapMs: 70 },
        );
        return;
      }
      if (url.includes('/empty')) {
        sse([]);
        return;
      }

      /* ---- Anthropic wire format ---- */
      if (url.includes('/v1/messages')) {
        if (body.stream === true) {
          sse([
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: { id: 'msg_s', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 7, output_tokens: 0 } },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'anthropic-stream' },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 4 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          ]);
          return;
        }
        json(200, {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model ?? 'claude-test',
          content: [{ type: 'text', text: 'hello from anthropic' }],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            cache_read_input_tokens: 11,
            cache_creation_input_tokens: 2,
          },
        });
        return;
      }

      /* ---- Gemini wire format ---- */
      if (url.includes('/gemini/')) {
        if (url.includes(':streamGenerateContent')) {
          sse([
            `data: ${JSON.stringify({
              candidates: [{ content: { parts: [{ text: 'gemini-stream' }], role: 'model' }, finishReason: 'STOP' }],
              usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
            })}\n\n`,
          ]);
          return;
        }
        json(200, {
          candidates: [{ content: { parts: [{ text: 'hello from gemini' }], role: 'model' }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
        });
        return;
      }

      /* ---- OpenAI-compatible wire format ---- */
      if (url.includes('/chat/completions')) {
        if (body.stream === true) {
          sse([
            `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'stream-' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 3 },
            })}\n\n`,
            'data: [DONE]\n\n',
          ]);
          return;
        }
        json(200, {
          choices: [{ message: { role: 'assistant', content: 'hello from mock' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        });
        return;
      }

      json(404, { error: 'unexpected path' });
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

function makeConfig(): AppConfig {
  return {
    providers: [
      { name: 'flaky', type: 'openai-compat', baseUrl: `${upstreamUrl}/flaky/v1`, apiKey: 'k' },
      { name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k' },
    ],
    routes: { 'my-model': ['flaky/m1', 'good/m1'] },
  };
}

function openaiConfig(providers: AppConfig['providers'], routes?: AppConfig['routes']): AppConfig {
  return { providers, routes };
}

function authHeaders(): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
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

  it('accepts x-api-key credentials and rejects a wrong key', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const body = JSON.stringify({ model: 'good/m1', messages: [{ role: 'user', content: 'hi' }] });
    const ok = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body,
    });
    expect(ok.status).toBe(200);
    const bad = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'nope' },
      body,
    });
    expect(bad.status).toBe(401);
  });

  it('non-streaming chat with failover from 429 provider to good provider', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
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
      headers: authHeaders(),
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
      headers: authHeaders(),
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
      headers: authHeaders(),
      body: JSON.stringify({ model: 'good/m1', messages: [{ role: 'user', content: 'hi' }] }),
    });
    const res = await app.request('/v1/usage/summary', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const summary = await res.json();
    expect(summary.totals.requests).toBeGreaterThanOrEqual(1);
    expect(summary.totals.input_tokens).toBeGreaterThanOrEqual(5);
  });

  it('returns 429 and relays retry-after when the whole chain is rate limited', async () => {
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
      headers: authHeaders(),
      body: JSON.stringify({ model: 'only-flaky', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
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

  it('forwards anthropic-beta/version and preserves cache_control, system blocks, and mid-conversation system', async () => {
    const config = openaiConfig(
      [{ name: 'claude', type: 'anthropic', baseUrl: `${upstreamUrl}/anthropic`, apiKey: 'provider-key' }],
      { alias: ['claude/claude-test'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-beta': 'test-beta-1',
        'anthropic-version': '2024-06-01',
      },
      body: JSON.stringify({
        model: 'alias',
        max_tokens: 100,
        system: [{ type: 'text', text: 'sys one', cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
          { role: 'system', content: [{ type: 'text', text: 'mid system' }] },
          { role: 'user', content: [{ type: 'text', text: 'again' }] },
        ],
        tools: [{ name: 'f', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }],
      }),
    });
    expect(res.status).toBe(200);

    const hit = requestLog.at(-1)!;
    expect(hit.path).toBe('/anthropic/v1/messages');
    expect(hit.headers['anthropic-beta']).toBe('test-beta-1');
    expect(hit.headers['anthropic-version']).toBe('2024-06-01');
    // the provider's own credential wins, not the client's local gateway key
    expect(hit.headers['x-api-key']).toBe('provider-key');
    expect(hit.body.system).toEqual([
      { type: 'text', text: 'sys one', cache_control: { type: 'ephemeral' } },
    ]);
    expect(hit.body.messages[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(hit.body.messages[2]).toMatchObject({ role: 'system' });
    expect(hit.body.tools[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('passes an upstream 400 error body through untouched', async () => {
    const config = openaiConfig(
      [{ name: 'bad', type: 'anthropic', baseUrl: `${upstreamUrl}/bad`, apiKey: 'k' }],
      { alias: ['bad/claude-test'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' },
    });
  });

  it('fails over on a 404 that means "model not found"', async () => {
    const config = openaiConfig(
      [
        { name: 'nomodel', type: 'openai-compat', baseUrl: `${upstreamUrl}/model404/v1`, apiKey: 'k' },
        { name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k' },
      ],
      { alias: ['nomodel/m1', 'good/m1'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe('hello from mock');
  });

  it('surfaces a 404 that is not a model problem instead of failing over', async () => {
    const config = openaiConfig(
      [
        { name: 'badpath', type: 'openai-compat', baseUrl: `${upstreamUrl}/path404/v1`, apiKey: 'k' },
        { name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k' },
      ],
      { alias: ['badpath/m1', 'good/m1'] },
    );
    const app = makeApp(config, apiKey, true);
    const before = requestLog.filter((r) => r.path.startsWith('/v1/chat/completions')).length;
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toContain('upstream 404');
    // non-retryable: the good provider was never attempted
    const after = requestLog.filter((r) => r.path.startsWith('/v1/chat/completions')).length;
    expect(after).toBe(before);
  });

  it('reports a truncated anthropic stream as an error event, not a clean stop', async () => {
    const config = openaiConfig(
      [{ name: 'die', type: 'anthropic', baseUrl: `${upstreamUrl}/die`, apiKey: 'k' }],
      { alias: ['die/claude-test'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        model: 'alias',
        max_tokens: 10,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).not.toContain('message_stop');
    expect(text).toContain('partial answer');

    const summary = await (
      await app.request('/v1/usage/summary', { headers: { authorization: `Bearer ${apiKey}` } })
    ).json();
    const failed = (summary.recent as Array<Record<string, unknown>>).find(
      (r) => r.route === 'messages' && r.ok === 0,
    );
    expect(failed).toBeTruthy();
  });

  it('reports a truncated openai stream as an error chunk plus [DONE]', async () => {
    const config = openaiConfig(
      [{ name: 'die', type: 'openai-compat', baseUrl: `${upstreamUrl}/die/v1`, apiKey: 'k' }],
      { alias: ['die/m1'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('partial-');
    expect(text).toContain('"error"');
    expect(text.trimEnd().endsWith('[DONE]')).toBe(true);
  });

  it('sends heartbeat pings while an upstream stream is idle', async () => {
    const previous = process.env.MINIROUTE_HEARTBEAT_MS;
    process.env.MINIROUTE_HEARTBEAT_MS = '10';
    try {
      const config = openaiConfig(
        [{ name: 'slow', type: 'openai-compat', baseUrl: `${upstreamUrl}/slow/v1`, apiKey: 'k' }],
        { alias: ['slow/m1'] },
      );
      const app = makeApp(config, apiKey, true);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model: 'alias', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      const text = await res.text();
      expect(text).toContain(': keep-alive');
      expect(text).toContain('slow-');
      expect(text).toContain('[DONE]');
    } finally {
      if (previous === undefined) delete process.env.MINIROUTE_HEARTBEAT_MS;
      else process.env.MINIROUTE_HEARTBEAT_MS = previous;
    }
  });

  it('lists route aliases and provider-qualified models', async () => {
    const config = openaiConfig(
      [{ name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k', models: ['m1', 'm2'] }],
      { alias: ['good/m1'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/models', { headers: { authorization: `Bearer ${apiKey}` } });
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.data.map((m: any) => m.id);
    expect(ids).toContain('alias');
    expect(ids).toContain('good/m1');
    expect(ids).toContain('good/m2');
  });

  it('serves non-streaming Responses API requests', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'good/m1', input: 'hi' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('response');
    expect(json.status).toBe('completed');
    expect(json.output[0].content[0].text).toBe('hello from mock');
  });

  it('serves streaming Responses API requests', async () => {
    const app = makeApp(makeConfig(), apiKey, true);
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'good/m1', input: 'hi', stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('response.created');
    expect(text).toContain('response.output_text.delta');
    expect(text).toContain('response.completed');
  });

  it('routes to a native Gemini provider, streaming and not', async () => {
    const config = openaiConfig(
      [{ name: 'gem', type: 'gemini', baseUrl: `${upstreamUrl}/gemini/v1beta`, apiKey: 'g', models: ['m1'] }],
      { alias: ['gem/m1'] },
    );
    const app = makeApp(config, apiKey, true);

    const plain = await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(plain.status).toBe(200);
    expect((await plain.json()).content[0].text).toBe('hello from gemini');

    const streamed = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text).toContain('gemini-stream');
    expect(text).toContain('[DONE]');
  });

  it('records cache-read tokens reported by an Anthropic upstream', async () => {
    const config = openaiConfig(
      [{ name: 'claude', type: 'anthropic', baseUrl: `${upstreamUrl}/anthropic`, apiKey: 'k' }],
      { alias: ['claude/claude-test'] },
    );
    const app = makeApp(config, apiKey, true);
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: 'alias', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);

    const summary = await (
      await app.request('/v1/usage/summary', { headers: { authorization: `Bearer ${apiKey}` } })
    ).json();
    const record = (summary.recent as Array<Record<string, unknown>>).find(
      (r) => r.route === 'messages' && r.provider === 'claude',
    );
    expect(record).toBeTruthy();
    expect(record!.cache_read_tokens).toBe(11);
    expect(record!.cache_write_tokens).toBe(2);
  });

  it('opens the breaker after repeated failures and skips the dead provider', async () => {
    const config = openaiConfig(
      [
        { name: 'dead', type: 'openai-compat', baseUrl: `${upstreamUrl}/err500/v1`, apiKey: 'k' },
        { name: 'good', type: 'openai-compat', baseUrl: `${upstreamUrl}/v1`, apiKey: 'k' },
      ],
      { alias: ['dead/m1', 'good/m1'] },
    );
    const app = makeApp(config, apiKey, true);
    const call = () =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ model: 'alias', messages: [{ role: 'user', content: 'hi' }] }),
      });

    const deadHitsBefore = requestLog.filter((r) => r.path.startsWith('/err500/')).length;
    for (let i = 0; i < 4; i += 1) {
      const res = await call();
      expect(res.status).toBe(200);
    }
    // Three failures trip the breaker; the fourth request never reaches it.
    expect(requestLog.filter((r) => r.path.startsWith('/err500/')).length).toBe(deadHitsBefore + 3);
  });

  it('hot-reloads the config and swaps the provider', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-reload-'));
    const configPath = path.join(dir, 'config.json');
    const dataDir = path.join(dir, 'data');
    const writeConfig = (prefix: string) =>
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          providers: [
            {
              name: 'p',
              type: 'openai-compat',
              baseUrl: `${upstreamUrl}/${prefix}/v1`,
              apiKey: 'k',
            },
          ],
          routes: { swap: ['p/m1'] },
        }),
      );
    writeConfig('a');

    const port = await freePort();
    const server = await runServer({
      configPath,
      dataDir,
      portOverride: port,
      hostOverride: '127.0.0.1',
      apiKey,
    });
    try {
      const call = () =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ model: 'swap', messages: [{ role: 'user', content: 'hi' }] }),
        });
      expect((await call()).status).toBe(200);
      expect(requestLog.some((r) => r.path.startsWith('/a/v1/chat/completions'))).toBe(true);

      writeConfig('b');
      let swapped = false;
      const deadline = Date.now() + 5000;
      while (!swapped && Date.now() < deadline) {
        const res = await call();
        expect(res.status).toBe(200);
        swapped = requestLog.some((r) => r.path.startsWith('/b/v1/chat/completions'));
        if (!swapped) await sleep(150);
      }
      expect(swapped).toBe(true);
    } finally {
      server.close();
    }
  });
});
