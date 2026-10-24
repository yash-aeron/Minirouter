/**
 * Token saver: shrinks upstream input by compressing bulky tool_result text
 * (build logs, directory listings, diffs) before a request leaves the router.
 * Conservative by design — only redundancy that provably carries no unique
 * information is removed, and every edit is announced in an inline marker.
 *
 * Bypass per request with the `x-miniroute-token-saver: off` header.
 */

export interface TokenSaverOptions {
  /** only consider text blocks with at least this many lines */
  minLines?: number;
}

export interface CompressResult {
  text: string;
  savedChars: number;
}

const DUPLICATE_MARKER = '[miniroute: collapsed %N identical consecutive lines]';

export function compressToolText(text: string, minLines = 10): CompressResult {
  const lines = text.split('\n');
  if (lines.length < minLines) return { text, savedChars: 0 };

  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let run = 1;
    while (i + run < lines.length && lines[i + run] === line) run += 1;

    // Blank runs are never worth compressing: each removed line is one '\n'
    // char, less than the marker costs. Only non-empty duplicates qualify.
    if (line.trim() !== '' && run >= 3) {
      out.push(line, line, DUPLICATE_MARKER.replace('%N', String(run)));
      i += run;
      continue;
    }
    for (let k = 0; k < run; k += 1) out.push(line);
    i += run;
  }

  const compressed = out.join('\n');
  const savedChars = text.length - compressed.length;
  if (savedChars <= 0) return { text, savedChars: 0 };
  return { text: compressed, savedChars };
}

export interface TokenSaverSummary {
  /** rough token estimate (chars/4) removed from the request */
  savedTokens: number;
  blocksCompressed: number;
}

/** Compress bulky tool-result text blocks in an IR request, in place. */
export function applyTokenSaver(ir: { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> }, options: TokenSaverOptions = {}): TokenSaverSummary {
  const minLines = options.minLines ?? 10;
  let savedChars = 0;
  let blocksCompressed = 0;

  for (const message of ir.messages) {
    if (message.role !== 'tool') continue;
    for (const block of message.content) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue;
      if (block.text.split('\n').length < minLines) continue;
      const result = compressToolText(block.text, minLines);
      if (result.savedChars > 0) {
        block.text = result.text;
        savedChars += result.savedChars;
        blocksCompressed += 1;
      }
    }
  }

  return { savedTokens: Math.ceil(savedChars / 4), blocksCompressed };
}
