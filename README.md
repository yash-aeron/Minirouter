# miniroute

A local AI gateway/router in the spirit of [9Router](https://github.com/decolua/9router) and [OmniRoute](https://github.com/diegosouzapw/OmniRoute): one local endpoint, many providers, automatic fallback. Point your coding tools (Claude Code, Codex CLI, Cursor, Cline, ...) at miniroute instead of the real provider, and a quota-exhausted or failing provider is transparently replaced by the next one in your fallback chain.

## Features

- **One endpoint, three client APIs**: OpenAI `/v1/chat/completions`, OpenAI `/v1/responses` (Codex), Anthropic `/v1/messages` (Claude Code) — any client can talk to any provider.
- **Provider types**: `openai-compat` (OpenAI, GLM, DeepSeek, Kimi, MiniMax, Groq, OpenRouter, ...), `anthropic` (native), `gemini` (native), plus OAuth-backed `anthropic` (Claude Code), `codex` (ChatGPT), and `gemini-cli` (Google Code Assist).
- **Fallback chains**: define a route like `claude-sonnet-4-6 -> [glm/glm-4.7, deepseek/deepseek-chat]`; on 401/402/429/5xx/network errors, miniroute retries the next candidate.
- **Circuit breakers**: providers that fail repeatedly are skipped for a 30s cooldown; OAuth accounts get one breaker each.
- **Subscription pooling (opt-in, experimental)**: rotate requests across several Claude Code, Codex, or Gemini CLI accounts, refresh tokens in the background, and fail over when one account is rate-limited. See [Subscription accounts](#subscription-accounts-oauth-experimental).
- **Streaming failover**: streams fail over *before* the first token reaches the client, so a dead upstream never corrupts a half-delivered answer.
- **Usage tracking**: every request is logged to SQLite (no native build needed — uses Node's built-in `node:sqlite`); inspect with `GET /v1/usage/summary`.
- **Security defaults**: binds `127.0.0.1`, per-install random API key (never a shipped default), all `/v1/*` routes behind auth.

## Requirements

Node.js 22.13 or newer. Usage tracking uses the built-in `node:sqlite`, which is unflagged from 22.13.0.

## Quick start

```bash
npm install -g miniroute      # or run the same commands with: npx miniroute@latest ...
miniroute init                # writes an example config to ~/.miniroute/config.json
export GLM_API_KEY=...        # keys come from the environment via "env:VAR"
miniroute run
```

Get your key:

```bash
miniroute key
```

Check your config (exits non-zero when a route is broken):

```bash
miniroute doctor
```

## Configuration

`~/.miniroute/config.json` (path overridable with `MINIROUTE_HOME` or `-c`):

```json
{
  "port": 4569,
  "providers": [
    { "name": "glm", "type": "openai-compat", "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
      "apiKey": "env:GLM_API_KEY", "models": ["glm-4.7"] },
    { "name": "deepseek", "type": "openai-compat", "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "env:DEEPSEEK_API_KEY", "models": ["deepseek-chat"] },
    { "name": "anthropic", "type": "anthropic", "apiKey": "env:ANTHROPIC_API_KEY" },
    { "name": "gemini", "type": "gemini", "apiKey": "env:GEMINI_API_KEY" }
  ],
  "routes": {
    "claude-sonnet-4-6": ["anthropic/claude-sonnet-4-6", "glm/glm-4.7", "deepseek/deepseek-chat"]
  }
}
```

Model names work three ways:

1. **Route alias** (`claude-sonnet-4-6` above) — an ordered fallback chain of `provider/model` entries.
2. **Provider-prefixed** (`glm/glm-4.7`) — pinned to one provider.
3. **Bare name** (`glm-4.7`) — first provider whose `models` allowlist contains it; providers without a `models` list accept any name.

`apiKey` accepts a literal or `env:VAR_NAME` (preferred — the config file holds no secrets). Config is hot-reloaded on change.

## Subscription accounts (OAuth, experimental)

miniroute can spend your own Claude, ChatGPT, or Google subscription instead of an API key. This is
**opt-in** and deliberately limited to personal accounts. Sign in once per account:

```bash
miniroute auth login claude --label work     # Claude Code: paste the code shown in the browser
miniroute auth login codex  --label desk     # ChatGPT: opens a localhost callback (port 1455)
miniroute auth login gemini --label personal # Google: opens a localhost callback
miniroute auth list                          # id, provider, label, expiry — never tokens
miniroute auth refresh [id]                  # refresh one account, or all of them
miniroute auth remove <id>
```

Gemini login needs your own Google OAuth client (create a **Desktop app** client in the Google Cloud
Console). Set both variables when logging in and when running the gateway, so tokens can be
refreshed:

```bash
export MINIROUTE_GEMINI_CLIENT_ID=...apps.googleusercontent.com
export MINIROUTE_GEMINI_CLIENT_SECRET=...
miniroute auth login gemini --label personal
```

Use the id from `auth list` (or the label) in a provider:

```json
{
  "providers": [
    { "name": "claude-sub", "type": "anthropic",  "auth": "oauth", "accounts": ["claude-work"] },
    { "name": "codex-sub",  "type": "codex",      "auth": "oauth", "accounts": ["codex-desk"] },
    { "name": "gemini-sub", "type": "gemini-cli", "auth": "oauth", "accounts": ["gemini-personal"] }
  ],
  "routes": {
    "claude-sonnet-4-6": ["claude-sub/claude-sonnet-4-6", "glm/glm-4.7"]
  }
}
```

How it behaves:

- Requests rotate round-robin across the provider's `accounts`; each account has its own circuit
  breaker, so one dead subscription does not take the whole provider out of the chain.
- Tokens are refreshed five minutes before expiry (one refresh per account even under concurrent
  load). A 401 triggers one forced refresh, one retry, then normal failover.
- Claude requests use `Authorization: Bearer` and the OAuth beta flag, and never send `x-api-key`.
  Codex requests go to the ChatGPT Codex backend in the Responses format. Gemini requests use the
  Code Assist envelope with the Cloud project discovered at login.
- Claude login is a paste-the-code flow (`code#state`). Codex and Gemini open a browser and listen
  on loopback; Codex needs TCP port 1455 free by default (`--port` overrides).

> **Read this before using it.** Claude and Codex reuse OAuth clients published inside the official
> CLIs; Gemini uses the Google OAuth client you provide. They are not public APIs. Providers can
> change, rate-limit, or block them at any time, and using them may violate the provider's terms of
> service. Use only with **your own personal accounts** — never shared, team, or enterprise
> accounts — and assume an account can be suspended.
> Codex and Gemini support is experimental. If you need reliability or a contract, use an API key.

Tokens are stored only in `<data dir>/oauth.json` (written atomically with `0600` permissions where
the platform supports it); they never appear in the config, logs, or command output. `auth list`
prints only id, provider, label, and expiry. Set `MINIROUTE_HOME` to keep this file somewhere else.

## Pointing tools at miniroute

API key: run `miniroute key`. Base URL: `http://127.0.0.1:4569`.

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4569   # origin only, no /v1
export ANTHROPIC_API_KEY=<miniroute key>           # sent as x-api-key
# or, instead of ANTHROPIC_API_KEY:
# export ANTHROPIC_AUTH_TOKEN=<miniroute key>      # sent as Authorization: Bearer
export ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4-5  # optional: cheap model for background calls
claude --model claude-sonnet-4-6
```
Claude Code appends `/v1/messages` itself, so `ANTHROPIC_BASE_URL` must not include `/v1`.

**Codex CLI**
```bash
export OPENAI_BASE_URL=http://127.0.0.1:4569
export OPENAI_API_KEY=<miniroute key>
```

**Cursor / Cline / Continue** — provider "OpenAI Compatible", base URL `http://127.0.0.1:4569/v1`, model `glm/glm-4.7` or a route alias.

## Claude Code compatibility

- Both credential headers are accepted: `x-api-key` (Claude Code, Anthropic SDKs) and `Authorization: Bearer`.
- `anthropic-beta`, `anthropic-version`, and `x-claude-code-*` request headers are forwarded to native Anthropic upstreams, so beta features keep working.
- `cache_control` markers, block-form `system` prompts, mid-conversation `system` messages, and `thinking` / `redacted_thinking` blocks survive translation. Non-Anthropic upstreams cannot use Anthropic-only fields: cache markers are dropped and reasoning blocks are not re-emitted.
- Non-retryable upstream errors are returned with their original status and body; `retry-after`, `x-should-retry`, and `anthropic-ratelimit-*` headers are relayed. Chain exhaustion maps the last error to 429/402, otherwise 502.
- A stream that dies after the first token ends with `event: error` for Anthropic clients, or an error chunk followed by `[DONE]` for OpenAI clients. It never looks like a clean stop, and the request is logged with `ok: false`.
- `/v1/messages/count_tokens` is not implemented; Claude Code falls back to its local character-based estimate.
- Idle streams receive heartbeat pings (Anthropic `event: ping`, otherwise an SSE comment). Override the interval with `MINIROUTE_HEARTBEAT_MS`.

## API

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming + tools) |
| `POST /v1/messages` | Anthropic Messages (streaming + tools) |
| `POST /v1/responses` | OpenAI Responses (Codex) |
| `GET /v1/models` | Union of provider models + route aliases |
| `GET /v1/usage/summary` | Totals, per-provider, per-model, recent requests |
| `GET /healthz` | Liveness (no auth) |

## Development

```bash
npm run dev          # tsx watch entrypoint
npm test             # vitest: translators, router, auth, SSE, e2e against a mock upstream
npm run typecheck
npm run build        # tsup -> dist/
npm run smoke:dist   # after build: starts the dist CLI against a mock upstream
```

## Roadmap (not yet built)

- More OAuth providers, a web dashboard, RTK-style prompt compression, an MCP server.

## Security notes

Designed against real CVEs found in this tool category: no hardcoded fallback secrets (the local key is generated and persisted on first run), every `/v1/*` route passes the auth middleware, no remote-command-execution features, server binds loopback by default. OAuth tokens live in a `0600` file (`oauth.json`) in the data dir, are written atomically, and are never logged or printed.
