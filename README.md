# miniroute

A local AI gateway/router in the spirit of [9Router](https://github.com/decolua/9router) and [OmniRoute](https://github.com/diegosouzapw/OmniRoute): one local endpoint, many providers, automatic fallback. Point your coding tools (Claude Code, Codex CLI, Cursor, Cline, ...) at miniroute instead of the real provider, and a quota-exhausted or failing provider is transparently replaced by the next one in your fallback chain.

## Features

- **One endpoint, three client APIs**: OpenAI `/v1/chat/completions`, OpenAI `/v1/responses` (Codex), Anthropic `/v1/messages` (Claude Code) — any client can talk to any provider.
- **Provider types**: `openai-compat` (OpenAI, GLM, DeepSeek, Kimi, MiniMax, Groq, OpenRouter, ...), `anthropic` (native), `gemini` (native).
- **Fallback chains**: define a route like `claude-sonnet-4-6 -> [glm/glm-4.7, deepseek/deepseek-chat]`; on 401/402/429/5xx/network errors, miniroute retries the next candidate.
- **Circuit breakers**: providers that fail repeatedly are skipped for a 30s cooldown.
- **Streaming failover**: streams fail over *before* the first token reaches the client, so a dead upstream never corrupts a half-delivered answer.
- **Usage tracking**: every request is logged to SQLite (no native build needed — uses Node's built-in `node:sqlite`); inspect with `GET /v1/usage/summary`.
- **Security defaults**: binds `127.0.0.1`, per-install random API key (never a shipped default), all `/v1/*` routes behind auth.

## Quick start

```bash
npm install
npm run build          # optional; or use npx tsx
npx tsx src/index.ts init         # writes an example config to ~/.miniroute/config.json
set GLM_API_KEY=...               # keys come from the environment via "env:VAR"
npx tsx src/index.ts run
```

Get your key:

```bash
npx tsx src/index.ts key
```

Check your config:

```bash
npx tsx src/index.ts doctor
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

## Pointing tools at miniroute

API key: run `miniroute key`. Base URL: `http://127.0.0.1:4569`.

**Claude Code**
```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:4569
export ANTHROPIC_API_KEY=<miniroute key>
claude --model claude-sonnet-4-6
```

**Codex CLI**
```bash
export OPENAI_BASE_URL=http://127.0.0.1:4569
export OPENAI_API_KEY=<miniroute key>
```

**Cursor / Cline / Continue** — provider "OpenAI Compatible", base URL `http://127.0.0.1:4569/v1`, model `glm/glm-4.7` or a route alias.

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
npm test             # vitest: translators, router, e2e against a mock upstream
npm run typecheck
npm run build        # tsup -> dist/
```

## Roadmap (not yet built)

- OAuth subscription pooling (Claude Code / Codex / Gemini CLI accounts) — the fragile, ToS-gray part of 9Router; treat carefully.
- Web dashboard, RTK-style prompt compression, MCP server.

## Security notes

Designed against real CVEs found in this tool category: no hardcoded fallback secrets (the local key is generated and persisted on first run), every `/v1/*` route passes the auth middleware, no remote-command-execution features, server binds loopback by default. OAuth tokens (when implemented) will live in a 0600 file in the data dir.
