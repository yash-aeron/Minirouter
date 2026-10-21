import { IRRequest, IRResponse, IRStreamEvent } from '../core/ir.js';

/** Error thrown by provider adapters; classified for the failover engine. */
export class ProviderError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly provider: string;
  /** Raw upstream error body, kept so the client-facing error can be passed through. */
  readonly rawBody?: string;
  /** Upstream response headers worth relaying (retry-after, x-should-retry, ratelimits). */
  readonly upstreamHeaders?: Record<string, string>;

  constructor(
    message: string,
    opts: {
      status: number;
      retryable: boolean;
      provider: string;
      rawBody?: string;
      upstreamHeaders?: Record<string, string>;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.provider = opts.provider;
    this.rawBody = opts.rawBody;
    this.upstreamHeaders = opts.upstreamHeaders;
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

/**
 * Decide whether an upstream error is worth trying on the next provider.
 * Status alone is not enough for 404: "this provider does not have that model"
 * should fail over, while "your URL is wrong" should not.
 */
export function classifyUpstreamError(status: number, body: string): { retryable: boolean } {
  if (isRetryableStatus(status)) return { retryable: true };
  if (status === 404) {
    const lower = body.toLowerCase();
    // A 404 only means "try the next provider" when the model is the problem.
    // A 404 for a bad URL or missing route would fail everywhere.
    const modelProblem =
      lower.includes('model') &&
      (lower.includes('model_not_found') ||
        lower.includes('no such model') ||
        /model[^\n]{0,80}(not found|does not exist|not exist|unsupported|invalid)/.test(lower) ||
        /"message"\s*:\s*"model\b/.test(lower));
    if (modelProblem) return { retryable: true };
  }
  return { retryable: false };
}
