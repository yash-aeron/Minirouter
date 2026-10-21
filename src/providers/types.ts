import { IRRequest, IRResponse, IRStreamEvent } from '../core/ir.js';

/** Error thrown by provider adapters; classified for the failover engine. */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly provider: string;
  constructor(
    message: string,
    opts: { status: number; retryable: boolean; provider: string },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.provider = opts.provider;
  }
}

export interface ProviderSendResult {
  /** present when the request was non-streaming */
  response?: IRResponse;
  /** present when the request was streaming */
  events?: AsyncIterable<IRStreamEvent>;
}

export interface ProviderAdapter {
  readonly name: string;
  /** configured model allowlist; null means "accept any model name" */
  readonly models: string[] | null;
  send(ir: IRRequest, model: string): Promise<ProviderSendResult>;
}

export function isRetryableStatus(status: number): boolean {
  // Auth/quota/payment problems are "retryable" in the failover sense: another
  // provider may still serve the request. Request-shape errors (400/404/422)
  // will fail everywhere, so they surface immediately.
  return (
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status >= 500
  );
}
