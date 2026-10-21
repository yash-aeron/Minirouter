/**
 * OpenAI Responses API translation (client side). Supports the subset coding
 * agents use: instructions, message items, function calls/outputs, streaming.
 * Reasoning items are accepted and dropped (v1).
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

/* ---------------------------- client -> IR ---------------------------- */

export function responsesRequestToIR(body: Record<string, any>): IRRequest {
  const messages: IRRequest['messages'] = [];
  const systemParts: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions) systemParts.push(body.instructions);

  const input = body.input;
  const items: Array<Record<string, any>> =
    typeof input === 'string'
      ? [{ type: 'message', role: 'user', content: input }]
      : Array.isArray(input)
        ? input
        : [];

  for (const item of items) {
    if (item.type === 'message' || item.role) {
      const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null;
      const content = item.content ?? '';
      const blocks: IRContentBlock[] = [];
      if (typeof content === 'string') {
        if (content) blocks.push({ type: 'text', text: content });
      } else if (Array.isArray(content)) {
        for (const p of content) {
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
            blocks.push({ type: 'text', text: String(p.text ?? '') });
          } else if (p.type === 'input_image' && p.image_url) {
            const url: string = String(p.image_url ?? '');
            const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
            if (m) blocks.push({ type: 'image', mediaType: m[1]!, base64: m[2]! });
            else if (url) blocks.push({ type: 'image', mediaType: '', base64: '', url });
          }
        }
      }
      if (role === null) {
        systemParts.push(textOf(blocks));
      } else if (role === 'assistant') {
        messages.push({ role: 'assistant', content: blocks });
      } else {
        messages.push({ role: 'user', content: blocks });
      }
      continue;
    }
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            id: String(item.call_id ?? item.id ?? randomId('call')),
            name: String(item.name ?? ''),
            arguments: String(item.arguments ?? '{}'),
          },
        ],
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      const output = item.output;
      const text =
        typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output);
      messages.push({
        role: 'tool',
        toolCallId: String(item.call_id ?? ''),
        content: [{ type: 'text', text }],
      });
      continue;
    }
    // reasoning items and anything else: dropped
  }

  let toolChoice: IRRequest['toolChoice'];
  const tc = body.tool_choice;
  if (tc === 'auto' || tc === 'none' || tc === 'required') toolChoice = { type: tc };
  else if (tc && typeof tc === 'object' && tc.type === 'function') {
    toolChoice = { type: 'tool', name: String(tc.name ?? '') };
  }

  return {
    model: String(body.model ?? ''),
    system: systemParts.length ? systemParts.filter(Boolean).join('\n\n') : undefined,
    messages,
    tools: (body.tools ?? [])
      .filter((t: any) => t.type === 'function')
      .map((t: any) => ({
        name: String(t.name ?? ''),
        description: t.description as string | undefined,
        parameters: t.parameters as Record<string, unknown> | undefined,
      })),
    toolChoice,
    maxTokens: body.max_output_tokens,
    temperature: body.temperature,
    stopSequences: undefined,
    stream: Boolean(body.stream),
  };
}

/* ---------------------------- IR -> client response ---------------------------- */

interface FinalItem {
  type: 'message' | 'function_call';
  item: Record<string, unknown>;
}

