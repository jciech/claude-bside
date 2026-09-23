import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// @kabelsalat/web's "main" is an IIFE; point Vitest at its ESM build (Node itself uses the
// resolve hook in src/server/node-hooks.ts). Strudel is inlined so the alias applies to its imports.
export default defineConfig({
  resolve: {
    alias: {
      '@kabelsalat/web': fileURLToPath(new URL('./node_modules/@kabelsalat/web/dist/index.mjs', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    server: {
      deps: {
        inline: [/@strudel\//, /@kabelsalat\//, /superdough/],
      },
    },
  },
});
