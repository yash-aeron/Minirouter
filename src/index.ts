import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline/promises';
import { defaultConfigPath, defaultDataDir, loadConfig } from './config.js';
import { ensureApiKey } from './auth.js';
import { runServer } from './server.js';
import { ChainResolver } from './router/chain.js';
import { claudeRefresher, loginClaude } from './oauth/claude-code.js';
import { codexRefresher, loginCodex } from './oauth/codex.js';
import { geminiRefresher, loginGemini } from './oauth/gemini-cli.js';
import { refreshAccount } from './oauth/refresh.js';
import { TokenStore } from './oauth/token-store.js';
import {
  isOAuthProvider,
  OAUTH_PROVIDERS,
  OAuthProvider,
  RefreshFn,
  summarizeAccount,
} from './oauth/types.js';

const EXAMPLE_CONFIG = {
  port: 4569,
  providers: [
    {
      name: 'glm',
      type: 'openai-compat',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'env:GLM_API_KEY',
      models: ['glm-4.7'],
    },
    {
      name: 'deepseek',
      type: 'openai-compat',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'env:DEEPSEEK_API_KEY',
      models: ['deepseek-chat'],
    },
  ],
  routes: {
    'claude-sonnet-4-6': ['glm/glm-4.7', 'deepseek/deepseek-chat'],
  },
};

const program = new Command();

program.name('miniroute').description('Local AI gateway: one endpoint, many providers, automatic fallback');

