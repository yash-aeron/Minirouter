import { describe, expect, it } from 'vitest';
import {
  openaiChatRequestToIR,
  irToOpenAIChatRequest,
  openaiChatResponseToIR,
  irToOpenAIChatResponse,
  irEventsToOpenAISSE,
  openaiSSEToIREvents,
} from '../src/core/translate-openai.js';
import {
  anthropicRequestToIR,
  irToAnthropicRequest,
  anthropicResponseToIR,
  irToAnthropicResponse,
  anthropicSSEToIREvents,
  irEventsToAnthropicSSE,
} from '../src/core/translate-anthropic.js';
import { responsesRequestToIR, irToResponsesResponse, irEventsToResponsesSSE } from '../src/core/translate-responses.js';
import { IRRequest, IRStreamEvent } from '../src/core/ir.js';
import { sseFormat } from '../src/core/sse.js';

const baseIR: IRRequest = {
  model: 'test',
  system: 'you are helpful',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' }],
    },
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '{"temp":20}' }] },
    { role: 'user', content: [{ type: 'text', text: 'thanks' }] },
  ],
  tools: [{ name: 'get_weather', description: 'Get weather', parameters: { type: 'object' } }],
  stream: false,
};

describe('OpenAI chat translator', () => {
  it('parses client request with system, tool calls, tool results', () => {
    const body = {
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
        },
        { role: 'tool', tool_call_id: 'call_9', content: '{"result":42}' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
      stream: true,
    };
    const ir = openaiChatRequestToIR(body as any);
    expect(ir.system).toBe('be terse');
    expect(ir.stream).toBe(true);
    expect(ir.messages[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
    expect(ir.messages[1]!.content).toEqual([
      { type: 'tool_call', id: 'call_9', name: 'f', arguments: '{"a":1}' },
    ]);
    expect(ir.messages[2]!.role).toBe('tool');
    expect(ir.messages[2]!.toolCallId).toBe('call_9');
    expect(ir.tools).toEqual([{ name: 'f', description: 'd', parameters: {} }]);
  });

  it('serializes IR to provider request preserving tools and results', () => {
    const wire = irToOpenAIChatRequest(baseIR, 'm1');
    expect(wire.model).toBe('m1');
    expect(wire.messages[0]).toEqual({ role: 'system', content: 'you are helpful' });
    const toolCallMsg = wire.messages[2] as any;
    expect(toolCallMsg.tool_calls).toHaveLength(1);
    expect(toolCallMsg.tool_calls[0].function.name).toBe('get_weather');
    const toolResultMsg = wire.messages[3] as any;
    expect(toolResultMsg).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(wire.tools![0].function.name).toBe('get_weather');
  });

  it('round-trips a provider response with tool calls', () => {
    const upstream = {
      choices: [
        {
          message: { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'x1', function: { name: 'f', arguments: '{"k":"v"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
    const irResp = openaiChatResponseToIR(upstream, 'm1');
    expect(irResp.finish).toBe('tool_calls');
    expect(irResp.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const client = irToOpenAIChatResponse(irResp, 'm1') as any;
    expect(client.choices[0].finish_reason).toBe('tool_calls');
    expect(client.choices[0].message.tool_calls[0].function.name).toBe('f');
    expect(client.usage.total_tokens).toBe(15);
  });

  it('maps streaming chunks to IR events and back', async () => {
    async function* chunks() {
      const enc = new TextEncoder();
      yield enc.encode(sseFormat(JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'He' } }] })));
      yield enc.encode(sseFormat(JSON.stringify({ choices: [{ delta: { content: 'llo' } }] })));
      yield enc.encode(sseFormat(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'f', arguments: '' } }] } }] })));
      yield enc.encode(sseFormat(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] })));
      yield enc.encode(sseFormat(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 4 } })));
      yield enc.encode(sseFormat('[DONE]'));
    }
    const events: IRStreamEvent[] = [];
    for await (const ev of openaiSSEToIREvents(chunks(), 'm')) events.push(ev);
    expect(events.filter((e) => e.type === 'text_delta')).toHaveLength(2);
    expect(events.some((e) => e.type === 'tool_call_start' && e.name === 'f')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool_calls' });

    const sseOut: string[] = [];
    for await (const s of irEventsToOpenAISSE(events[Symbol.iterator]() as any, 'm', true)) sseOut.push(s);
    const parsed = sseOut
      .filter((s) => s.trim() !== 'data: [DONE]')
      .map((s) => JSON.parse(s.replace(/^data: /, '').trim()));
    expect(parsed[0].choices[0].delta.role).toBe('assistant');
    expect(parsed.at(-1)!.usage).toEqual({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 });
    const finishChunk = parsed.find((p) => p.choices[0]?.finish_reason);
    expect(finishChunk.choices[0].finish_reason).toBe('tool_calls');
  });
});

