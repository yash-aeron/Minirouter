import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import { AppConfig, loadConfig, watchConfig } from './config.js';
import { checkAuth } from './auth.js';
import { buildRegistry, Registry } from './providers/registry.js';
import { Breakers } from './router/breaker.js';
import { ChainResolver } from './router/chain.js';
import { executeWithFailover, NoCandidateError } from './router/failover.js';
import { ProviderError } from './providers/types.js';
import { IRRequest, IRStreamEvent, IRUsage } from './core/ir.js';
import {
  anthropicRequestToIR,
  anthropicStreamError,
  irEventsToAnthropicSSE,
  irToAnthropicResponse,
} from './core/translate-anthropic.js';
import {
  irEventsToOpenAISSE,
  irToOpenAIChatResponse,
  openaiChatRequestToIR,
  OpenAIChatRequest,
} from './core/translate-openai.js';
import {
  irEventsToResponsesSSE,
  irToResponsesResponse,
  responsesRequestToIR,
} from './core/translate-responses.js';
import { heartbeat, sseFormat } from './core/sse.js';
import { UsageStore } from './usage/store.js';

type WireFormat = 'anthropic' | 'openai' | 'responses';

interface State {
  config: AppConfig;
  registry: Registry;
  breakers: Breakers;
  chain: ChainResolver;
  usage: UsageStore;
}

interface AppOptions {
  configPath: string;
  apiKey: string;
  authEnabled: boolean;
  state: State;
  rebuild: () => void;
}

interface ErrorInfo {
  status: number;
  message: string;
  /** set when the error came from an upstream provider and can be relayed */
  upstream?: ProviderError;
}

function errorStatus(err: unknown): ErrorInfo {
  if (err instanceof NoCandidateError) {
    const last = err.lastError;
    // Preserve rate-limit / payment semantics so clients back off correctly.
    const status = last?.status === 429 ? 429 : last?.status === 402 ? 402 : 502;
    return { status, message: err.message, upstream: last };
  }
  if (err instanceof ProviderError) {
    return { status: err.status >= 400 ? err.status : 502, message: err.message, upstream: err };
  }
  return {
    status: 400,
    message: err instanceof Error ? err.message : String(err),
  };
}

function anthropicError(status: number, message: string) {
  return { type: 'error', error: { type: status === 400 ? 'invalid_request_error' : 'api_error', message } };
}

function openaiError(status: number, message: string) {
  return { error: { message, type: status === 400 ? 'invalid_request_error' : 'api_error', code: null } };
}

function emptyUsage(): IRUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Headers that carry client capabilities and must reach the upstream verbatim. */
const FORWARDED_HEADER_PREFIXES = ['anthropic-', 'x-claude-code-'];

function collectClientHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const name = key.toLowerCase();
    if (FORWARDED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      out[name] = value;
    }
  }
  return out;
}

function heartbeatIntervalMs(): number {
  const override = Number(process.env.MINIROUTE_HEARTBEAT_MS);
  return Number.isFinite(override) && override > 0 ? override : 15_000;
}

