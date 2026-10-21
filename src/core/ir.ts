/**
 * Internal representation (IR): the canonical request/response format every
 * client protocol parses into and every provider adapter serializes out of.
 * Turns N client formats x M provider formats into N + M translators.
 */

export type IRFinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'error';

export interface IRUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export type IRContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string; url?: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string };

export interface IRMessage {
  role: 'user' | 'assistant' | 'tool';
  content: IRContentBlock[];
  /** only for role === 'tool' */
  toolCallId?: string;
  /** Anthropic tool_result is_error flag, kept for fidelity */
  isError?: boolean;
}

export interface IRTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface IRRequest {
  /** model name as the client asked for it (alias or provider-prefixed) */
  model: string;
  system?: string;
  messages: IRMessage[];
  tools: IRTool[];
  toolChoice?: { type: 'auto' | 'none' | 'required' } | { type: 'tool'; name: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream: boolean;
}

export interface IRResponse {
  model: string;
  content: IRContentBlock[];
  finish: IRFinishReason;
  usage: IRUsage;
}

/** Normalized stream events. Translators serialize these into each wire format. */
export type IRStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentsDelta: string }
  | { type: 'usage'; usage: IRUsage }
  | { type: 'finish'; reason: IRFinishReason };

export function textBlock(text: string): IRContentBlock {
  return { type: 'text', text };
}

export function textOf(content: IRContentBlock[]): string {
  return content
    .filter((b): b is Extract<IRContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Map tool_call ids to tool names across a conversation (Gemini needs names on results). */
export function toolNameMap(messages: IRMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_call') map.set(b.id, b.name);
    }
  }
  return map;
}

export function randomId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