export function irToResponsesResponse(resp: IRResponse): Record<string, unknown> {
  const output: Array<Record<string, unknown>> = [];
  const text = textOf(resp.content);
  if (text) {
    output.push({
      type: 'message',
      id: randomId('msg'),
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const b of resp.content) {
    if (b.type !== 'tool_call') continue;
    output.push({
      type: 'function_call',
      id: randomId('fc'),
      call_id: b.id,
      name: b.name,
      arguments: b.arguments || '{}',
      status: 'completed',
    });
  }
  return {
    id: randomId('resp'),
    object: 'response',
    status: 'completed',
    model: resp.model,
    output,
    usage: {
      input_tokens: resp.usage.inputTokens ?? 0,
      output_tokens: resp.usage.outputTokens ?? 0,
      total_tokens: (resp.usage.inputTokens ?? 0) + (resp.usage.outputTokens ?? 0),
    },
  };
}

/* ---------------------------- IR events -> client SSE ---------------------------- */

export async function* irEventsToResponsesSSE(
  events: AsyncIterable<IRStreamEvent>,
  model: string,
): AsyncGenerator<string> {
  const id = randomId('resp');
  const finalItems: FinalItem[] = [];
  let created = false;
  let outputIndex = -1;
  let openKind: 'message' | 'function_call' | null = null;
  let openItemId = '';
  let openCallId = '';
  let openName = '';
  let textBuf = '';
  let argsBuf = '';
  let usage: IRUsage = {};

  const base = (status: string) => ({
    id,
    object: 'response',
    status,
    model,
    ...(status === 'completed'
      ? { output: finalItems.map((f) => f.item), usage: responsesUsage(usage) }
      : { output: [] }),
  });

  const ev = (type: string, data: Record<string, unknown>) => sseFormat(JSON.stringify({ type, ...data }), type);

  for await (const e of events) {
    if (!created) {
      created = true;
      yield ev('response.created', { response: base('in_progress') });
      yield ev('response.in_progress', { response: base('in_progress') });
    }
    switch (e.type) {
      case 'text_delta': {
        if (openKind !== 'message') {
          outputIndex += 1;
          openKind = 'message';
          openItemId = randomId('msg');
          textBuf = '';
          yield ev('response.output_item.added', {
            output_index: outputIndex,
            item: {
              type: 'message',
              id: openItemId,
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          });
        }
        textBuf += e.text;
        yield ev('response.output_text.delta', {
          item_id: openItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: e.text,
        });
        break;
      }
      case 'tool_call_start': {
        outputIndex += 1;
        openKind = 'function_call';
        openItemId = randomId('fc');
        openCallId = e.id;
        openName = e.name;
        argsBuf = '';
        yield ev('response.output_item.added', {
          output_index: outputIndex,
          item: {
            type: 'function_call',
            id: openItemId,
            call_id: e.id,
            name: e.name,
            arguments: '',
            status: 'in_progress',
          },
        });
        break;
      }
      case 'tool_call_delta': {
        if (openKind !== 'function_call') break;
        argsBuf += e.argumentsDelta;
        yield ev('response.function_call_arguments.delta', {
          item_id: openItemId,
          output_index: outputIndex,
          delta: e.argumentsDelta,
        });
        break;
      }
      case 'usage':
        usage = { ...usage, ...e.usage };
        break;
      case 'error': {
        yield ev('response.failed', {
          response: {
            ...base('failed'),
            error: { code: 'upstream_error', message: e.message },
          },
        });
        return;
      }
      case 'finish': {
        if (openKind === 'message') {
          const item = {
            type: 'message',
            id: openItemId,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: textBuf, annotations: [] }],
          };
          yield ev('response.output_text.done', {
            item_id: openItemId,
            output_index: outputIndex,
            content_index: 0,
            text: textBuf,
          });
          yield ev('response.output_item.done', { output_index: outputIndex, item });
          finalItems.push({ type: 'message', item });
        } else if (openKind === 'function_call') {
          const item = {
            type: 'function_call',
            id: openItemId,
            call_id: openCallId,
            name: openName,
            arguments: argsBuf,
            status: 'completed',
          };
          yield ev('response.function_call_arguments.done', {
            item_id: openItemId,
            output_index: outputIndex,
            arguments: argsBuf,
          });
          yield ev('response.output_item.done', { output_index: outputIndex, item });
          finalItems.push({ type: 'function_call', item });
        }
        openKind = null;
        if (e.reason === 'error') {
          yield ev('response.failed', {
            response: {
              ...base('failed'),
              error: { code: 'upstream_error', message: 'upstream stream ended with an error' },
            },
          });
          return;
        }
        yield ev('response.completed', { response: base('completed') });
        return;
      }
    }
  }
  if (!created) {
    yield ev('response.created', { response: base('in_progress') });
  }
  yield ev('response.failed', {
    response: {
      ...base('failed'),
      error: { code: 'upstream_error', message: 'upstream stream ended without a finish event' },
    },
  });
}

function responsesUsage(u: IRUsage): Record<string, number> {
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
  };
}

/* ---------------------------- IR -> provider request ---------------------------- */

