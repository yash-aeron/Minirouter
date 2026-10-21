import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    server: {
      deps: {
        // vite's builtin list predates node:sqlite
        external: [/^node:/],
      },
    },
  },
});
