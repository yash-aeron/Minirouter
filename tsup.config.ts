import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  // tsup strips the "node:" prefix by default; node:sqlite must stay prefixed
  // because there is no bare "sqlite" package.
  removeNodeProtocol: false,
  outDir: 'dist',
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
