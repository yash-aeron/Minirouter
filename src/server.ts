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
import { IRRequest, IRUsage } from './core/ir.js';
import {
  irEventsToAnthropicSSE,
  irToAnthropicResponse,
  anthropicRequestToIR,
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
import { sseStream } from './core/sse.js';
import { UsageStore } from './usage/store.js';

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

function errorStatus(err: unknown): { status: number; message: string } {
  if (err instanceof NoCandidateError) {
    return { status: 502, message: err.message };
  }
  if (err instanceof ProviderError) {
    return { status: err.status >= 400 ? err.status : 502, message: err.message };
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

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Every /v1 route passes through auth — no exceptions (the OmniRoute RCE
  // came from a route missing from its auth table).
  app.use('/v1/*', async (c, next) => {
    if (opts.authEnabled && !checkAuth(c.req.header('authorization'), opts.apiKey)) {
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

  const handle = (
    routeName: string,
    parseToIR: (body: Record<string, unknown>) => IRRequest,
    respondNonStreaming: (c: any, result: any, model: string) => Response,
    respondStreaming: (c: any, events: AsyncIterable<any>, model: string) => Response,
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
        return respondError(c, status, `invalid request: ${message}`);
      }

      try {
        const candidates = opts.state.chain.resolve(ir.model);
        const result = await executeWithFailover(
          ir,
          candidates,
          opts.state.registry,
          opts.state.breakers,
        );

        if (ir.stream) {
          // Record usage from stream events without blocking serialization.
          const usage: IRUsage = emptyUsage();
          const tap = async function* (src: AsyncIterable<any>) {
            for await (const ev of src) {
              if (ev.type === 'usage' && ev.usage) {
                usage.inputTokens += ev.usage.inputTokens ?? 0;
                usage.outputTokens += ev.usage.outputTokens ?? 0;
                usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + (ev.usage.cacheReadTokens ?? 0);
                usage.cacheWriteTokens = (usage.cacheWriteTokens ?? 0) + (ev.usage.cacheWriteTokens ?? 0);
              }
              yield ev;
            }
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
                ok: true,
                durationMs: Date.now() - started,
              });
            }
          };
          return respondStreaming(c, tap(result.events!), result.model);
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
        const { status, message } = errorStatus(err);
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
          error: message.slice(0, 500),
          durationMs: Date.now() - started,
        });
        return respondError(c, status, message);
      }
    };

  const respondError = (c: any, status: number, message: string): Response => {
    // Error style follows the route the client called.
    const path = c.req.path as string;
    if (path.startsWith('/v1/messages')) {
      return c.json(anthropicError(status, message), status as any);
    }
    if (path.startsWith('/v1/responses')) {
      return c.json(openaiError(status, message), status as any);
    }
    return c.json(openaiError(status, message), status as any);
  };

  /* ---- OpenAI chat completions ---- */
  app.post(
    '/v1/chat/completions',
    handle(
      'chat',
      (b) => openaiChatRequestToIR(b as OpenAIChatRequest),
      (c, result, model) => c.json(irToOpenAIChatResponse(result.response!, model)),
      (c, events, model) =>
        streamText(c, async (s) => {
          for await (const chunk of irEventsToOpenAISSE(events, model, true)) await s.write(chunk);
        }),
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
      (c, events, model) =>
        streamText(c, async (s) => {
          for await (const chunk of irEventsToAnthropicSSE(events, model)) await s.write(chunk);
        }),
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
      (c, events, model) =>
        streamText(c, async (s) => {
          for await (const chunk of irEventsToResponsesSSE(events, model)) await s.write(chunk);
        }),
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
    registry: buildRegistry(config),
    breakers: new Breakers(),
    chain: new ChainResolver(config),
    usage,
  };

  let rebuild = () => {
    try {
      const next = loadConfig(runOpts.configPath);
      state = {
        config: next.config,
        registry: buildRegistry(next.config),
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
