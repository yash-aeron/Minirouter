/**
 * Anthropic Messages API translation: client side and provider side.
 */
import {
  IRContentBlock,
  IRFinishReason,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRUsage,
  randomId,
} from './ir.js';
import { parseSSE, sseFormat } from './sse.js';

/* ---------------------------- client -> IR ---------------------------- */

export function anthropicRequestToIR(body: Record<string, any>): IRRequest {
  const messages: IRRequest['messages'] = [];

  for (const m of body.messages ?? []) {
    const role: 'user' | 'assistant' = m.role === 'assistant' ? 'assistant' : 'user';
    const blocksIn = Array.isArray(m.content)
      ? m.content
      : typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : [];
    const content: IRContentBlock[] = [];
    const toolResults: Array<{ id: string; content: IRContentBlock[]; isError?: boolean }> = [];

    for (const b of blocksIn) {
      if (b.type === 'text') content.push({ type: 'text', text: String(b.text ?? '') });
      else if (b.type === 'image') {
        if (b.source?.type === 'base64') {
          content.push({
            type: 'image',
            mediaType: String(b.source.media_type ?? ''),
            base64: String(b.source.data ?? ''),
          });
        } else if (b.source?.type === 'url') {
          content.push({ type: 'image', mediaType: '', base64: '', url: String(b.source.url ?? '') });
        }
      } else if (b.type === 'tool_use') {
        content.push({
          type: 'tool_call',
          id: String(b.id ?? randomId('toolu')),
          name: String(b.name ?? ''),
          arguments: JSON.stringify(b.input ?? {}),
        });
      } else if (b.type === 'tool_result') {
        const inner = Array.isArray(b.content)
          ? b.content
              .map((x: any) =>
                x.type === 'text'
                  ? ({ type: 'text', text: String(x.text ?? '') } as IRContentBlock)
                  : x.type === 'image' && x.source?.type === 'base64'
                    ? ({
                        type: 'image',
                        mediaType: String(x.source.media_type ?? ''),
                        base64: String(x.source.data ?? ''),
                      } as IRContentBlock)
                    : null,
              )
              .filter((x: IRContentBlock | null): x is IRContentBlock => x !== null)
          : typeof b.content === 'string'
            ? [{ type: 'text', text: b.content }]
            : [];
        toolResults.push({
          id: String(b.tool_use_id ?? ''),
          content: inner.length ? inner : [{ type: 'text', text: '' }],
          isError: Boolean(b.is_error),
        });
      }
      // thinking blocks: dropped in v1
    }

    if (role === 'assistant') {
      messages.push({ role: 'assistant', content });
    } else if (toolResults.length && content.length === 0) {
      for (const tr of toolResults) {
        messages.push({ role: 'tool', toolCallId: tr.id, content: tr.content, isError: tr.isError });
      }
    } else {
      if (content.length) messages.push({ role: 'user', content });
      for (const tr of toolResults) {
        messages.push({ role: 'tool', toolCallId: tr.id, content: tr.content, isError: tr.isError });
      }
    }
  }

  const system = Array.isArray(body.system)
    ? body.system.map((b: any) => String(b.text ?? '')).filter(Boolean).join('\n\n')
    : typeof body.system === 'string'
      ? body.system
      : undefined;

  let toolChoice: IRRequest['toolChoice'];
  switch (body.tool_choice?.type) {
    case 'auto':
      toolChoice = { type: 'auto' };
      break;
    case 'any':
      toolChoice = { type: 'required' };
      break;
    case 'none':
      toolChoice = { type: 'none' };
      break;
    case 'tool':
      toolChoice = { type: 'tool', name: String(body.tool_choice.name ?? '') };
      break;
  }

  return {
    model: String(body.model ?? ''),
    system: system || undefined,
    messages,
    tools: (body.tools ?? []).map((t: any) => ({
      name: String(t.name ?? ''),
      description: t.description as string | undefined,
      parameters: t.input_schema as Record<string, unknown> | undefined,
    })),
    toolChoice,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    stopSequences: body.stop_sequences,
    stream: Boolean(body.stream),
  };
}

/* ---------------------------- IR -> provider request ---------------------------- */