program
  .command('run')
  .description('start the gateway server')
  .option('-c, --config <path>', 'config file', defaultConfigPath())
  .option('-p, --port <port>', 'port override', Number)
  .action(async (opts) => {
    const dataDir = defaultDataDir();
    const apiKey = ensureApiKey(dataDir);
    const { close } = await runServer({
      configPath: opts.config,
      dataDir,
      portOverride: Number.isFinite(opts.port) ? opts.port : undefined,
      apiKey,
    });
    const shutdown = () => {
      close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('key')
  .description('print (creating if needed) the local API key')
  .action(() => {
    const key = ensureApiKey(defaultDataDir());
    console.log(key);
  });

program
  .command('doctor')
  .description('validate the config and report problems')
  .option('-c, --config <path>', 'config file', defaultConfigPath())
  .action((opts) => {
    try {
      const { config, warnings } = loadConfig(opts.config);
      console.log(`config OK: ${opts.config}`);
      console.log(`providers: ${config.providers.map((p) => `${p.name}(${p.type})`).join(', ')}`);
      const resolver = new ChainResolver(config);
      const routes = Object.entries(config.routes ?? {});
      console.log(`routes: ${routes.length}`);
      const problems: string[] = [];
      for (const [alias] of routes) {
        const routeWarnings: string[] = [];
        try {
          const candidates = resolver.resolve(alias, routeWarnings);
          console.log(`  ${alias} -> ${candidates.map((c) => `${c.provider}/${c.model}`).join(' | ')}`);
        } catch (err) {
          problems.push(`${alias}: ${err instanceof Error ? err.message : err}`);
        }
        for (const w of routeWarnings) problems.push(`${alias}: ${w}`);
      }
      for (const w of warnings) console.warn(`warning: ${w}`);
      for (const p of config.providers) {
        if (p.auth !== 'oauth') continue;
        const oauthProvider = oauthProviderForType(p.type);
        if (!oauthProvider) {
          problems.push(`${p.name}: auth "oauth" is not supported for type "${p.type}"`);
          continue;
        }
        try {
          const store = new TokenStore(path.join(defaultDataDir(), 'oauth.json'));
          for (const spec of p.accounts ?? []) {
            try {
              store.resolveOrThrow(oauthProvider, spec);
            } catch (err) {
              problems.push(`${p.name}: ${err instanceof Error ? err.message : err}`);
            }
          }
        } catch (err) {
          problems.push(`${p.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
      for (const p of problems) console.error(`problem: ${p}`);
      if (problems.length) {
        process.exitCode = 1;
      } else {
        console.log('no route problems');
      }
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

program
  .command('init')
  .description('write an example config to the data directory')
  .option('-f, --force', 'overwrite an existing config')
  .action((opts) => {
    const file = defaultConfigPath();
    if (fs.existsSync(file) && !opts.force) {
      console.error(`${file} already exists (use --force to overwrite)`);
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n');
    console.log(`wrote ${file}`);
    console.log('set GLM_API_KEY / DEEPSEEK_API_KEY in your environment, then run: miniroute run');
  });

function accountStore(): TokenStore {
  return new TokenStore(path.join(defaultDataDir(), 'oauth.json'));
}

function oauthProviderForType(type: string): OAuthProvider | null {
  if (type === 'anthropic') return 'claude';
  if (type === 'codex') return 'codex';
  if (type === 'gemini-cli') return 'gemini';
  return null;
}

function configTypeFor(provider: OAuthProvider): string {
  return provider === 'claude' ? 'anthropic' : provider === 'codex' ? 'codex' : 'gemini-cli';
}

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).finally(() => rl.close());
}

/** Open a URL with the platform opener. The URL is always one we built ourselves. */
function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? 'rundll32'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  // rundll32 avoids cmd.exe, which would split the authorize URL on '&'.
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      // the URL is printed anyway
    });
    child.unref();
  } catch {
    // the URL is printed anyway
  }
}

const auth = program
  .command('auth')
  .description('manage OAuth subscription accounts (Claude Code, Codex, Gemini CLI)');

auth
  .command('login <provider>')
  .description(`sign in to a subscription account (${OAUTH_PROVIDERS.join(' | ')})`)
  .option('-l, --label <label>', 'local label for this account', 'default')
  .option('--no-browser', 'print the authorization URL instead of opening a browser')
  .option('-p, --port <port>', 'callback port (Codex uses 1455 by default)', Number)
  .action(async (providerArg: string, opts) => {
    if (!isOAuthProvider(providerArg)) {
      console.error(`unknown provider "${providerArg}"; expected one of: ${OAUTH_PROVIDERS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    const store = accountStore();
    const port = Number.isFinite(opts.port) ? opts.port : undefined;
    const common = {
      openBrowser: opts.browser ? openBrowser : undefined,
      log: (line: string) => console.log(line),
    };
    try {
      const account =
        providerArg === 'claude'
          ? await loginClaude(store, opts.label, { ...common, prompt: promptLine })
          : providerArg === 'codex'
            ? await loginCodex(store, opts.label, { ...common, port })
            : await loginGemini(store, opts.label, { ...common, port });
      console.log(`signed in: ${account.id} (${account.label}); tokens stored in ${store.filePath}`);
      console.log(
        `config: { "type": "${configTypeFor(providerArg)}", "auth": "oauth", "accounts": ["${account.id}"] }`,
      );
    } catch (err) {
      console.error(`login failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

auth
  .command('list [provider]')
  .description('list stored accounts (id, label, expiry; never tokens)')
  .action((providerArg?: string) => {
    if (providerArg && !isOAuthProvider(providerArg)) {
      console.error(`unknown provider "${providerArg}"; expected one of: ${OAUTH_PROVIDERS.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    try {
      const store = accountStore();
      const rows = store
        .all()
        .filter((entry) => !providerArg || entry.provider === providerArg);
      if (rows.length === 0) {
        console.log('no OAuth accounts; run "miniroute auth login <provider>"');
        return;
      }
      console.log('PROVIDER\tID\tLABEL\tEXPIRES');
      for (const { provider, account } of rows) {
        const summary = summarizeAccount(provider, account);
        console.log(
          `${summary.provider}\t${summary.id}\t${summary.label}\t${summary.expiresAt}${summary.expired ? ' (expired)' : ''}`,
        );
      }
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

auth
  .command('remove <id>')
  .description('delete a stored account')
  .action((id: string) => {
    try {
      const provider = accountStore().removeAny(id);
      if (!provider) {
        console.error(`no account "${id}"`);
        process.exitCode = 1;
        return;
      }
      console.log(`removed ${id} (${provider})`);
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

auth
  .command('refresh [id]')
  .description('refresh one account, or all accounts')
  .action(async (id?: string) => {
    const refreshers: Record<OAuthProvider, RefreshFn> = {
      claude: claudeRefresher(),
      codex: codexRefresher(),
      gemini: geminiRefresher(),
    };
    try {
      const store = accountStore();
      const targets = id
        ? store
            .all()
            .filter(
              (entry) =>
                entry.account.id === id ||
                entry.account.label.toLowerCase() === id.toLowerCase(),
            )
        : store.all();
      if (targets.length === 0) {
        console.log(id ? `no account "${id}"` : 'no OAuth accounts');
        if (id) process.exitCode = 1;
        return;
      }
      for (const { provider, account } of targets) {
        try {
          const updated = await refreshAccount(store, provider, account, refreshers[provider], {
            force: true,
          });
          console.log(`refreshed ${provider}/${updated.id}; expires ${new Date(updated.expiresAt).toISOString()}`);
        } catch (err) {
          console.error(`${provider}/${account.id}: ${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
        }
      }
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });

program.parse();
