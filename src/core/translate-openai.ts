/**
 * OpenAI Chat Completions translation: client side (parse/serialize) and
 * provider side (build/parse). One file because both sides share wire shapes.
 */
import {
  IRContentBlock,
  IRFinishReason,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRUsage,
  randomId,
  textOf,
} from './ir.js';
import { parseSSE, sseFormat } from './sse.js';

/* ---------- wire shapes (loose on purpose: providers add fields) ---------- */

export interface OpenAIChatRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  [k: string]: unknown;
}

/* ---------------------------- client -> IR ---------------------------- */

export function openaiChatRequestToIR(body: OpenAIChatRequest): IRRequest {
  const messages: IRRequest['messages'] = [];
  const systemParts: string[] = [];

  for (const m of body.messages ?? []) {
    const role = m.role as string;
    if (role === 'system' || role === 'developer') {
      systemParts.push(String(m.content ?? ''));
      continue;
    }
    if (role === 'tool') {
      messages.push({
        role: 'tool',
        toolCallId: String(m.tool_call_id ?? ''),
        content: partsToIR(m.content),
      });
      continue;
    }
    if (role === 'assistant') {
      const content: IRContentBlock[] = partsToIR(m.content);
      for (const tc of (m.tool_calls as Array<Record<string, any>> | undefined) ?? []) {
        const fn = tc.function ?? {};
        content.push({
          type: 'tool_call',
          id: String(tc.id ?? randomId('call')),
          name: String(fn.name ?? ''),
          arguments: String(fn.arguments ?? '{}'),
        });
      }
      messages.push({ role: 'assistant', content });
      continue;
    }
    // user
    messages.push({ role: 'user', content: partsToIR(m.content) });
  }

  const tools = ((body.tools as Array<Record<string, any>> | undefined) ?? []).map((t) => ({
    name: String(t.function?.name ?? ''),
    description: t.function?.description as string | undefined,
    parameters: t.function?.parameters as Record<string, unknown> | undefined,
  }));

  let toolChoice: IRRequest['toolChoice'];
  const tc = body.tool_choice;
  if (tc === 'auto' || tc === 'none' || tc === 'required') toolChoice = { type: tc };
  else if (tc && typeof tc === 'object' && (tc as any).type === 'function') {
    toolChoice = { type: 'tool', name: String((tc as any).function?.name ?? '') };
  }

  const stop = body.stop;
  return {
    model: String(body.model ?? ''),
    system: systemParts.length ? systemParts.filter((s) => s).join('\n\n') : undefined,
    messages,
    tools,
    toolChoice,
    maxTokens: (body.max_tokens as number) ?? (body.max_completion_tokens as number),
    temperature: body.temperature as number | undefined,
    topP: body.top_p as number | undefined,
    stopSequences: stop === undefined ? undefined : Array.isArray(stop) ? stop : [stop],
    stream: Boolean(body.stream),
  };
}

/** OpenAI message content (string or parts array) -> IR blocks. */
function partsToIR(content: unknown): IRContentBlock[] {
  if (content === undefined || content === null) return [];
  if (typeof content === 'string') {
    return content === '' ? [] : [{ type: 'text', text: content }];
  }
  const blocks: IRContentBlock[] = [];
  for (const p of content as Array<Record<string, any>>) {
    if (p.type === 'text') blocks.push({ type: 'text', text: String(p.text ?? '') });
    else if (p.type === 'image_url') {
      const url: string = String(p.image_url?.url ?? '');
      const dataMatch = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (dataMatch) {
        blocks.push({ type: 'image', mediaType: dataMatch[1]!, base64: dataMatch[2]! });
      } else if (url) {
        blocks.push({ type: 'image', mediaType: '', base64: '', url });
      }
    }
    // audio / file types: unsupported in v1, dropped
  }
  return blocks;
}

/* ---------------------------- IR -> provider request ---------------------------- */

