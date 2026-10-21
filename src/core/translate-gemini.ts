/**
 * Google Gemini generateContent translation (provider side).
 */
import {
  IRContentBlock,
  IRFinishReason,
  IRRequest,
  IRResponse,
  IRStreamEvent,
  IRUsage,
} from './ir.js';
import { parseSSE } from './sse.js';
import { toolNameMap } from './ir.js';

export function irToGeminiRequest(ir: IRRequest): Record<string, unknown> {
  const contents: Array<Record<string, unknown>> = [];

  const flushTools = (pending: Array<{ name: string; response: unknown }>) => {
    if (!pending.length) return;
    contents.push({
      role: 'user',
      parts: pending.map((t) => ({ functionResponse: { name: t.name, response: t.response } })),
    });
    pending.length = 0;
  };

  const nameMap = toolNameMap(ir.messages);
  let pendingTools: Array<{ name: string; response: unknown }> = [];

  for (const m of ir.messages) {
    if (m.role === 'tool') {
      const name = nameMap.get(m.toolCallId ?? '') ?? 'tool';
      const text = m.content
        .filter((b): b is Extract<IRContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      pendingTools.push({ name, response: toolResponsePayload(text) });
      continue;
    }
    flushTools(pendingTools);
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts: Array<Record<string, unknown>> = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text });
      else if (b.type === 'image' && !b.url) {
        parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
      } else if (b.type === 'tool_call') {
        parts.push({ functionCall: { name: b.name, args: safeParse(b.arguments) } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  flushTools(pendingTools);

  const req: Record<string, unknown> = { contents };
  if (ir.system) req.systemInstruction = { parts: [{ text: ir.system }] };
  if (ir.tools.length && ir.toolChoice?.type !== 'none') {
    req.tools = [
      {
        functionDeclarations: ir.tools.map((t) => ({
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: t.parameters ?? { type: 'object' },
        })),
      },
    ];
    if (ir.toolChoice?.type === 'required') {
      req.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    } else if (ir.toolChoice?.type === 'tool') {
      req.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [ir.toolChoice.name] },
      };
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (ir.maxTokens !== undefined) generationConfig.maxOutputTokens = ir.maxTokens;
  if (ir.temperature !== undefined) generationConfig.temperature = ir.temperature;
  if (ir.topP !== undefined) generationConfig.topP = ir.topP;
  if (ir.stopSequences?.length) generationConfig.stopSequences = ir.stopSequences;
  if (Object.keys(generationConfig).length) req.generationConfig = generationConfig;
  return req;
}

function toolResponsePayload(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text);
    if (typeof v === 'object' && v !== null) return v as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { result: text };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s || '{}');
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function mapGeminiFinish(reason: unknown, hasToolCalls: boolean): IRFinishReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
      return 'content_filter';
    case 'STOP':
    case 'OTHER':
    default:
      return hasToolCalls ? 'tool_calls' : 'stop';
  }
}

export function mapGeminiUsage(u: Record<string, any> | undefined): IRUsage {
  if (!u) return {};
  return {
    inputTokens: u.promptTokenCount,
    outputTokens: u.candidatesTokenCount,
    cacheReadTokens: u.cachedContentTokenCount,
  };
}

/** Extract IR content blocks from one GenerateContentResponse JSON. */
export function geminiPartsToBlocks(
  json: Record<string, any>,
  callIdPrefix: string,
): { blocks: IRContentBlock[]; finish: IRFinishReason | null; usage: IRUsage } {
  const cand = json.candidates?.[0];
  const blocks: IRContentBlock[] = [];
  let hasToolCalls = false;
  let callN = 0;
  for (const part of cand?.content?.parts ?? []) {
    if (typeof part.text === 'string' && part.text !== '') {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.functionCall) {
      hasToolCalls = true;
      blocks.push({
        type: 'tool_call',
        id: `${callIdPrefix}_${callN++}`,
        name: String(part.functionCall.name ?? ''),
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      });
    }
  }
  return {
    blocks,
    finish: cand?.finishReason ? mapGeminiFinish(cand.finishReason, hasToolCalls) : null,
    usage: mapGeminiUsage(json.usageMetadata),
  };
}

export function geminiResponseToIR(json: Record<string, any>, model: string): IRResponse {
  const { blocks, finish, usage } = geminiPartsToBlocks(json, 'call');
  return { model, content: blocks, finish: finish ?? 'stop', usage };
}

export async function* geminiSSEToIREvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<IRStreamEvent> {
  let callN = 0;
  let sawToolCall = false;
  for await (const sse of parseSSE(body)) {
    let json: Record<string, any>;
    try {
      json = JSON.parse(sse.data);
    } catch {
      continue;
    }
    const cand = json.candidates?.[0];
    for (const part of cand?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.text !== '') {
        yield { type: 'text_delta', text: part.text };
      } else if (part.functionCall) {
        sawToolCall = true;
        const id = `call_${callN++}`;
        yield {
          type: 'tool_call_start',
          id,
          name: String(part.functionCall.name ?? ''),
        };
        yield {
          type: 'tool_call_delta',
          id,
          argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
        };
      }
    }
    if (json.usageMetadata) {
      yield { type: 'usage', usage: mapGeminiUsage(json.usageMetadata) };
    }
    if (cand?.finishReason) {
      yield { type: 'finish', reason: mapGeminiFinish(cand.finishReason, sawToolCall) };
      return;
    }
  }
  yield { type: 'finish', reason: 'stop' };
}
