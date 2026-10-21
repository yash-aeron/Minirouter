#!/usr/bin/env node
/**
 * Post-build smoke test: proves the packed CLI actually starts, authenticates,
 * and speaks all three client APIs against a local mock upstream.
 *
 * Run with `npm run smoke:dist` after `npm run build`.
 */
import { spawn, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');

if (!fs.existsSync(entry)) {
  console.error(`missing ${entry}; run "npm run build" first`);
  process.exit(1);
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // not ready yet
      }
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const json = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const sse = (chunks) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of chunks) res.write(chunk);
      res.end();
    };

    if (req.url === '/v1/messages') {
      json({
        id: 'msg_smoke',
        type: 'message',
        role: 'assistant',
        model: 'mock-1',
        content: [{ type: 'text', text: 'smoke-anthropic' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      return;
    }

    if (req.url === '/v1/chat/completions') {
      const parsed = JSON.parse(body || '{}');
      if (parsed.stream) {
        sse([
          `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: 'smoke-' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'stream' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
          'data: [DONE]\n\n',
        ]);
        return;
      }
      json({
        choices: [{ message: { role: 'assistant', content: 'smoke-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
});

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'miniroute-smoke-'));
let child;
let exitInfo;

try {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const upstream = `http://127.0.0.1:${mock.address().port}`;
  const port = await freePort();

  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: [
        {
          name: 'mock',
          type: 'openai-compat',
          baseUrl: `${upstream}/v1`,
          apiKey: 'smoke-upstream-key',
          models: ['mock-1'],
        },
      ],
      routes: { 'smoke-model': ['mock/mock-1'] },
    }),
  );

  const env = { ...process.env, MINIROUTE_HOME: home };
  const key = await new Promise((resolve, reject) => {
    execFile(process.execPath, [entry, 'key'], { cwd: root, env }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
  assert(key.startsWith('mr-'), `unexpected API key from "miniroute key": ${key}`);

  child = spawn(process.execPath, [entry, 'run', '-c', configPath, '-p', String(port)], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.once('exit', (code, signal) => {
    exitInfo = { code, signal };
  });

  const base = `http://127.0.0.1:${port}`;
  const auth = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };

  await waitFor(
    async () => (await fetch(`${base}/healthz`)).ok,
    10_000,
    'server startup',
  );

  const health = await fetch(`${base}/healthz`);
  assert(health.status === 200, `healthz returned ${health.status}`);

  const models = await fetch(`${base}/v1/models`, { headers: auth });
  assert(models.status === 200, `/v1/models returned ${models.status}`);
  const modelIds = (await models.json()).data.map((m) => m.id);
  assert(modelIds.includes('smoke-model'), `/v1/models missing route alias: ${modelIds}`);

  const unauthorized = await fetch(`${base}/v1/models`);
  assert(unauthorized.status === 401, `unauthenticated /v1/models returned ${unauthorized.status}`);

  const chat = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'smoke-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert(chat.status === 200, `chat returned ${chat.status}`);
  const chatBody = await chat.json();
  assert(chatBody.choices[0].message.content === 'smoke-ok', 'unexpected chat response');

  const stream = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'smoke-model', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert(stream.status === 200, `streaming chat returned ${stream.status}`);
  const streamText = await stream.text();
  assert(streamText.includes('smoke-'), 'streaming chat lost content');
  assert(streamText.includes('[DONE]'), 'streaming chat did not terminate with [DONE]');

  const anthropic = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { ...auth, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'smoke-model', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert(anthropic.status === 200, `anthropic messages returned ${anthropic.status}`);
  const anthropicBody = await anthropic.json();
  assert(anthropicBody.type === 'message', 'unexpected anthropic response shape');
  assert(anthropicBody.content[0].text === 'smoke-ok', 'unexpected anthropic content');

  child.kill('SIGTERM');
  await waitFor(() => exitInfo !== undefined, 5_000, 'clean shutdown');
  if (process.platform !== 'win32') {
    assert(exitInfo.code === 0, `server exited with code ${exitInfo.code} on SIGTERM`);
  }

  console.log('smoke: dist CLI started, authenticated, served chat/stream/messages, and exited cleanly');
} catch (err) {
  if (child && exitInfo === undefined) child.kill('SIGKILL');
  console.error(`smoke failed: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  if (child && exitInfo === undefined) {
    child.kill('SIGKILL');
    await waitFor(() => exitInfo !== undefined, 2_000, 'child exit').catch(() => {});
  }
  mock.close();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows may hold the SQLite file briefly; the temp dir is disposable.
  }
}
