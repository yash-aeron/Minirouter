/**
 * Loopback OAuth callback listener.
 *
 * One request wins: the first valid code closes the listener, so a replayed
 * redirect cannot overwrite the result. Times out after five minutes.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServerOptions {
  /** 0 (default) picks an ephemeral port; fixed ports are needed by some clients. */
  port?: number;
  path?: string;
  host?: string;
  timeoutMs?: number;
}

export interface CallbackServer {
  redirectUri: string;
  result: Promise<CallbackResult>;
  close: () => void;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#111}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;

export function startCallbackServer(
  expectedState: string,
  opts: CallbackServerOptions = {},
): Promise<CallbackServer> {
  const host = opts.host ?? '127.0.0.1';
  const pathname = opts.path ?? '/callback';
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  let settle!: (value: CallbackResult) => void;
  let fail!: (err: Error) => void;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    fail = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
  });

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${host}`);
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request');
      return;
    }
    if (url.pathname !== pathname) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const description = url.searchParams.get('error_description') ?? '';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE('Authorization failed', 'You can close this window and return to the terminal.'));
      fail(new Error(`authorization failed: ${oauthError}${description ? ` (${description})` : ''}`));
      server.close();
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state') ?? '';
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE('Missing code', 'The authorization response did not include a code.'));
      fail(new Error('authorization callback did not include a code'));
      server.close();
      return;
    }
    if (state !== expectedState) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE('State mismatch', 'The authorization response did not match this login attempt.'));
      fail(new Error('OAuth state mismatch; start the login again'));
      server.close();
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE('Signed in', 'You can close this window and return to the terminal.'));
    settle({ code, state });
    server.close();
  });

  return new Promise<CallbackServer>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener('error', reject);
      const address = server.address() as AddressInfo;
      timer = setTimeout(() => {
        fail(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the OAuth callback`));
        server.close();
      }, timeoutMs);
      timer.unref?.();
      resolve({
        redirectUri: `http://${host}:${address.port}${pathname}`,
        result,
        close: () => {
          fail(new Error('OAuth callback listener closed'));
          server.close();
        },
      });
    });
  });
}