/**
 * Serialize the IR for an OpenAI Responses upstream (the Codex backend speaks
 * this shape). System text becomes `instructions`; Anthropic-only fields are
 * dropped because the wire protocol has no place for them.
 */
export function irToResponsesRequest(ir: IRRequest, model: string): Record<string, unknown> {
  const instructionParts: string[] = [];
  if (ir.systemBlocks?.length) {
    for (const block of ir.systemBlocks) if (block.text) instructionParts.push(block.text);
  } else if (ir.system) {
    instructionParts.push(ir.system);
  }

  const input: Array<Record<string, unknown>> = [];
  for (const message of ir.messages) {
    if (message.role === 'system') {
      const text = textOf(message.content);
      if (text) instructionParts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      const output = textOf(message.content);
      const callId = message.toolCallId ?? '';
      if (callId) input.push({ type: 'function_call_output', call_id: callId, output });
      continue;
    }
    const textParts: string[] = [];
    const images: Array<Record<string, unknown>> = [];
    for (const block of message.content) {
      if (block.type === 'text') {
        if (block.text) textParts.push(block.text);
      } else if (block.type === 'image') {
        images.push({
          type: 'input_image',
          image_url: block.url ?? `data:${block.mediaType};base64,${block.base64}`,
        });
      } else if (block.type === 'tool_call' && message.role === 'assistant') {
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: block.arguments || '{}',
        });
      }
    }
    if (message.role === 'assistant') {
      const text = textParts.join('');
      if (text) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        });
      }
    } else if (textParts.length || images.length) {
      const content: Array<Record<string, unknown>> = [];
      for (const text of textParts) content.push({ type: 'input_text', text });
      content.push(...images);
      input.push({ type: 'message', role: 'user', content });
    }
  }

  const request: Record<string, unknown> = {
    model,
    input,
    stream: ir.stream,
  };
  const instructions = instructionParts.filter(Boolean).join('\n\n');
  if (instructions) request.instructions = instructions;
  if (ir.tools.length) {
    request.tools = ir.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
      strict: false,
    }));
    request.tool_choice =
      ir.toolChoice?.type === 'tool'
        ? { type: 'function', name: ir.toolChoice.name }
        : (ir.toolChoice?.type ?? 'auto');
  }
  if (ir.maxTokens !== undefined) request.max_output_tokens = ir.maxTokens;
  if (ir.temperature !== undefined) request.temperature = ir.temperature;
  if (ir.topP !== undefined) request.top_p = ir.topP;
  return request;
}

/* ---------------------------- provider response -> IR ---------------------------- */

export function responsesResponseToIR(json: Record<string, any>, model: string): IRResponse {
  const content: IRContentBlock[] = [];
  for (const item of Array.isArray(json.output) ? json.output : []) {
    if (item?.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if ((part?.type === 'output_text' || part?.type === 'text') && typeof part.text === 'string' && part.text) {
          content.push({ type: 'text', text: part.text });
        }
      }
    } else if (item?.type === 'function_call') {
      content.push({
        type: 'tool_call',
        id: String(item.call_id ?? item.id ?? randomId('call')),
        name: String(item.name ?? ''),
        arguments: argumentsToString(item.arguments),
      });
    }
  }

  const hasToolCall = content.some((b) => b.type === 'tool_call');
  let finish: IRFinishReason = hasToolCall ? 'tool_calls' : 'stop';
  if (json.status === 'incomplete') {
    const reason = json.incomplete_details?.reason;
    finish = reason === 'max_output_tokens' ? 'length' : reason === 'content_filter' ? 'content_filter' : 'stop';
  }

  return { model, content, finish, usage: usageFromResponses(json.usage) };
}

function argumentsToString(value: unknown): string {
  if (typeof value === 'string') return value || '{}';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '{}';
}

function responseNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageFromResponses(usage: any): IRUsage {
  if (!usage || typeof usage !== 'object') return {};
  const result: IRUsage = {};
  const input = responseNumber(usage.input_tokens);
  const output = responseNumber(usage.output_tokens);
  const cached = responseNumber(usage.input_tokens_details?.cached_tokens);
  if (input !== undefined) result.inputTokens = input;
  if (output !== undefined) result.outputTokens = output;
  if (cached !== undefined) result.cacheReadTokens = cached;
  return result;
}

