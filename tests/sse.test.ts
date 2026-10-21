import { describe, expect, it } from 'vitest';
import { heartbeat, parseSSE, sseFormat } from '../src/core/sse.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('parseSSE / sseFormat', () => {
  it('parses CRLF and LF frames, keeping event names', async () => {
    async function* body() {
      const enc = new TextEncoder();
      yield enc.encode('event: delta\r\ndata: one\r\n\r\ndata: two\n\n');
    }
    const events: Array<{ event?: string; data: string }> = [];
    for await (const ev of parseSSE(body())) events.push(ev);
    expect(events).toEqual([
      { event: 'delta', data: 'one' },
      { event: undefined, data: 'two' },
    ]);
  });

  it('serializes an event with a name', () => {
    expect(sseFormat('{"a":1}', 'ping')).toBe('event: ping\ndata: {"a":1}\n\n');
    expect(sseFormat('hello')).toBe('data: hello\n\n');
  });
});

describe('heartbeat', () => {
  it('emits pings while the source is idle and preserves chunk order', async () => {
    async function* source() {
      yield 'a';
      await sleep(40);
      yield 'b';
      await sleep(40);
      yield 'c';
    }
    const out: string[] = [];
    for await (const chunk of heartbeat(source(), 'PING', 10)) out.push(chunk);
    expect(out.filter((c) => c !== 'PING')).toEqual(['a', 'b', 'c']);
    expect(out.filter((c) => c === 'PING').length).toBeGreaterThanOrEqual(2);
  });

  it('does not lose a chunk that arrives right after a ping', async () => {
    async function* source() {
      await sleep(25);
      yield 'late';
    }
    const out: string[] = [];
    for await (const chunk of heartbeat(source(), 'PING', 10)) out.push(chunk);
    expect(out.filter((c) => c !== 'PING')).toEqual(['late']);
  });

  it('closes the source when the consumer stops early', async () => {
    let closed = false;
    async function* source() {
      try {
        yield 'a';
        await sleep(50);
        yield 'b';
      } finally {
        closed = true;
      }
    }
    for await (const chunk of heartbeat(source(), 'PING', 100)) {
      if (chunk === 'a') break;
    }
    expect(closed).toBe(true);
  });
});