export function irToAnthropicRequest(ir: IRRequest, model: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];

  const flushToolResults = (pending: Array<{ id: string; content: IRContentBlock[]; isError?: boolean }>) => {
    if (!pending.length) return;
    messages.push({
      role: 'user',
      content: pending.map((tr) => ({
        type: 'tool_result',
        tool_use_id: tr.id,
        content: tr.content.map(irBlockToAnthropic),
        ...(tr.isError ? { is_error: true } : {}),
      })),
    });
    pending.length = 0;
  };

  let pendingTools: Array<{ id: string; content: IRContentBlock[]; isError?: boolean }> = [];
  for (const m of ir.messages) {
    if (m.role === 'tool') {
      pendingTools.push({ id: m.toolCallId ?? '', content: m.content, isError: m.isError });
      continue;
    }
    flushToolResults(pendingTools);
    messages.push({
      role: m.role,
      content: m.content.map(irBlockToAnthropic),
    });
  }
  flushToolResults(pendingTools);

  const req: Record<string, unknown> = {
    model,
    max_tokens: ir.maxTokens ?? 8192,
    messages,
    stream: ir.stream,
  };
  if (ir.system) req.system = ir.system;
  if (ir.tools.length) {
    req.tools = ir.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      input_schema: t.parameters ?? { type: 'object' },
    }));
  }
  if (ir.toolChoice) {
    req.tool_choice =
      ir.toolChoice.type === 'required'
        ? { type: 'any' }
        : ir.toolChoice.type === 'tool'
          ? { type: 'tool', name: ir.toolChoice.name }
          : { type: ir.toolChoice.type };
  }
  if (ir.temperature !== undefined) req.temperature = ir.temperature;
  if (ir.topP !== undefined) req.top_p = ir.topP;
  if (ir.stopSequences?.length) req.stop_sequences = ir.stopSequences;
  return req;
}

function irBlockToAnthropic(b: IRContentBlock): Record<string, unknown> {
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'image') {
    if (b.url) return { type: 'image', source: { type: 'url', url: b.url } };
    return {
      type: 'image',
      source: { type: 'base64', media_type: b.mediaType, data: b.base64 },
    };
  }
  return {
    type: 'tool_use',
    id: b.id,
    name: b.name,
    input: safeParse(b.arguments),
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/* ---------------------------- provider response -> IR ---------------------------- */

export function anthropicResponseToIR(json: Record<string, any>, model: string): IRResponse {
  const content: IRContentBlock[] = [];
  for (const b of json.content ?? []) {
    if (b.type === 'text') content.push({ type: 'text', text: String(b.text ?? '') });
    else if (b.type === 'tool_use') {
      content.push({
        type: 'tool_call',
        id: String(b.id ?? randomId('toolu')),
        name: String(b.name ?? ''),
        arguments: JSON.stringify(b.input ?? {}),
      });
    }
  }
  return {
    model,
    content,
    finish: mapAnthropicFinish(json.stop_reason),
    usage: mapAnthropicUsage(json.usage),
  };
}

export function mapAnthropicFinish(reason: unknown): IRFinishReason {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'stop';
  }
}

export function mapAnthropicUsage(usage: Record<string, any> | undefined): IRUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  };
}

/* ---------------------------- provider SSE -> IR events ---------------------------- */

export async function* anthropicSSEToIREvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<IRStreamEvent> {
  let finished = false;
  for await (const sse of parseSSE(body)) {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(sse.data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start':
        yield { type: 'usage', usage: mapAnthropicUsage(ev.message?.usage) };
        break;
      case 'content_block_start':
        if (ev.content_block?.type === 'tool_use') {
          yield {
            type: 'tool_call_start',
            id: String(ev.content_block.id ?? ''),
            name: String(ev.content_block.name ?? ''),
          };
        }
        break;
      case 'content_block_delta': {
        const d = ev.delta;
        if (d?.type === 'text_delta') yield { type: 'text_delta', text: String(d.text ?? '') };
        else if (d?.type === 'input_json_delta') {
          yield { type: 'tool_call_delta', id: '', argumentsDelta: String(d.partial_json ?? '') };
        }
        break;
      }
      case 'message_delta':
        if (ev.usage) yield { type: 'usage', usage: mapAnthropicUsage(ev.usage) };
        if (ev.delta?.stop_reason) {
          finished = true;
          yield { type: 'finish', reason: mapAnthropicFinish(ev.delta.stop_reason) };
          return;
        }
        break;
      case 'error':
        finished = true;
        yield { type: 'finish', reason: 'error' };
        return;
      case 'message_stop':
        return;
    }
  }
  if (!finished) yield { type: 'finish', reason: 'stop' };
}