export function irToOpenAIChatRequest(ir: IRRequest, model: string): OpenAIChatRequest {
  const messages: Array<Record<string, unknown>> = [];
  if (ir.system) messages.push({ role: 'system', content: ir.system });

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: textOf(m.content) || '',
      });
      continue;
    }
    if (m.role === 'assistant') {
      const text = textOf(m.content);
      const toolCalls = m.content
        .filter((b): b is Extract<IRContentBlock, { type: 'tool_call' }> => b.type === 'tool_call')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: b.arguments || '{}' },
        }));
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: text === '' && toolCalls.length ? null : text,
      };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      messages.push(msg);
      continue;
    }
    const single = m.content.length === 1 && m.content[0]!.type === 'text';
    messages.push({
      role: 'user',
      content: single
        ? (m.content[0] as Extract<IRContentBlock, { type: 'text' }>).text
        : m.content.map(irBlockToOpenAIContent).filter((b) => b !== null),
    });
  }

  const req: OpenAIChatRequest = {
    model,
    messages,
    stream: ir.stream,
  };
  if (ir.tools.length) {
    req.tools = ir.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
      },
    }));
  }
  if (ir.toolChoice) {
    req.tool_choice =
      ir.toolChoice.type === 'tool'
        ? { type: 'function', function: { name: ir.toolChoice.name } }
        : ir.toolChoice.type;
  }
  if (ir.maxTokens !== undefined) req.max_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) req.temperature = ir.temperature;
  if (ir.topP !== undefined) req.top_p = ir.topP;
  if (ir.stopSequences?.length) req.stop = ir.stopSequences;
  if (ir.stream) req.stream_options = { include_usage: true };
  return req;
}

function irBlockToOpenAIContent(b: IRContentBlock): Record<string, unknown> | null {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image') {
    const anyB = b as typeof b & { url?: string };
    const url = anyB.url ?? `data:${b.mediaType};base64,${b.base64}`;
    return { type: 'image_url', image_url: { url } };
  }
  return null;
}

/* ---------------------------- provider response -> IR ---------------------------- */

export function openaiChatResponseToIR(json: Record<string, any>, model: string): IRResponse {
  const choice = json.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: IRContentBlock[] = [];
  if (typeof message.content === 'string' && message.content !== '') {
    content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    content.push(...partsToIR(message.content));
  }
  for (const tc of message.tool_calls ?? []) {
    content.push({
      type: 'tool_call',
      id: String(tc.id ?? randomId('call')),
      name: String(tc.function?.name ?? ''),
      arguments: String(tc.function?.arguments ?? '{}'),
    });
  }
  return {
    model,
    content,
    finish: mapOpenAIFinish(choice.finish_reason),
    usage: mapOpenAIUsage(json.usage),
  };
}

export function mapOpenAIFinish(reason: unknown): IRFinishReason {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapOpenAIUsage(usage: Record<string, any> | undefined): IRUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
  };
}

/* ---------------------------- provider SSE -> IR events ---------------------------- */

export async function* openaiSSEToIREvents(
  body: AsyncIterable<Uint8Array>,
  model: string,
): AsyncGenerator<IRStreamEvent> {
  const indexToId = new Map<number, string>();
  for await (const sse of parseSSE(body)) {
    if (sse.data.trim() === '[DONE]') return;
    let chunk: Record<string, any>;
    try {
      chunk = JSON.parse(sse.data);
    } catch {
      continue;
    }
    if (chunk.error) {
      yield { type: 'error', message: describeOpenAIError(chunk.error) };
      return;
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (delta?.content !== undefined && delta.content !== null && delta.content !== '') {
      yield { type: 'text_delta', text: String(delta.content) };
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index: number = tc.index ?? 0;
      let id = indexToId.get(index);
      if (tc.id && tc.id !== id) {
        id = String(tc.id);
        indexToId.set(index, id);
        yield { type: 'tool_call_start', id, name: String(tc.function?.name ?? '') };
      }
      const args = tc.function?.arguments;
      if (args) yield { type: 'tool_call_delta', id: id ?? '', argumentsDelta: String(args) };
    }
    if (chunk.usage) yield { type: 'usage', usage: mapOpenAIUsage(chunk.usage) };
    if (choice?.finish_reason) {
      yield { type: 'finish', reason: mapOpenAIFinish(choice.finish_reason) };
      return;
    }
  }
  // Stream ended without a finish_reason: treat as clean stop.
  yield { type: 'finish', reason: 'stop' };
}

function describeOpenAIError(error: Record<string, any> | string): string {
  if (typeof error === 'string') return error;
  const type = typeof error.type === 'string' ? error.type : 'api_error';
  const message = typeof error.message === 'string' ? error.message : 'upstream stream error';
  return `${type}: ${message}`;
}

/* ---------------------------- IR -> client response ---------------------------- */

export function irToOpenAIChatResponse(
  resp: IRResponse,
  id = randomId('chatcmpl'),
): Record<string, unknown> {
  const text = textOf(resp.content);
  const toolCalls = resp.content
    .filter((b): b is Extract<IRContentBlock, { type: 'tool_call' }> => b.type === 'tool_call')
    .map((b) => ({
      id: b.id,
      type: 'function' as const,
      function: { name: b.name, arguments: b.arguments || '{}' },
    }));
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: resp.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text === '' && toolCalls.length ? null : text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapIRFinishToOpenAI(resp.finish),
      },
    ],
    usage: {
      prompt_tokens: resp.usage.inputTokens ?? 0,
      completion_tokens: resp.usage.outputTokens ?? 0,
      total_tokens: (resp.usage.inputTokens ?? 0) + (resp.usage.outputTokens ?? 0),
      ...(resp.usage.cacheReadTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: resp.usage.cacheReadTokens } }
        : {}),
    },
  };
}

