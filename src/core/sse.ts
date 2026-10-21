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

/** Collect an async iterable of strings into a single Response body string chunk-wise. */
export function sseStream(events: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      void events.return?.(reason);
    },
  });
}
