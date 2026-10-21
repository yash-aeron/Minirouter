import { request } from 'undici';
import { ProviderError, classifyUpstreamError } from './types.js';

export interface UpstreamOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** ms until response headers must arrive (and max idle gap between body chunks) */
  timeoutMs?: number;
}

export interface UpstreamResponse {
  status: number;
  contentType: string;
  /** async iterable of body chunks (for SSE) */
  body: AsyncIterable<Uint8Array>;
  text: () => Promise<string>;
}

const MAX_ERROR_BODY = 64 * 1024;

export async function upstreamRequest(
  providerName: string,
  url: string,
  opts: UpstreamOptions = {},
): Promise<UpstreamResponse> {
  const timeout = Math.max(1_000, opts.timeoutMs ?? 300_000);
  let res;
  try {
    res = await request(url, {
      method: (opts.method ?? 'POST') as 'POST',
      headers: opts.headers,
      body: opts.body,
      headersTimeout: timeout,
      bodyTimeout: timeout,
    });
  } catch (err) {
    throw new ProviderError(
      `${providerName}: network error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502, retryable: true, provider: providerName },
    );
  }

  const status = res.statusCode;
  if (status >= 300) {
    let raw = '';
    try {
      raw = (await res.body.text()).slice(0, MAX_ERROR_BODY);
    } catch {
      raw = '<unreadable>';
    }
    const { retryable } = classifyUpstreamError(status, raw);
    throw new ProviderError(
      `${providerName}: upstream ${status}: ${raw.slice(0, 500)}`,
      {
        status,
        retryable,
        provider: providerName,
        rawBody: raw,
        upstreamHeaders: pickRelayHeaders(res.headers),
      },
    );
  }

  return {
    status,
    contentType: String(res.headers['content-type'] ?? ''),
    body: res.body as unknown as AsyncIterable<Uint8Array>,
    text: () => res.body.text(),
  };
}

/** Headers the client needs to make retry and usage-limit decisions. */
function pickRelayHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue;
    const name = key.toLowerCase();
    if (name === 'retry-after' || name === 'x-should-retry' || name.startsWith('anthropic-ratelimit-')) {
      out[name] = value;
    }
  }
  return out;
}
