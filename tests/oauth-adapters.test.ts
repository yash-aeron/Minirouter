import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { configSchema } from '../src/config.js';
import { IRRequest } from '../src/core/ir.js';
import { OAuthPool } from '../src/oauth/pool.js';
import { TokenStore } from '../src/oauth/token-store.js';
import { OAuthAccount, OAuthProvider, RefreshedTokens } from '../src/oauth/types.js';
import { ClaudeOAuthAdapter, mergeBetas } from '../src/providers/claude-oauth.js';
import { CodexAdapter } from '../src/providers/codex.js';
import { GeminiCliAdapter } from '../src/providers/gemini-cli.js';
import { buildRegistry } from '../src/providers/registry.js';
import { ProviderSendResult } from '../src/providers/types.js';

interface SeenRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

const requests: SeenRequest[] = [];
let upstream: http.Server;
let baseUrl = '';
let claudeUnauthorizedOnce = false;
let codexMode: 'json' | 'sse' = 'json';

const tempDirs: string[] = [];

function newStore(provider: OAuthProvider = 'claude', accounts: Partial<OAuthAccount>[] = [{}]): TokenStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-oauth-adapter-'));
  tempDirs.push(dir);
  const store = new TokenStore(path.join(dir, 'oauth.json'));
  accounts.forEach((overrides, index) => {
    const account: OAuthAccount = {
      id: `acct-${index}`,
      label: `acct-${index}`,
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      expiresAt: Date.now() + 3600_000,
      accountId: 'chatgpt-account',
      projectId: 'project-1',
      ...overrides,
    };
    store.upsert(provider, account);
  });
  return store;
}

