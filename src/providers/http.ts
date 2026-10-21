import { request } from 'undici';
import { ProviderError, isRetryableStatus } from './types.js';

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
    let snippet = '';
    try {
      snippet = (await res.body.text()).slice(0, 500);
    } catch {
      snippet = '<unreadable>';
    }
    throw new ProviderError(
      `${providerName}: upstream ${status}: ${snippet}`,
      { status, retryable: isRetryableStatus(status), provider: providerName },
    );
  }

  return {
    status,
    contentType: String(res.headers['content-type'] ?? ''),
    body: res.body as unknown as AsyncIterable<Uint8Array>,
    text: () => res.body.text(),
  };
}
