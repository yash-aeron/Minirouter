/**
 * OpenAI Responses API translation (client side). Supports the subset coding
 * agents use: instructions, message items, function calls/outputs, streaming.
 * Reasoning items are accepted and dropped (v1).
 */
import {
  IRContentBlock,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRUsage,
  randomId,
  textOf,
} from './ir.js';
import { sseFormat } from './sse.js';

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
        yield ev('response.completed', { response: base('completed') });
        return;
      }
    }
  }
  if (!created) {
    yield ev('response.created', { response: base('in_progress') });
  }
  yield ev('response.completed', { response: base('completed') });
}

function responsesUsage(u: IRUsage): Record<string, number> {
  return {
    input_tokens: u.inputTokens ?? 0,
    output_tokens: u.outputTokens ?? 0,
    total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
  };
}
