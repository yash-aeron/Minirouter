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
    readonly lastError?: ProviderError,
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
        const { events } = await peekFirstEvent(adapter, cand, ir);
        breakers.recordSuccess(cand.provider);
        attempts.push({ provider: cand.provider, model: cand.model, ok: true });
        return { events, provider: cand.provider, model: cand.model, attempts };
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
        // Request-shape problems will fail everywhere: surface the original
        // status and body instead of pretending this was a gateway failure.
        throw pe;
      }
    }
  }

  throw new NoCandidateError(
    lastError
      ? `all ${attempts.length} candidate(s) failed; last error: ${lastError.message}`
      : `no usable candidate in chain of ${attempts.length}`,
    attempts,
    lastError,
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
): Promise<{ events: AsyncIterable<IRStreamEvent> }> {
  const result = await adapter.send(ir, cand.model);
  const iterator = result.events?.[Symbol.asyncIterator]();
  if (!iterator) {
    throw new ProviderError(`${cand.provider}: streaming request returned no event stream`, {
      status: 502,
      retryable: true,
      provider: cand.provider,
    });
  }
  const iter = iterator;

  let first: IteratorResult<IRStreamEvent>;
  try {
    first = await iter.next();
  } catch (err) {
    await closeQuietly(iter);
    throw err;
  }

  if (first.done) {
    await closeQuietly(iter);
    throw new ProviderError(`${cand.provider}: upstream stream ended before any event`, {
      status: 502,
      retryable: true,
      provider: cand.provider,
    });
  }

  const firstEvent = first.value;
  if (firstEvent.type === 'error') {
    await closeQuietly(iter);
    throw new ProviderError(`${cand.provider}: ${firstEvent.message}`, {
      status: 502,
      retryable: firstEvent.retryable ?? true,
      provider: cand.provider,
    });
  }
  if (firstEvent.type === 'finish' && firstEvent.reason === 'error') {
    await closeQuietly(iter);
    throw new ProviderError(`${cand.provider}: upstream stream ended with an error`, {
      status: 502,
      retryable: true,
      provider: cand.provider,
    });
  }

  // Re-synthesize an iterator that yields the consumed event first.
  async function* replay(): AsyncGenerator<IRStreamEvent> {
    yield firstEvent;
    while (true) {
      const { value, done } = await iter.next();
      if (done) return;
      yield value;
    }
  }
  return { events: replay() };
}

async function closeQuietly(iter: AsyncIterator<IRStreamEvent>): Promise<void> {
  try {
    await iter.return?.(undefined);
  } catch {
    // the upstream stream is already broken; nothing useful to do
  }
}
