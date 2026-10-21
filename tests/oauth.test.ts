import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fetch } from 'undici';
import { startCallbackServer } from '../src/oauth/callback.js';
import { challengeFor, createVerifier } from '../src/oauth/pkce.js';
import { clearRefreshState, refreshAccount } from '../src/oauth/refresh.js';
import { redactSecrets, redactText } from '../src/oauth/redact.js';
import { OAuthPool } from '../src/oauth/pool.js';
import { TokenStore } from '../src/oauth/token-store.js';
import { OAuthAccount, RefreshedTokens } from '../src/oauth/types.js';
import { FetchLike } from '../src/oauth/http.js';
import { loginClaude } from '../src/oauth/claude-code.js';
import { exchangeCodexCode, loginCodex } from '../src/oauth/codex.js';
import { discoverGeminiProject, exchangeGeminiCode, loginGemini } from '../src/oauth/gemini-cli.js';
import { ProviderError } from '../src/providers/types.js';

const dirs: string[] = [];

function newStore(): TokenStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-oauth-'));
  dirs.push(dir);
  return new TokenStore(path.join(dir, 'oauth.json'));
}

afterEach(() => {
  clearRefreshState();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function account(overrides: Partial<OAuthAccount> = {}): OAuthAccount {
  return {
    id: 'claude-test',
    label: 'test',
    accessToken: 'access-token-value',
    refreshToken: 'refresh-token-value',
    expiresAt: Date.now() + 3600_000,
    ...overrides,
  };
}

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

describe('pkce', () => {
  it('matches the RFC 7636 appendix B vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(createVerifier()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('token store', () => {
  it('round-trips accounts atomically and resolves labels', () => {
    const store = newStore();
    const first = account({ id: store.makeId('claude', 'Work Laptop'), label: 'Work Laptop' });
    expect(first.id).toBe('claude-work-laptop');
    store.upsert('claude', first);

    expect(store.get('claude', first.id)).toEqual(first);
    expect(store.resolve('claude', 'work laptop')?.id).toBe(first.id);
    expect(store.resolveOrThrow('claude', first.id).accessToken).toBe(first.accessToken);

    const updated = store.update('claude', first.id, { accessToken: 'new-access-token' });
    expect(updated?.accessToken).toBe('new-access-token');
    expect(store.resolveOrThrow('claude', first.id).refreshToken).toBe(first.refreshToken);

    const stored = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
    expect(stored.accounts.claude[0].accessToken).toBe('new-access-token');
    expect(fs.readdirSync(path.dirname(store.filePath)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('creates unique ids and removes by id or label', () => {
    const store = newStore();
    store.upsert('codex', account({ id: store.makeId('codex', 'work'), label: 'work' }));
    const second = account({ id: store.makeId('codex', 'work'), label: 'work' });
    expect(second.id).toBe('codex-work-2');
    store.upsert('codex', second);

    expect(store.removeAny('codex-work')).toBe('codex');
    expect(store.list('codex').map((a) => a.id)).toEqual(['codex-work-2']);
    expect(store.removeAny('codex-work-2')).toBe('codex');
    expect(store.list('codex')).toHaveLength(0);
  });

  it('rejects malformed stores instead of silently dropping tokens', () => {
    const store = newStore();
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    fs.writeFileSync(store.filePath, '{"accounts":{"claude":[{"id":"x"}]}}');
    expect(() => store.load()).toThrow(/malformed/);
    fs.writeFileSync(store.filePath, 'not json');
    expect(() => store.load()).toThrow(/not valid JSON/);
  });
});

describe('redaction', () => {
  it('removes known secrets and token-shaped text', () => {
    expect(redactSecrets('token=abcdefghij', ['abcdefghij'])).toBe('token=[redacted]');
    const text = 'Authorization: Bearer sk-abcdefghijkl refresh_token=sekret-value';
    const redacted = redactText(text);
    expect(redacted).not.toContain('abcdefghijkl');
    expect(redacted).not.toContain('sekret-value');
  });
});

describe('refresh', () => {
  it('refreshes only accounts inside the skew window', async () => {
    const store = newStore();
    const fresh = account({ expiresAt: Date.now() + 30 * 60_000 });
    let calls = 0;
    const refresh = async (): Promise<RefreshedTokens> => {
      calls += 1;
      return { accessToken: 'new', expiresAt: Date.now() + 3600_000 };
    };

    expect((await refreshAccount(store, 'claude', fresh, refresh)).accessToken).toBe(fresh.accessToken);
    expect(calls).toBe(0);

    const expiring = account({ expiresAt: Date.now() + 60_000 });
    const updated = await refreshAccount(store, 'claude', expiring, refresh);
    expect(updated.accessToken).toBe('new');
    expect(updated.refreshToken).toBe(expiring.refreshToken);
    expect(calls).toBe(1);
  });

  it('single-flights concurrent refreshes and persists the result', async () => {
    const store = newStore();
    const expiring = account({ expiresAt: Date.now() - 1000 });
    store.upsert('claude', expiring);

    let calls = 0;
    const refresh = async (): Promise<RefreshedTokens> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { accessToken: 'shared-token', expiresAt: Date.now() + 3600_000 };
    };

    const [a, b, c] = await Promise.all([
      refreshAccount(store, 'claude', expiring, refresh),
      refreshAccount(store, 'claude', expiring, refresh),
      refreshAccount(store, 'claude', expiring, refresh),
    ]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe('shared-token');
    expect(b.accessToken).toBe('shared-token');
    expect(c.accessToken).toBe('shared-token');
    expect(store.get('claude', expiring.id)?.accessToken).toBe('shared-token');
  });

  it('force-refreshes and redacts secrets from refresh errors', async () => {
    const store = newStore();
    const fresh = account();
    let calls = 0;
    await refreshAccount(
      store,
      'claude',
      fresh,
      async () => {
        calls += 1;
        return { accessToken: 'x', expiresAt: Date.now() + 3600_000 };
      },
      { force: true },
    );
    expect(calls).toBe(1);

    await expect(
      refreshAccount(
        store,
        'claude',
        fresh,
        async () => {
          throw new Error(`token endpoint rejected ${fresh.refreshToken}`);
        },
        { force: true },
      ),
    ).rejects.toThrow(/token refresh failed/);
    await expect(
      refreshAccount(
        store,
        'claude',
        fresh,
        async () => {
          throw new Error(`token endpoint rejected ${fresh.refreshToken}`);
        },
        { force: true },
      ),
    ).rejects.not.toThrow(/refresh-token-value/);
  });
});

describe('OAuth pool', () => {
  function seededPool(ids: string[], refreshCalls?: { count: number }) {
    const store = newStore();
    for (const id of ids) {
      store.upsert('claude', account({ id, label: id, expiresAt: Date.now() + 3600_000 }));
    }
    const refresh = async (): Promise<RefreshedTokens> => {
      if (refreshCalls) refreshCalls.count += 1;
      return { accessToken: 'refreshed-token', expiresAt: Date.now() + 3600_000 };
    };
    const pool = new OAuthPool('claude', store, ids, { refresh, label: 'claude' });
    return { store, pool };
  }

  it('round-robins across accounts', async () => {
    const order: string[] = [];
    const { pool } = seededPool(['a', 'b', 'c']);
    for (let i = 0; i < 4; i += 1) {
      await pool.run(async (acc) => {
        order.push(acc.id);
        return acc.id;
      });
    }
    expect(order).toEqual(['a', 'b', 'c', 'a']);
  });

  it('isolates breakers per account', async () => {
    const attempts: string[] = [];
    const outcomes: string[] = [];
    let aFailures = 0;
    const store = newStore();
    for (const id of ['a', 'b']) {
      store.upsert('claude', account({ id, label: id, expiresAt: Date.now() + 3600_000 }));
    }
    const pool = new OAuthPool('claude', store, ['a', 'b'], {
      refresh: async () => ({ accessToken: 'x', expiresAt: Date.now() + 3600_000 }),
      label: 'claude',
    });

    for (let i = 0; i < 7; i += 1) {
      try {
        const { result } = await pool.run(async (acc) => {
          attempts.push(acc.id);
          if (acc.id === 'a') {
            aFailures += 1;
            throw new ProviderError('boom', { status: 500, retryable: true, provider: 'claude' });
          }
          return acc.id;
        });
        outcomes.push(result);
      } catch {
        outcomes.push('failed');
      }
    }
    // a trips after three failures; later requests skip it and stay on b.
    expect(aFailures).toBe(3);
    expect(attempts.filter((id) => id === 'a')).toHaveLength(3);
    expect(outcomes).toEqual(['failed', 'b', 'failed', 'b', 'failed', 'b', 'b']);
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const refreshCalls = { count: 0 };
    const tokensUsed: string[] = [];
    let calls = 0;
    const { pool, store } = seededPool(['a'], refreshCalls);

    const { result } = await pool.run(async (acc) => {
      tokensUsed.push(acc.accessToken);
      calls += 1;
      if (calls === 1) {
        throw new ProviderError('unauthorized', { status: 401, retryable: true, provider: 'claude' });
      }
      return acc.accessToken;
    });
    expect(result).toBe('refreshed-token');
    expect(calls).toBe(2);
    expect(refreshCalls.count).toBe(1);
    expect(tokensUsed).toEqual(['access-token-value', 'refreshed-token']);
    expect(store.get('claude', 'a')?.accessToken).toBe('refreshed-token');
  });

  it('surfaces a retryable error when every account is cooling down', async () => {
    const store = newStore();
    store.upsert('claude', account({ id: 'only', expiresAt: Date.now() + 3600_000 }));
    const pool = new OAuthPool('claude', store, ['only'], {
      refresh: async () => ({ accessToken: 'x', expiresAt: Date.now() + 3600_000 }),
      label: 'claude',
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(
        pool.run(async () => {
          throw new ProviderError('dead', { status: 500, retryable: true, provider: 'claude' });
        }),
      ).rejects.toThrow('dead');
    }
    await expect(pool.run(async () => 'never')).rejects.toMatchObject({ status: 503, retryable: true });
  });
});

describe('callback server', () => {
  it('accepts one matching callback and returns the page', async () => {
    const server = await startCallbackServer('state-abc', { timeoutMs: 5000 });
    const res = await fetch(`${server.redirectUri}?code=the-code&state=state-abc`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('close this window');
    await expect(server.result).resolves.toEqual({ code: 'the-code', state: 'state-abc' });
  });

  it('rejects a state mismatch', async () => {
    const server = await startCallbackServer('expected', { timeoutMs: 5000 });
    const rejected = expect(server.result).rejects.toThrow(/state mismatch/);
    const res = await fetch(`${server.redirectUri}?code=the-code&state=wrong`);
    expect(res.status).toBe(400);
    await rejected;
  });

  it('times out when nothing arrives', async () => {
    const server = await startCallbackServer('s', { timeoutMs: 50 });
    await expect(server.result).rejects.toThrow(/timed out/);
  });
});

describe('OAuth logins against mocked endpoints', () => {
  it('completes the Claude paste-the-code flow with PKCE', async () => {
    const store = newStore();
    const logged: string[] = [];
    let tokenRequest: any;
    let authUrl = '';

    const fetchImpl: FetchLike = async (url, init) => {
      tokenRequest = { url, body: JSON.parse(init?.body ?? '{}') };
      return jsonResponse({
        access_token: 'claude-access',
        refresh_token: 'claude-refresh',
        expires_in: 3600,
        scope: 'user:inference',
        account: { uuid: 'acct-uuid' },
      });
    };

    const signedIn = await loginClaude(store, 'Work', {
      fetchImpl,
      prompt: async () => 'paste-code',
      log: (line) => {
        logged.push(line);
        if (line.includes('oauth/authorize')) authUrl = line;
      },
      now: () => 1_000_000,
    });

    expect(signedIn.id).toBe('claude-work');
    expect(signedIn.accountId).toBe('acct-uuid');
    expect(signedIn.expiresAt).toBe(1_000_000 + 3600_000);
    expect(tokenRequest.url).toContain('/v1/oauth/token');
    expect(tokenRequest.body).toMatchObject({
      grant_type: 'authorization_code',
      code: 'paste-code',
      client_id: expect.any(String),
    });

    const url = new URL(authUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(challengeFor(tokenRequest.body.code_verifier));
    expect(url.searchParams.get('state')).toBeTruthy();

    expect(store.get('claude', 'claude-work')?.accessToken).toBe('claude-access');
    expect(JSON.stringify(logged)).not.toContain('claude-access');
  });

  it('verifies the Codex exchange, account id claim, and refresh', async () => {
    const payload = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'chatgpt-123' }, exp: 2_000_000 }),
    )
      .toString('base64url');
    const idToken = `header.${payload}.sig`;
    let form = '';
    const fetchImpl: FetchLike = async (_url, init) => {
      form = init?.body ?? '';
      return jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 60, id_token: idToken });
    };

    const tokens = await exchangeCodexCode({
      code: 'c',
      verifier: 'v',
      redirectUri: 'http://127.0.0.1:1455/auth/callback',
      fetchImpl,
      now: () => 1000,
    });
    expect(tokens.accountId).toBe('chatgpt-123');
    expect(tokens.expiresAt).toBe(61_000);
    expect(form).toContain('grant_type=authorization_code');
    expect(form).toContain('code_verifier=v');
  });

  it('completes the Codex localhost callback flow', async () => {
    const store = newStore();
    let authUrl = '';
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ access_token: 'codex-access', refresh_token: 'codex-refresh', expires_in: 3600 });

    const pending = loginCodex(store, 'desk', {
      fetchImpl,
      port: 0,
      log: (line) => {
        if (line.includes('auth.openai.com')) authUrl = line;
      },
      now: () => 5000,
    });

    // Give the listener a moment, then play the browser's role.
    for (let i = 0; i < 50 && !authUrl; i += 1) await new Promise((r) => setTimeout(r, 10));
    const url = new URL(authUrl);
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    const state = url.searchParams.get('state')!;
    const res = await fetch(`${redirect.href}?code=abc&state=${state}`);
    expect(res.status).toBe(200);

    const signedIn = await pending;
    expect(signedIn.id).toBe('codex-desk');
    expect(signedIn.accessToken).toBe('codex-access');
  });

  it('discovers the Gemini Code Assist project (existing and onboarding)', async () => {
    const calls: string[] = [];
    const existing: FetchLike = async (url) => {
      calls.push(url);
      return jsonResponse({ cloudaicompanionProject: { id: 'proj-existing' } });
    };
    await expect(discoverGeminiProject('token', { fetchImpl: existing })).resolves.toBe('proj-existing');
    expect(calls[0]).toContain(':loadCodeAssist');

    const onboarding: FetchLike = async (url) => {
      calls.push(url);
      if (url.endsWith(':loadCodeAssist')) return jsonResponse({});
      if (url.endsWith(':onboardUser')) {
        return jsonResponse({ done: true, response: { cloudaicompanionProject: 'proj-new' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    await expect(discoverGeminiProject('token', { fetchImpl: onboarding, pollMs: 0 })).resolves.toBe('proj-new');
  });

  it('completes the Gemini loopback flow with project discovery', async () => {
    const store = newStore();
    let authUrl = '';
    const fetchImpl: FetchLike = async (url) => {
      if (url.endsWith(':loadCodeAssist')) return jsonResponse({ cloudaicompanionProject: 'proj-1' });
      return jsonResponse({ access_token: 'gem-access', refresh_token: 'gem-refresh', expires_in: 3600 });
    };

    const pending = loginGemini(store, 'personal', {
      fetchImpl,
      port: 0,
      clientId: 'test-gemini-client',
      clientSecret: 'test-gemini-secret',
      log: (line) => {
        if (line.includes('accounts.google.com')) authUrl = line;
      },
    });

    for (let i = 0; i < 50 && !authUrl; i += 1) await new Promise((r) => setTimeout(r, 10));
    const url = new URL(authUrl);
    expect(url.searchParams.get('client_id')).toBe('test-gemini-client');
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    const res = await fetch(`${redirect.href}?code=gem-code&state=${url.searchParams.get('state')}`);
    expect(res.status).toBe(200);

    const signedIn = await pending;
    expect(signedIn.projectId).toBe('proj-1');
    expect(signedIn.accessToken).toBe('gem-access');
    expect(store.get('gemini', 'gemini-personal')?.projectId).toBe('proj-1');
  });
});