/* ---------------------------- IR -> client response ---------------------------- */

export function irToAnthropicResponse(resp: IRResponse): Record<string, unknown> {
  return {
    id: randomId('msg'),
    type: 'message',
    role: 'assistant',
    model: resp.model,
    content: resp.content.map((b) => irBlockToAnthropic(b)),
    stop_reason: mapIRFinishToAnthropic(resp.finish),
    stop_sequence: null,
    usage: irUsageToAnthropic(resp.usage),
  };
}

function mapIRFinishToAnthropic(f: IRFinishReason): string {
  switch (f) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function irUsageToAnthropic(u: IRUsage): Record<string, unknown> {
  const out: Record<string, number> = {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
  };
  if (u.cacheReadTokens !== undefined) out.cache_read_input_tokens = u.cacheReadTokens;
  if (u.cacheWriteTokens !== undefined) out.cache_creation_input_tokens = u.cacheWriteTokens;
  return out;
}

/* ---------------------------- IR events -> client SSE ---------------------------- */

export async function* irEventsToAnthropicSSE(
  events: AsyncIterable<IRStreamEvent>,
  model: string,
): AsyncGenerator<string> {
  const id = randomId('msg');
  let started = false;
  let blockIndex = -1;
  let openBlock: 'text' | 'tool_use' | null = null;
  let usage: IRUsage = {};

  const startMessage = () => {
    started = true;
    return sseFormat(
      JSON.stringify({
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: usage.inputTokens ?? 0, output_tokens: 1 },
        },
      }),
      'message_start',
    );
  };

  const openTextBlock = () => {
    blockIndex += 1;
    openBlock = 'text';
    return sseFormat(
      JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      }),
      'content_block_start',
    );
  };

  const openToolBlock = (toolId: string, name: string) => {
    blockIndex += 1;
    openBlock = 'tool_use';
    return sseFormat(
      JSON.stringify({
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'tool_use', id: toolId, name, input: {} },
      }),
      'content_block_start',
    );
  };

  const closeBlock = () =>
    openBlock === null
      ? ''
      : sseFormat(JSON.stringify({ type: 'content_block_stop', index: blockIndex }), 'content_block_stop');

  let out = '';
  const emit = (s: string) => {
    out += s;
  };

  for await (const ev of events) {
    if (!started) emit(startMessage());
    switch (ev.type) {
      case 'text_delta':
        if (openBlock !== 'text') {
          emit(closeBlock());
          emit(openTextBlock());
        }
        emit(
          sseFormat(
            JSON.stringify({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'text_delta', text: ev.text },
            }),
            'content_block_delta',
          ),
        );
        break;
      case 'tool_call_start':
        emit(closeBlock());
        emit(openToolBlock(ev.id, ev.name));
        break;
      case 'tool_call_delta':
        if (openBlock !== 'tool_use') break;
        emit(
          sseFormat(
            JSON.stringify({
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: ev.argumentsDelta },
            }),
            'content_block_delta',
          ),
        );
        break;
      case 'usage':
        usage = { ...usage, ...ev.usage };
        break;
      case 'finish': {
        emit(closeBlock());
        openBlock = null;
        emit(
          sseFormat(
            JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: mapIRFinishToAnthropic(ev.reason), stop_sequence: null },
              usage: { output_tokens: usage.outputTokens ?? 0 },
            }),
            'message_delta',
          ),
        );
        emit(sseFormat(JSON.stringify({ type: 'message_stop' }), 'message_stop'));
        yield out;
        return;
      }
    }
    if (out !== '') {
      yield out;
      out = '';
    }
  }
  // Stream ended without finish: close politely.
  if (started) {
    emit(closeBlock());
    emit(
      sseFormat(
        JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: usage.outputTokens ?? 0 },
        }),
        'message_delta',
      ),
    );
    emit(sseFormat(JSON.stringify({ type: 'message_stop' }), 'message_stop'));
    yield out;
  }
}
