import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// The client lives in src/client; it imports contracts from src/shared and the Strudel toolkit from
// src/strudel. In development the Node server mounts Vite as middleware (one process, one port).
export default defineConfig({
  root: 'src/client',
  publicDir: 'public',
  plugins: [svelte()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: {
    fs: { allow: [root] },
  },
});