function terminalErrorFrame(format: WireFormat, message: string): string {
  if (format === 'anthropic') return anthropicStreamError(message);
  if (format === 'responses') {
    return sseFormat(
      JSON.stringify({
        type: 'response.failed',
        response: { status: 'failed', error: { code: 'upstream_error', message } },
      }),
      'response.failed',
    );
  }
  return (
    sseFormat(JSON.stringify({ error: { message, type: 'api_error', code: null } })) +
    sseFormat('[DONE]')
  );
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Every /v1 route passes through auth — no exceptions (the OmniRoute RCE
  // came from a route missing from its auth table). Accept both credential
  // headers because Claude Code and the Anthropic SDKs use x-api-key.
  app.use('/v1/*', async (c, next) => {
    const ok =
      !opts.authEnabled ||
      checkAuth(
        {
          authorization: c.req.header('authorization'),
          xApiKey: c.req.header('x-api-key'),
        },
        opts.apiKey,
      );
    if (!ok) {
      return c.json({ error: { message: 'invalid or missing API key', type: 'authentication_error' } }, 401);
    }
    await next();
  });

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.get('/v1/models', (c) => {
    const models = opts.state.chain.listModels();
    return c.json({
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', owned_by: 'miniroute' })),
    });
  });

  app.get('/v1/usage/summary', (c) => {
    return c.json(opts.state.usage.summary());
  });

  const respondError = (c: any, info: ErrorInfo): Response => {
    // Error style follows the route the client called.
    const path = c.req.path as string;
    const anthropic = path.startsWith('/v1/messages');
    const headers = info.upstream?.upstreamHeaders ?? {};

    // If the upstream already produced an error body in this client's wire
    // format, pass it through untouched: Claude Code inspects error.type to
    // decide whether to retry, compact, or ask for a smaller request.
    const raw = info.upstream?.rawBody;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Record<string, any>;
        const matchesFormat = anthropic
          ? parsed?.type === 'error' &&
            typeof parsed.error === 'object' &&
            parsed.error !== null
          : parsed?.error !== null &&
            typeof parsed?.error === 'object' &&
            typeof parsed.error.message === 'string' &&
            parsed.type === undefined;
        if (matchesFormat) {
          return c.json(parsed, info.status as any, headers);
        }
      } catch {
        // not JSON: fall through to a wrapped error
      }
    }

    const body = anthropic ? anthropicError(info.status, info.message) : openaiError(info.status, info.message);
    return c.json(body, info.status as any, headers);
  };

  const streamResponse = (
    c: any,
    events: AsyncIterable<IRStreamEvent>,
    model: string,
    format: WireFormat,
  ): Response => {
    const source =
      format === 'anthropic'
        ? irEventsToAnthropicSSE(events, model)
        : format === 'responses'
          ? irEventsToResponsesSSE(events, model)
          : irEventsToOpenAISSE(events, model, true);
    const ping = format === 'anthropic' ? 'event: ping\ndata: {"type":"ping"}\n\n' : ': keep-alive\n\n';
    return streamText(c, async (s) => {
      try {
        for await (const chunk of heartbeat(source, ping, heartbeatIntervalMs())) {
          await s.write(chunk);
        }
      } catch (err) {
        // The connection is still open and the client has already seen a 200,
        // so the only way to report truncation is a terminal error event.
        await s.write(terminalErrorFrame(format, err instanceof Error ? err.message : String(err)));
      }
    });
  };

  const handle = (
    routeName: string,
    parseToIR: (body: Record<string, unknown>) => IRRequest,
    respondNonStreaming: (c: any, result: any, model: string) => Response,
    format: WireFormat,
    logUsage: boolean,
  ) =>
    async (c: any): Promise<Response> => {
      const started = Date.now();
      let ir: IRRequest;
      try {
        const body = await c.req.json();
        ir = parseToIR(body);
      } catch (err) {
        const { status, message } = errorStatus(err);
        return respondError(c, { status, message: `invalid request: ${message}` });
      }
      ir.clientHeaders = collectClientHeaders(c.req.raw.headers);

      try {
        const warnings: string[] = [];
        const candidates = opts.state.chain.resolve(ir.model, warnings);
        for (const warning of warnings) {
          console.warn(`[miniroute] route "${ir.model}": ${warning}`);
        }
        const result = await executeWithFailover(
          ir,
          candidates,
          opts.state.registry,
          opts.state.breakers,
        );

        if (ir.stream) {
          // Record usage from stream events without blocking serialization.
          const usage: IRUsage = emptyUsage();
          let failure: string | undefined;
          const tap = async function* (src: AsyncIterable<IRStreamEvent>) {
            try {
              for await (const ev of src) {
                if (ev.type === 'usage' && ev.usage) {
                  usage.inputTokens = (usage.inputTokens ?? 0) + (ev.usage.inputTokens ?? 0);
                  usage.outputTokens = (usage.outputTokens ?? 0) + (ev.usage.outputTokens ?? 0);
                  usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (ev.usage.cacheReadTokens ?? 0);
                  usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0);
                }
                if (ev.type === 'error') failure = ev.message;
                yield ev;
              }
            } catch (err) {
              failure = err instanceof Error ? err.message : String(err);
              throw err;
            } finally {
              if (logUsage) {
                opts.state.usage.insert({
                  ts: Date.now(),
                  route: routeName,
                  provider: result.provider,
                  model: result.model,
                  stream: true,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                  cacheReadTokens: usage.cacheReadTokens ?? 0,
                  cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                  ok: !failure,
                  ...(failure ? { error: failure.slice(0, 500) } : {}),
                  durationMs: Date.now() - started,
                });
              }
            }
          };
          return streamResponse(c, tap(result.events!), result.model, format);
        }

        const resp = result.response!;
        if (logUsage) {
          opts.state.usage.insert({
            ts: Date.now(),
            route: routeName,
            provider: result.provider,
            model: result.model,
            stream: false,
            inputTokens: resp.usage.inputTokens ?? 0,
            outputTokens: resp.usage.outputTokens ?? 0,
            cacheReadTokens: resp.usage.cacheReadTokens ?? 0,
            cacheWriteTokens: resp.usage.cacheWriteTokens ?? 0,
            ok: true,
            durationMs: Date.now() - started,
          });
        }
        return respondNonStreaming(c, result, result.model);
      } catch (err) {
        const info = errorStatus(err);
        opts.state.usage.insert({
          ts: Date.now(),
          route: routeName,
          provider: '-',
          model: ir.model,
          stream: ir.stream,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          ok: false,
          error: info.message.slice(0, 500),
          durationMs: Date.now() - started,
        });
        return respondError(c, info);
      }
    };

  /* ---- OpenAI chat completions ---- */
  app.post(
    '/v1/chat/completions',
    handle(
      'chat',
      (b) => openaiChatRequestToIR(b as OpenAIChatRequest),
      (c, result, model) => c.json(irToOpenAIChatResponse(result.response!, model)),
      'openai',
      true,
    ),
  );

  /* ---- Anthropic messages ---- */
  app.post(
    '/v1/messages',
    handle(
      'messages',
      (b) => anthropicRequestToIR(b),
      (c, result, model) => c.json(irToAnthropicResponse({ ...result.response!, model })),
      'anthropic',
      true,
    ),
  );

  /* ---- OpenAI responses ---- */
  app.post(
    '/v1/responses',
    handle(
      'responses',
      (b) => responsesRequestToIR(b),
      (c, result, model) => c.json(irToResponsesResponse({ ...result.response!, model })),
      'responses',
      true,
    ),
  );

  return app;
}

