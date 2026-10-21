/**
 * Redaction helpers. Tokens, authorization codes, and PKCE verifiers must never
 * reach a log line, an error message, or the terminal.
 */

const MIN_SECRET_LENGTH = 8;

/** Replace every occurrence of a known secret with a fixed marker. */
export function redactSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * Best-effort scrubbing for error messages from libraries that may echo a
 * request body (token endpoints, fetch errors). Keeps the message useful.
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/\b(mr-[A-Za-z0-9_-]{8,})/g, '[redacted]')
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, '[redacted]')
    .replace(/(access_token|refresh_token|id_token|code_verifier|client_secret)"?\s*[:=]\s*"?[^"&,\s]+/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, '$1[redacted]');
}

export function redactError(err: unknown, secrets: Array<string | undefined | null> = []): string {
  const message = err instanceof Error ? err.message : String(err);
  return redactSecrets(redactText(message), secrets);
}