function mapIRFinishToOpenAI(f: IRFinishReason): string {
  switch (f) {
    case 'length':
      return 'length';
    case 'tool_calls':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'stop';
  }
}

/* ---------------------------- IR events -> client SSE ---------------------------- */

export async function* irEventsToOpenAISSE(
  events: AsyncIterable<IRStreamEvent>,
  model: string,
  includeUsage: boolean,
): AsyncGenerator<string> {
  const id = randomId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    });

  let sentRole = false;
  const ensureRole = (): string[] => {
    if (sentRole) return [];
    sentRole = true;
    return [sseFormat(chunk({ role: 'assistant', content: '' }))];
  };
  const idToIndex = new Map<string, number>();
  let nextIndex = 0;
  let usage: IRUsage | undefined;

  for await (const ev of events) {
    switch (ev.type) {
      case 'text_delta':
        yield* ensureRole();
        yield sseFormat(chunk({ content: ev.text }));
        break;
      case 'tool_call_start': {
        yield* ensureRole();
        const index = nextIndex++;
        idToIndex.set(ev.id, index);
        yield sseFormat(
          chunk({
            tool_calls: [
              {
                index,
                id: ev.id,
                type: 'function',
                function: { name: ev.name, arguments: '' },
              },
            ],
          }),
        );
        break;
      }
      case 'tool_call_delta': {
        const index = idToIndex.get(ev.id) ?? 0;
        yield sseFormat(
          chunk({
            tool_calls: [{ index, function: { arguments: ev.argumentsDelta } }],
          }),
        );
        break;
      }
      case 'usage':
        if (ev.usage && Object.keys(ev.usage).length) usage = { ...usage, ...ev.usage };
        break;
      case 'error':
        yield* ensureRole();
        yield sseFormat(JSON.stringify({ error: { message: ev.message, type: 'api_error', code: null } }));
        yield sseFormat('[DONE]');
        return;
      case 'finish': {
        yield* ensureRole();
        if (ev.reason === 'error') {
          yield sseFormat(
            JSON.stringify({
              error: { message: 'upstream stream ended with an error', type: 'api_error', code: null },
            }),
          );
          yield sseFormat('[DONE]');
          return;
        }
        yield sseFormat(chunk({}, mapIRFinishToOpenAI(ev.reason)));
        if (includeUsage) {
          yield sseFormat(
            JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [],
              usage: {
                prompt_tokens: usage?.inputTokens ?? 0,
                completion_tokens: usage?.outputTokens ?? 0,
                total_tokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
              },
            }),
          );
        }
        yield sseFormat('[DONE]');
        return;
      }
    }
  }
  // No finish event: the answer is truncated, so report it as an error rather than a stop.
  yield* ensureRole();
  yield sseFormat(
    JSON.stringify({
      error: { message: 'upstream stream ended without a finish event', type: 'api_error', code: null },
    }),
  );
  yield sseFormat('[DONE]');
}
