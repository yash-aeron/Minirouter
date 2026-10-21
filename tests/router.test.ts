import { describe, expect, it, vi } from 'vitest';
import { Breakers } from '../src/router/breaker.js';
import { ChainResolver } from '../src/router/chain.js';
import { executeWithFailover, NoCandidateError } from '../src/router/failover.js';
import { ProviderAdapter, ProviderError, classifyUpstreamError } from '../src/providers/types.js';
import { IRRequest, IRResponse, IRStreamEvent } from '../src/core/ir.js';
import { AppConfig } from '../src/config.js';

const ir: IRRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  stream: false,
};

function okResponse(): IRResponse {
  return {
    model: 'm',
    content: [{ type: 'text', text: 'ok' }],
    finish: 'stop',
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function makeAdapter(
  behavior: () => Promise<IRResponse> | IRResponse | never,
): ProviderAdapter {
  return {
    name: 'test',
    models: null,
    async send() {
      const r = await behavior();
      return { response: r as IRResponse };
    },
  };
}

const config: AppConfig = {
  providers: [
    { name: 'a', type: 'openai-compat' },
    { name: 'b', type: 'openai-compat' },
  ],
};

describe('ChainResolver', () => {
  const resolver = new ChainResolver({
    ...config,
    providers: [
      { name: 'glm', type: 'openai-compat' as const, models: ['glm-4.7'] },
      { name: 'ds', type: 'openai-compat' as const, models: ['glm-4.7', 'ds-chat'] },
    ],
    routes: { 'my-model': ['glm/glm-4.7', 'ds/ds-chat'] },
  });

  it('resolves route aliases to ordered candidates', () => {
    expect(resolver.resolve('my-model')).toEqual([
      { provider: 'glm', model: 'glm-4.7' },
      { provider: 'ds', model: 'ds-chat' },
    ]);
  });

  it('resolves provider-prefixed names', () => {
    expect(resolver.resolve('ds/ds-chat')).toEqual([{ provider: 'ds', model: 'ds-chat' }]);
  });

  it('resolves unprefixed names against provider allowlists', () => {
    expect(resolver.resolve('glm-4.7')).toEqual([
      { provider: 'glm', model: 'glm-4.7' },
      { provider: 'ds', model: 'glm-4.7' },
    ]);
  });

  it('throws when nothing can serve the model', () => {
    expect(() => resolver.resolve('unknown-model')).toThrow(/no provider can serve/);
  });

  it('lists prefixed models and aliases', () => {
    expect(resolver.listModels().sort()).toEqual(['ds/ds-chat', 'ds/glm-4.7', 'glm/glm-4.7', 'my-model']);
  });

  it('reports unusable route entries instead of dropping them silently', () => {
    const warned = new ChainResolver({
      providers: [{ name: 'glm', type: 'openai-compat' as const }],
      routes: { broken: ['glm/ok', 'unprefixed', 'ghost/model', 'glm/second'] },
    });
    const warnings: string[] = [];
    expect(warned.resolve('broken', warnings)).toEqual([
      { provider: 'glm', model: 'ok' },
      { provider: 'glm', model: 'second' },
    ]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/not provider-prefixed/);
    expect(warnings[1]).toMatch(/unknown provider "ghost"/);
  });

  it('throws when a configured route expands to zero candidates', () => {
    const broken = new ChainResolver({
      providers: [{ name: 'glm', type: 'openai-compat' as const }],
      routes: { empty: ['ghost/m1'] },
    });
    expect(() => broken.resolve('empty')).toThrow(/resolves to no usable candidates/);
  });
});

describe('Breakers', () => {
  it('opens after threshold failures and cools down', () => {
    const b = new Breakers();
    const err = new ProviderError('upstream 500', { status: 500, retryable: true, provider: 'x' });
    b.recordFailure('x', err);
    b.recordFailure('x', err);
    expect(b.isOpen('x')).toBe(false);
    b.recordFailure('x', err);
    expect(b.isOpen('x')).toBe(true);
    // after cooldown
    expect(b.isOpen('x', Date.now() + 31_000)).toBe(false);
  });

  it('does not trip on auth errors', () => {
    const b = new Breakers();
    const err = new ProviderError('401', { status: 401, retryable: true, provider: 'x' });
    for (let i = 0; i < 10; i++) b.recordFailure('x', err);
    expect(b.isOpen('x')).toBe(false);
  });

  it('success resets', () => {
    const b = new Breakers();
    const err = new ProviderError('500', { status: 500, retryable: true, provider: 'x' });
    b.recordFailure('x', err);
    b.recordFailure('x', err);
    b.recordSuccess('x');
    b.recordFailure('x', err);
    b.recordFailure('x', err);
    expect(b.isOpen('x')).toBe(false);
  });
});

describe('executeWithFailover', () => {
  it('moves to the next candidate on retryable error', async () => {
    const a = makeAdapter(() => {
      throw new ProviderError('upstream 429', { status: 429, retryable: true, provider: 'a' });
    });
    const b = makeAdapter(() => okResponse());
    const result = await executeWithFailover(ir, [
      { provider: 'a', model: 'm' },
      { provider: 'b', model: 'm' },
    ], new Map([['a', a], ['b', b]]), new Breakers());
    expect(result.provider).toBe('b');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.ok).toBe(false);
  });

  it('throws immediately on non-retryable error (400)', async () => {
    const a = makeAdapter(() => {
      throw new ProviderError('bad request', { status: 400, retryable: false, provider: 'a' });
    });
    const b = makeAdapter(() => okResponse());
    await expect(
      executeWithFailover(ir, [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
        new Map([['a', a], ['b', b]]), new Breakers()),
    ).rejects.toThrow(/bad request/);
  });

  it('skips open breakers', async () => {
    const breakers = new Breakers();
    breakers.recordFailure(
      'a',
      new ProviderError('500', { status: 500, retryable: true, provider: 'a' }),
    );
    breakers.recordFailure(
      'a',
      new ProviderError('500', { status: 500, retryable: true, provider: 'a' }),
    );
    breakers.recordFailure(
      'a',
      new ProviderError('500', { status: 500, retryable: true, provider: 'a' }),
    );
    const b = makeAdapter(() => okResponse());
    const neverAdapter = makeAdapter(() => {
      throw new Error('should not be called');
    });
    const result = await executeWithFailover(ir, [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
      new Map([['a', neverAdapter], ['b', b]]), breakers);
    expect(result.provider).toBe('b');
    expect(result.attempts[0]).toMatchObject({ provider: 'a', error: 'circuit breaker open' });
  });

  it('fails over on streaming requests before first event', async () => {
    async function* deadStream(): AsyncGenerator<IRStreamEvent> {
      throw new ProviderError('upstream 503', { status: 503, retryable: true, provider: 'a' });
      yield { type: 'finish', reason: 'stop' }; // unreachable
    }
    const a: ProviderAdapter = {
      name: 'a',
      models: null,
      async send() {
        return { events: deadStream() };
      },
    };
    async function* goodStream(): AsyncGenerator<IRStreamEvent> {
      yield { type: 'text_delta', text: 'hey' };
      yield { type: 'finish', reason: 'stop' };
    }
    const b: ProviderAdapter = {
      name: 'b',
      models: null,
      async send() {
        return { events: goodStream() };
      },
    };
    const result = await executeWithFailover(
      { ...ir, stream: true },
      [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
      new Map([['a', a], ['b', b]]),
      new Breakers(),
    );
    const events: IRStreamEvent[] = [];
    for await (const ev of result.events!) events.push(ev);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'hey' });
    expect(result.provider).toBe('b');
  });

  it('rethrows non-retryable provider errors with their original status and body', async () => {
    const a = makeAdapter(() => {
      throw new ProviderError('bad prompt', {
        status: 400,
        retryable: false,
        provider: 'a',
        rawBody: '{"error":{"message":"too long"}}',
      });
    });
    const b = makeAdapter(() => okResponse());
    const err = await executeWithFailover(
      ir,
      [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
      new Map([['a', a], ['b', b]]),
      new Breakers(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).status).toBe(400);
    expect((err as ProviderError).rawBody).toContain('too long');
  });

  it('fails over when the first stream event is an error and closes the dead iterator', async () => {
    const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
    const a: ProviderAdapter = {
      name: 'a',
      models: null,
      async send() {
        return {
          events: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => ({ done: false as const, value: { type: 'error' as const, message: 'boom' } }),
                return: returned,
              };
            },
          },
        };
      },
    };
    async function* goodStream(): AsyncGenerator<IRStreamEvent> {
      yield { type: 'text_delta', text: 'hey' };
      yield { type: 'finish', reason: 'stop' };
    }
    const b: ProviderAdapter = {
      name: 'b',
      models: null,
      async send() {
        return { events: goodStream() };
      },
    };
    const result = await executeWithFailover(
      { ...ir, stream: true },
      [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
      new Map([['a', a], ['b', b]]),
      new Breakers(),
    );
    expect(result.provider).toBe('b');
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('fails over when a stream ends before any event', async () => {
    async function* empty(): AsyncGenerator<IRStreamEvent> {
      // no events at all
    }
    const a: ProviderAdapter = {
      name: 'a',
      models: null,
      async send() {
        return { events: empty() };
      },
    };
    async function* goodStream(): AsyncGenerator<IRStreamEvent> {
      yield { type: 'text_delta', text: 'hey' };
      yield { type: 'finish', reason: 'stop' };
    }
    const b: ProviderAdapter = {
      name: 'b',
      models: null,
      async send() {
        return { events: goodStream() };
      },
    };
    const result = await executeWithFailover(
      { ...ir, stream: true },
      [{ provider: 'a', model: 'm' }, { provider: 'b', model: 'm' }],
      new Map([['a', a], ['b', b]]),
      new Breakers(),
    );
    expect(result.provider).toBe('b');
  });

  it('exposes the last provider error when the chain is exhausted', async () => {
    const a = makeAdapter(() => {
      throw new ProviderError('upstream 429', {
        status: 429,
        retryable: true,
        provider: 'a',
        upstreamHeaders: { 'retry-after': '3' },
      });
    });
    const err = await executeWithFailover(
      ir,
      [{ provider: 'a', model: 'm' }],
      new Map([['a', a]]),
      new Breakers(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoCandidateError);
    const noCandidate = err as NoCandidateError;
    expect(noCandidate.lastError?.status).toBe(429);
    expect(noCandidate.lastError?.upstreamHeaders?.['retry-after']).toBe('3');
    expect(noCandidate.attempts).toHaveLength(1);
  });
});

describe('classifyUpstreamError', () => {
  it('retries rate limits, auth, quota, and 5xx', () => {
    for (const status of [401, 402, 403, 408, 409, 429, 500, 503]) {
      expect(classifyUpstreamError(status, '')).toEqual({ retryable: true });
    }
  });

  it('retries a 404 only when the model is the problem', () => {
    expect(
      classifyUpstreamError(404, JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-x' } })),
    ).toEqual({ retryable: true });
    expect(
      classifyUpstreamError(404, JSON.stringify({ error: { message: "The model 'gpt-x' does not exist", code: 'model_not_found' } })),
    ).toEqual({ retryable: true });
    expect(
      classifyUpstreamError(404, JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not Found' } })),
    ).toEqual({ retryable: false });
    expect(classifyUpstreamError(404, '{"error":"no such endpoint"}')).toEqual({ retryable: false });
  });

  it('does not retry request-shape errors', () => {
    expect(classifyUpstreamError(400, '{"error":{"message":"bad"}}')).toEqual({ retryable: false });
    expect(classifyUpstreamError(422, '{"error":{"message":"bad"}}')).toEqual({ retryable: false });
  });
});