function seedCodex(store: TokenStore, overrides: Partial<OAuthAccount> = {}): void {
  store.upsert('codex', {
    id: 'acct-0',
    label: 'acct-0',
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3600_000,
    accountId: 'chatgpt-account',
    ...overrides,
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

function json(res: http.ServerResponse, payload: unknown, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sse(res: http.ServerResponse, events: Array<{ event?: string; data: unknown }>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) {
    if (e.event) res.write(`event: ${e.event}\n`);
    res.write(`data: ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

beforeAll(async () => {
  upstream = http.createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: any = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ url: req.url ?? '', headers: req.headers, body });

    if (req.url === '/anthropic/v1/messages') {
      if (claudeUnauthorizedOnce) {
        claudeUnauthorizedOnce = false;
        json(res, { type: 'error', error: { type: 'authentication_error', message: 'expired' } }, 401);
        return;
      }
      json(res, {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'claude-ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      return;
    }

    if (req.url === '/codex/responses') {
      if (codexMode === 'sse') {
        sse(res, [
          {
            event: 'response.output_item.added',
            data: {
              type: 'response.output_item.added',
              item: { id: 'fc_item', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '' },
            },
          },
          {
            event: 'response.function_call_arguments.delta',
            data: {
              type: 'response.function_call_arguments.delta',
              item_id: 'fc_item',
              delta: '{"path":"a"}',
            },
          },
          {
            event: 'response.function_call_arguments.done',
            data: {
              type: 'response.function_call_arguments.done',
              item_id: 'fc_item',
              arguments: '{"path":"a"}',
            },
          },
          {
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', delta: 'codex-text' },
          },
          {
            event: 'response.completed',
            data: {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [],
                usage: { input_tokens: 4, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } },
              },
            },
          },
        ]);
        return;
      }
      json(res, {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'codex-ok' }],
          },
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_9',
            name: 'read',
            arguments: '{"path":"b"}',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
      });
      return;
    }

    if (req.url === '/v1internal:generateContent') {
      json(res, {
        response: {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'gemini-ok' }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
        },
      });
      return;
    }

    if (req.url?.startsWith('/v1internal:streamGenerateContent')) {
      sse(res, [
        {
          data: {
            response: {
              candidates: [{ content: { role: 'model', parts: [{ text: 'gemini-' }] } }],
            },
          },
        },
        {
          data: {
            response: {
              candidates: [
                { content: { role: 'model', parts: [{ text: 'stream' }] }, finishReason: 'STOP' },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          },
        },
      ]);
      return;
    }

    json(res, { error: { message: `unexpected ${req.url}` } }, 404);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

afterEach(() => {
  requests.length = 0;
  claudeUnauthorizedOnce = false;
  codexMode = 'json';
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function claudeRequest(overrides: Partial<IRRequest> = {}): IRRequest {
  return {
    model: 'claude-test',
    system: 'be brief',
    systemBlocks: [{ type: 'text', text: 'be brief', cacheControl: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    stream: false,
    clientHeaders: {
      'anthropic-beta': 'claude-code-20250219',
      'anthropic-version': '2023-06-01',
    },
    ...overrides,
  };
}

describe('Claude OAuth adapter', () => {
  it('sends Bearer + OAuth beta, no API key, and preserves cache markers', async () => {
    const store = newStore();
    const pool = new OAuthPool('claude', store, ['acct-0'], {
      refresh: async () => ({ accessToken: 'unused', expiresAt: Date.now() + 3600_000 }),
      label: 'claude',
    });
    const adapter = new ClaudeOAuthAdapter(
      { name: 'claude', baseUrl: `${baseUrl}/anthropic`, apiKey: '', models: null },
      pool,
    );

    const { response } = await adapter.send(claudeRequest(), 'claude-test');
    expect(response?.content).toEqual([{ type: 'text', text: 'claude-ok' }]);

    const seen = requests.find((r) => r.url === '/anthropic/v1/messages')!;
    expect(seen.headers.authorization).toBe('Bearer access-token-value');
    expect(seen.headers['x-api-key']).toBeUndefined();
    expect(seen.headers['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20');
    expect(seen.headers['anthropic-version']).toBe('2023-06-01');
    expect(Array.isArray(seen.body.system)).toBe(true);
    expect(seen.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('refreshes once and retries after a 401', async () => {
    claudeUnauthorizedOnce = true;
    const store = newStore();
    let refreshCalls = 0;
    const pool = new OAuthPool('claude', store, ['acct-0'], {
      refresh: async (): Promise<RefreshedTokens> => {
        refreshCalls += 1;
        return { accessToken: 'refreshed-token', expiresAt: Date.now() + 3600_000 };
      },
      label: 'claude',
    });
    const adapter = new ClaudeOAuthAdapter(
      { name: 'claude', baseUrl: `${baseUrl}/anthropic`, apiKey: '', models: null },
      pool,
    );

    const { response } = await adapter.send(claudeRequest(), 'claude-test');
    expect(response?.content).toEqual([{ type: 'text', text: 'claude-ok' }]);
    expect(refreshCalls).toBe(1);
    const auths = requests
      .filter((r) => r.url === '/anthropic/v1/messages')
      .map((r) => r.headers.authorization);
    expect(auths).toEqual(['Bearer access-token-value', 'Bearer refreshed-token']);
  });

  it('merges beta flags without duplicates', () => {
    expect(mergeBetas(undefined, 'oauth-2025-04-20')).toBe('oauth-2025-04-20');
    expect(mergeBetas('a, b', 'oauth-2025-04-20')).toBe('a,b,oauth-2025-04-20');
    expect(mergeBetas('a,oauth-2025-04-20', 'oauth-2025-04-20')).toBe('a,oauth-2025-04-20');
  });
});

describe('Codex adapter', () => {
  function codexPool() {
    const store = newStore('codex');
    return new OAuthPool('codex', store, ['acct-0'], {
      refresh: async () => ({ accessToken: 'unused', expiresAt: Date.now() + 3600_000 }),
      label: 'codex',
    });
  }

  it('sends the Responses request shape to the Codex backend', async () => {
    const adapter = new CodexAdapter(
      { name: 'codex', baseUrl: `${baseUrl}/codex`, apiKey: '', models: null },
      codexPool(),
    );
    const ir: IRRequest = {
      model: 'gpt-5-codex',
      system: 'be brief',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
      toolChoice: { type: 'auto' },
      stream: false,
    };

    const { response } = await adapter.send(ir, 'gpt-5-codex');
    expect(response?.content).toEqual([
      { type: 'text', text: 'codex-ok' },
      { type: 'tool_call', id: 'call_9', name: 'read', arguments: '{"path":"b"}' },
    ]);
    expect(response?.finish).toBe('tool_calls');
    expect(response?.usage).toEqual({ inputTokens: 5, outputTokens: 2, cacheReadTokens: 1 });

    const seen = requests.find((r) => r.url === '/codex/responses')!;
    expect(seen.headers.authorization).toBe('Bearer access-token-value');
    expect(seen.headers['chatgpt-account-id']).toBe('chatgpt-account');
    expect(seen.body).toMatchObject({
      model: 'gpt-5-codex',
      instructions: 'be brief',
      stream: false,
      store: false,
    });
    expect(seen.body.input[0]).toMatchObject({ type: 'message', role: 'user' });
    expect(seen.body.tools[0]).toMatchObject({ type: 'function', name: 'read' });
  });

  it('maps Responses SSE events to IR, remapping item ids to call ids', async () => {
    codexMode = 'sse';
    const adapter = new CodexAdapter(
      { name: 'codex', baseUrl: `${baseUrl}/codex`, apiKey: '', models: null },
      codexPool(),
    );
    const result: ProviderSendResult = await adapter.send(
      {
        model: 'gpt-5-codex',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        stream: true,
      },
      'gpt-5-codex',
    );
    const events = [];
    for await (const event of result.events!) events.push(event);

    expect(events).toContainEqual({ type: 'tool_call_start', id: 'call_1', name: 'read' });
    expect(events.filter((e) => e.type === 'tool_call_delta')).toEqual([
      { type: 'tool_call_delta', id: 'call_1', argumentsDelta: '{"path":"a"}' },
    ]);
    expect(events).toContainEqual({ type: 'text_delta', text: 'codex-text' });
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 2 } });
    expect(events[events.length - 1]).toEqual({ type: 'finish', reason: 'tool_calls' });
  });
});

describe('Gemini CLI adapter', () => {
  function geminiPool() {
    const store = newStore('gemini');
    return new OAuthPool('gemini', store, ['acct-0'], {
      refresh: async () => ({ accessToken: 'unused', expiresAt: Date.now() + 3600_000 }),
      label: 'gemini',
    });
  }

  it('wraps the Gemini payload in the Code Assist envelope and unwraps the response', async () => {
    const adapter = new GeminiCliAdapter(
      { name: 'gemini', baseUrl: `${baseUrl}/v1internal`, apiKey: '', models: null },
      geminiPool(),
    );
    const { response } = await adapter.send(
      {
        model: 'gemini-2.5-pro',
        system: 'be brief',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        stream: false,
      },
      'gemini-2.5-pro',
    );
    expect(response?.content).toEqual([{ type: 'text', text: 'gemini-ok' }]);

    const seen = requests.find((r) => r.url === '/v1internal:generateContent')!;
    expect(seen.headers.authorization).toBe('Bearer access-token-value');
    expect(seen.body).toMatchObject({ model: 'gemini-2.5-pro', project: 'project-1' });
    expect(seen.body.request.contents[0].parts[0].text).toBe('hi');
  });

  it('unwraps wrapped SSE chunks', async () => {
    const adapter = new GeminiCliAdapter(
      { name: 'gemini', baseUrl: `${baseUrl}/v1internal`, apiKey: '', models: null },
      geminiPool(),
    );
    const result = await adapter.send(
      {
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
        stream: true,
      },
      'gemini-2.5-pro',
    );
    const events = [];
    for await (const event of result.events!) events.push(event);
    expect(events.filter((e) => e.type === 'text_delta').map((e: any) => e.text).join('')).toBe(
      'gemini-stream',
    );
    expect(events[events.length - 1]).toMatchObject({ type: 'finish' });
  });

  it('fails clearly when the account has no project id', async () => {
    const store = newStore('gemini');
    store.update('gemini', 'acct-0', { projectId: undefined });
    const pool = new OAuthPool('gemini', store, ['acct-0'], {
      refresh: async () => ({ accessToken: 'unused', expiresAt: Date.now() + 3600_000 }),
      label: 'gemini',
    });
    const adapter = new GeminiCliAdapter(
      { name: 'gemini', baseUrl: `${baseUrl}/v1internal`, apiKey: '', models: null },
      pool,
    );
    await expect(
      adapter.send(
        {
          model: 'm',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
          tools: [],
          stream: false,
        },
        'm',
      ),
    ).rejects.toThrow(/no Code Assist project/);
  });
});

describe('OAuth config validation', () => {
  it('requires accounts for oauth providers and rejects oauth on incompatible types', () => {
    expect(() =>
      configSchema.parse({ providers: [{ name: 'c', type: 'anthropic', auth: 'oauth' }] }),
    ).toThrow(/accounts/);

    expect(() =>
      configSchema.parse({
        providers: [{ name: 'x', type: 'openai-compat', auth: 'oauth', accounts: ['a'] }],
      }),
    ).toThrow(/only supported/);

    expect(() =>
      configSchema.parse({
        providers: [{ name: 'x', type: 'anthropic', accounts: ['a'] }],
      }),
    ).toThrow(/only used with auth/);

    expect(() =>
      configSchema.parse({ providers: [{ name: 'x', type: 'codex', apiKey: 'env:OPENAI_API_KEY' }] }),
    ).toThrow(/requires auth/);

    const config = configSchema.parse({
      providers: [
        { name: 'c', type: 'anthropic', auth: 'oauth', accounts: ['work'] },
        { name: 'x', type: 'codex', auth: 'oauth', accounts: ['desk'] },
        { name: 'g', type: 'gemini-cli', auth: 'oauth', accounts: ['personal'] },
      ],
    });
    expect(config.providers).toHaveLength(3);
  });

  it('builds OAuth adapters from the registry and fails on missing accounts', () => {
    const store = newStore();
    seedCodex(store);
    const config = configSchema.parse({
      providers: [
        { name: 'claude', type: 'anthropic', auth: 'oauth', accounts: ['acct-0'] },
        { name: 'codex', type: 'codex', auth: 'oauth', accounts: ['acct-0'] },
      ],
    });
    const registry = buildRegistry(config, { tokenStore: store });
    expect(registry.get('claude')).toBeInstanceOf(ClaudeOAuthAdapter);
    expect(registry.get('codex')).toBeInstanceOf(CodexAdapter);

    expect(() =>
      buildRegistry(
        configSchema.parse({
          providers: [{ name: 'claude', type: 'anthropic', auth: 'oauth', accounts: ['missing'] }],
        }),
        { tokenStore: store },
      ),
    ).toThrow(/no claude account named "missing"/);
  });
});