export interface RunOptions {
  configPath: string;
  dataDir: string;
  portOverride?: number;
  hostOverride?: string;
  apiKey: string;
}

export async function runServer(runOpts: RunOptions): Promise<{ close: () => void; port: number }> {
  const loaded = loadConfig(runOpts.configPath);
  const config = loaded.config;
  const port = runOpts.portOverride ?? config.port ?? 4569;
  const host = runOpts.hostOverride ?? config.host ?? '127.0.0.1';
  const authEnabled = config.auth !== false;

  const usage = new UsageStore(runOpts.dataDir);
  let state: State = {
    config,
    registry: buildRegistry(config, { dataDir: runOpts.dataDir }),
    breakers: new Breakers(),
    chain: new ChainResolver(config),
    usage,
  };

  let rebuild = () => {
    try {
      const next = loadConfig(runOpts.configPath);
      state = {
        config: next.config,
        registry: buildRegistry(next.config, { dataDir: runOpts.dataDir }),
        breakers: new Breakers(),
        chain: new ChainResolver(next.config),
        usage,
      };
      console.log(`[miniroute] config reloaded (${next.warnings.length} warning(s))`);
      for (const w of next.warnings) console.warn(`[miniroute] warning: ${w}`);
    } catch (err) {
      console.error(`[miniroute] config reload failed, keeping previous config: ${err instanceof Error ? err.message : err}`);
    }
  };
  const stopWatching = watchConfig(runOpts.configPath, () => rebuild());

  const app = createApp({
    configPath: runOpts.configPath,
    apiKey: runOpts.apiKey,
    authEnabled,
    get state() {
      return state;
    },
    rebuild,
  });
  const server = serve({ fetch: app.fetch, port, hostname: host });
  console.log(`[miniroute] listening on http://${host}:${port}`);
  console.log(`[miniroute] config: ${runOpts.configPath}`);
  for (const w of loaded.warnings) console.warn(`[miniroute] warning: ${w}`);

  return {
    port,
    close: () => {
      stopWatching();
      server.close();
      usage.close();
    },
  };
}
