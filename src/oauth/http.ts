/**
 * Minimal HTTP helpers for OAuth endpoints. Structural fetch types keep src/
 * free of DOM libs while accepting the platform fetch in production and a
 * mock in tests.
 */
import { redactText } from './redact.js';

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<HttpResponseLike>;

export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

function timeoutSignal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  } catch {
    return undefined;
  }
}

async function readJson<T>(response: HttpResponseLike, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} failed (HTTP ${response.status}): ${redactText(text.slice(0, 500))}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned a non-JSON response: ${redactText(text.slice(0, 200))}`);
  }
}

export async function postJson<T>(
  fetchImpl: FetchLike,
  url: string,
  body: Record<string, unknown>,
  label: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: timeoutSignal(),
  });
  return readJson<T>(response, label);
}

export async function getJson<T>(
  fetchImpl: FetchLike,
  url: string,
  label: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json', ...headers },
    signal: timeoutSignal(),
  });
  return readJson<T>(response, label);
}

export async function postForm<T>(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
  label: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      ...headers,
    },
    body: new URLSearchParams(form).toString(),
    signal: timeoutSignal(),
  });
  return readJson<T>(response, label);
}

export const platformFetch = globalThis.fetch as unknown as FetchLike;