describe('Anthropic translator', () => {
  it('parses client request with tool_result blocks', () => {
    const body = {
      model: 'claude-x',
      max_tokens: 100,
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'f', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
      ],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
    };
    const ir = anthropicRequestToIR(body);
    expect(ir.system).toBe('sys');
    expect(ir.messages).toHaveLength(3);
    expect(ir.messages[1]!.content[0]).toMatchObject({ type: 'tool_call', id: 'tu1', name: 'f' });
    expect(ir.messages[2]!.role).toBe('tool');
  });

  it('serializes IR to provider request with tool_result blocks', () => {
    const wire = irToAnthropicRequest(baseIR, 'claude-x') as any;
    expect(wire.system).toBe('you are helpful');
    // messages: [user hi, assistant tool_use, user tool_result, user thanks]
    expect(wire.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
    expect(wire.messages[3].content[0]).toEqual({ type: 'text', text: 'thanks' });
    expect(wire.tools[0]).toMatchObject({ name: 'get_weather', input_schema: { type: 'object' } });
  });

  it('round-trips a response with tool_use', () => {
    const upstream = {
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'tu2', name: 'f', input: { x: 2 } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 7, output_tokens: 3 },
    };
    const irResp = anthropicResponseToIR(upstream, 'claude-x');
    expect(irResp.finish).toBe('tool_calls');
    const client = irToAnthropicResponse(irResp) as any;
    expect(client.stop_reason).toBe('tool_use');
    expect(client.content[1]).toMatchObject({ type: 'tool_use', name: 'f', input: { x: 2 } });
  });

  it('translates anthropic SSE to IR events and back to anthropic SSE', async () => {
    async function* chunks() {
      const enc = new TextEncoder();
      const ev = (t: string, d: any) => enc.encode(sseFormat(JSON.stringify(d), t));
      yield ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5 } } });
      yield ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      yield ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'abc' } });
      yield ev('content_block_stop', { type: 'content_block_stop', index: 0 });
      yield ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
      yield ev('message_stop', { type: 'message_stop' });
    }
    const events: IRStreamEvent[] = [];
    for await (const ev of anthropicSSEToIREvents(chunks())) events.push(ev);
    expect(events[0]).toEqual({ type: 'usage', usage: { inputTokens: 5 } });
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'abc')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });

    const out: string[] = [];
    for await (const s of irEventsToAnthropicSSE(events[Symbol.iterator]() as any, 'claude-x')) out.push(s);
    const joined = out.join('');
    expect(joined).toContain('message_start');
    expect(joined).toContain('text_delta');
    expect(joined).toContain('"stop_reason":"end_turn"');
    expect(joined).toContain('message_stop');
  });
});

describe('Responses translator', () => {
  it('parses instructions, items, function calls', () => {
    const body = {
      model: 'gpt-5',
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: 'c1', name: 'f', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'done' },
      ],
      tools: [{ type: 'function', name: 'f', parameters: {} }],
    };
    const ir = responsesRequestToIR(body);
    expect(ir.system).toBe('be brief');
    expect(ir.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(ir.messages[2]!.toolCallId).toBe('c1');
  });

  it('serializes a non-streaming response', () => {
    const irResp = {
      model: 'gpt-5',
      content: [
        { type: 'tool_call', id: 'c9', name: 'f', arguments: '{"q":1}' },
      ],
      finish: 'tool_calls' as const,
      usage: { inputTokens: 4, outputTokens: 2 },
    };
    const out = irToResponsesResponse(irResp as any) as any;
    expect(out.object).toBe('response');
    expect(out.output[0]).toMatchObject({ type: 'function_call', call_id: 'c9', name: 'f' });
    expect(out.usage.total_tokens).toBe(6);
  });

  it('streams IR events as Responses SSE', async () => {
    const events: IRStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } },
      { type: 'finish', reason: 'stop' },
    ];
    const out: string[] = [];
    for await (const s of irEventsToResponsesSSE(events[Symbol.iterator]() as any, 'gpt-5')) out.push(s);
    const types = out.map((s) => JSON.parse(s.trim().replace(/^event: [\w.]+\ndata: /, '').trim()).type);
    expect(types).toContain('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types.at(-1)).toBe('response.completed');
    const completed = JSON.parse(out.at(-1)!.trim().replace(/^event: [\w.]+\ndata: /, '').trim());
    expect(completed.response.output[0].content[0].text).toBe('hello');
  });
});