/* ---------------------------- provider SSE -> IR events ---------------------------- */

/**
 * Parse a Responses SSE stream (Codex backend) into IR stream events.
 *
 * Function calls carry two ids: the item id (used by delta events) and the
 * call id (used by the follow-up `function_call_output`). Deltas are remapped
 * to the call id so tool round-trips work.
 */
export async function* responsesSSEToIREvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<IRStreamEvent> {
  const itemToCall = new Map<string, string>();
  const started = new Set<string>();
  const argsEmitted = new Set<string>();
  let sawToolCall = false;
  let usage: IRUsage = {};

  const startFunctionCall = (item: Record<string, any>): IRStreamEvent | null => {
    const callId = String(item.call_id ?? item.id ?? randomId('call'));
    const itemId = String(item.id ?? callId);
    itemToCall.set(itemId, callId);
    sawToolCall = true;
    if (started.has(itemId)) return null;
    started.add(itemId);
    return { type: 'tool_call_start', id: callId, name: String(item.name ?? '') };
  };

  const emitArgs = (itemId: string, args: unknown): IRStreamEvent | null => {
    if (!itemId || argsEmitted.has(itemId)) return null;
    argsEmitted.add(itemId);
    const callId = itemToCall.get(itemId);
    if (!callId) return null;
    return { type: 'tool_call_delta', id: callId, argumentsDelta: argumentsToString(args) };
  };

  for await (const event of parseSSE(body)) {
    if (event.data === '[DONE]') break;
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      continue;
    }
    const type = String(payload?.type ?? event.event ?? '');

    switch (type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = payload.delta;
        if (typeof delta === 'string' && delta) yield { type: 'text_delta', text: delta };
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = payload.item;
        if (item?.type !== 'function_call') break;
        const start = startFunctionCall(item);
        if (start) yield start;
        if (item.arguments !== undefined && item.arguments !== '') {
          const delta = emitArgs(String(item.id ?? item.call_id ?? ''), item.arguments);
          if (delta) yield delta;
        }
        break;
      }
      case 'response.function_call_arguments.delta': {
        const itemId = String(payload.item_id ?? '');
        const delta = payload.delta;
        if (typeof delta === 'string' && delta && itemId) {
          argsEmitted.add(itemId);
          const callId = itemToCall.get(itemId);
          if (callId) yield { type: 'tool_call_delta', id: callId, argumentsDelta: delta };
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const itemId = String(payload.item_id ?? '');
        const delta = emitArgs(itemId, payload.arguments);
        if (delta) yield delta;
        break;
      }
      case 'response.completed':
      case 'response.incomplete':
      case 'response.done': {
        const response = payload.response ?? payload;
        // Some backends only include function calls in the final response.
        for (const item of Array.isArray(response?.output) ? response.output : []) {
          if (item?.type !== 'function_call') continue;
          const start = startFunctionCall(item);
          if (start) yield start;
          const delta = emitArgs(String(item.id ?? item.call_id ?? ''), item.arguments);
          if (delta) yield delta;
        }
        usage = { ...usage, ...usageFromResponses(response?.usage) };
        if (Object.keys(usage).length) yield { type: 'usage', usage };
        const incomplete = response?.status === 'incomplete';
        const reason = incomplete ? response?.incomplete_details?.reason : undefined;
        const finish: IRFinishReason = incomplete
          ? reason === 'max_output_tokens'
            ? 'length'
            : reason === 'content_filter'
              ? 'content_filter'
              : 'stop'
          : sawToolCall
            ? 'tool_calls'
            : 'stop';
        yield { type: 'finish', reason: finish };
        return;
      }
      case 'response.failed': {
        const response = payload.response ?? payload;
        const message = response?.error?.message ?? payload?.error?.message ?? 'upstream response failed';
        yield { type: 'error', message: String(message) };
        return;
      }
      case 'error': {
        const message = payload?.error?.message ?? payload?.message ?? 'upstream stream error';
        yield { type: 'error', message: String(message) };
        return;
      }
      default:
        break;
    }
  }

  // The stream ended without a completion event: surface it as an error rather
  // than a silent clean stop.
  yield { type: 'error', message: 'upstream stream ended without a completion event' };
}
