/**
 * Failover executor: walks the candidate chain, skipping open breakers,
 * retrying retryable errors on the next candidate. For streaming requests,
 * failover is only possible before the first event has been observed.
 */
import { IRRequest, IRResponse, IRStreamEvent } from '../core/ir.js';
import { ProviderAdapter, ProviderError } from '../providers/types.js';
import { Breakers } from './breaker.js';
import { Candidate } from './chain.js';

export interface AttemptRecord {
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
  status?: number;
}

export interface FailoverResult {
  /** present on success, non-streaming */
  response?: IRResponse;
  /** present on success, streaming: [events, effectiveModel] */
  events?: AsyncIterable<IRStreamEvent>;
  provider: string;
  model: string;
  attempts: AttemptRecord[];
}

export class NoCandidateError extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptRecord[],
  ) {
    super(message);
    this.name = 'NoCandidateError';
  }
}

export async function executeWithFailover(
  ir: IRRequest,
  candidates: Candidate[],
  registry: Map<string, ProviderAdapter>,
  breakers: Breakers,
): Promise<FailoverResult> {
  const attempts: AttemptRecord[] = [];
  let lastError: ProviderError | undefined;

  for (const cand of candidates) {
    const adapter = registry.get(cand.provider);
    if (!adapter) {
      attempts.push({ provider: cand.provider, model: cand.model, ok: false, error: 'unknown provider' });
      continue;
    }
    if (breakers.isOpen(cand.provider)) {
      attempts.push({
        provider: cand.provider,
        model: cand.model,
        ok: false,
        error: 'circuit breaker open',
      });
      continue;
    }

    try {
      if (ir.stream) {
        const { events, sawFirstEvent } = await peekFirstEvent(adapter, cand, ir);
        if (sawFirstEvent && events) {
          breakers.recordSuccess(cand.provider);
          attempts.push({ provider: cand.provider, model: cand.model, ok: true });
          return { events, provider: cand.provider, model: cand.model, attempts };
        }
        // Provider accepted the request but produced no events before failing;
        // the generator already threw into `result.error` handling below.
        continue;
      }

      const result = await adapter.send(ir, cand.model);
      breakers.recordSuccess(cand.provider);
      attempts.push({ provider: cand.provider, model: cand.model, ok: true });
      return {
        response: result.response,
        provider: cand.provider,
        model: cand.model,
        attempts,
      };
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError(`unexpected error: ${err instanceof Error ? err.message : String(err)}`, {
              status: 500,
              retryable: true,
              provider: cand.provider,
            });
      attempts.push({
        provider: cand.provider,
        model: cand.model,
        ok: false,
        error: pe.message,
        status: pe.status,
      });
      breakers.recordFailure(cand.provider, pe);
      lastError = pe;
      if (!pe.retryable) {
        throw new NoCandidateError(pe.message, attempts);
      }
    }
  }

  throw new NoCandidateError(
    lastError
      ? `all ${attempts.length} candidate(s) failed; last error: ${lastError.message}`
      : `no usable candidate in chain of ${attempts.length}`,
    attempts,
  );
}

/**
 * Start the streaming call and wait for the first IR event. Returns the event
 * iterator only once an event is actually available, so the caller never
 * commits to a dead stream. Failover happens here, before anything reaches
 * the client.
 */
async function peekFirstEvent(
  adapter: ProviderAdapter,
  cand: Candidate,
  ir: IRRequest,
): Promise<{ events?: AsyncIterable<IRStreamEvent>; sawFirstEvent: boolean }> {
  const result = await adapter.send(ir, cand.model);
  const iterator = result.events?.[Symbol.asyncIterator]();
  if (!iterator) return { sawFirstEvent: false };
  const iter = iterator;

  // Promise.race wrapper: first event vs stream error.
  const first = await iter.next();
  if (first.done) return { sawFirstEvent: false };
  if (first.value.type === 'finish' && first.value.reason === 'error') {
    return { sawFirstEvent: false };
  }

  // Re-synthesize an iterator that yields the consumed event first.
  async function* replay(): AsyncGenerator<IRStreamEvent> {
    yield first.value;
    while (true) {
      const { value, done } = await iter.next();
      if (done) return;
      yield value;
    }
  }
  return { events: replay(), sawFirstEvent: true };
}
