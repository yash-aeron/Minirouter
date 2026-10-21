/** Parse an SSE body into {event, data} pairs and serialize events back out. */

export interface SSEEvent {
  event?: string;
  data: string;
}

export async function* parseSSE(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf = (buf + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = raw.split('\n');
      let event: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
    }
  }
  // A trailing block without a blank line terminator is still an event per spec leniency.
  if (buf.trim().length > 0) {
    const lines = buf.split('\n');
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
  }
}

export function sseFormat(data: string, event?: string): string {
  const lines = [`data: ${data}`];
  if (event !== undefined) lines.unshift(`event: ${event}`);
  return `${lines.join('\n')}\n\n`;
}

/**
 * Pass chunks through, emitting `ping` whenever the source is idle for
 * `intervalMs`. Keeps a single in-flight `next()` so no chunk is lost when a
 * timeout wins the race.
 */
export async function* heartbeat(
  source: AsyncIterable<string>,
  ping: string,
  intervalMs = 15_000,
): AsyncGenerator<string> {
  const iterator = source[Symbol.asyncIterator]();
  let pending: Promise<IteratorResult<string>> | null = null;
  let finished = false;
  try {
    while (true) {
      if (!pending) pending = iterator.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), intervalMs);
      });
      const outcome = await Promise.race([
        pending.then((value) => ({ kind: 'value' as const, value })),
        timeout,
      ]);
      clearTimeout(timer);
      if (outcome.kind === 'timeout') {
        yield ping;
        continue;
      }
      pending = null;
      if (outcome.value.done) {
        finished = true;
        return;
      }
      yield outcome.value.value;
    }
  } finally {
    if (!finished) {
      try {
        await iterator.return?.(undefined);
      } catch {
        // the source is already failing; nothing to clean up
      }
    }
  }
}
