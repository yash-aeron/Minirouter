import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultConfigPath, defaultDataDir, loadConfig } from './config.js';
import { ensureApiKey } from './auth.js';
import { runServer } from './server.js';

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
      const routeCount = Object.keys(config.routes ?? {}).length;
      console.log(`routes: ${routeCount}`);
      for (const w of warnings) console.warn(`warning: ${w}`);
      if (warnings.length === 0) console.log('no warnings');
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

program.parse();
