// Dev server for the Lathe harness (test/lathe/browser/run.ts). Serves the fixtures and the
// vendored sample maps next to the page so the real engine can boot (engine=real mode).
import { defineConfig, type Plugin } from 'vite';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

function repoFiles(): Plugin {
  const roots: Record<string, string> = { '/fixtures/': join(repo, 'test/fixtures'), '/palette/': join(repo, 'palette') };
  return {
    name: 'lathe-harness-files',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!;
        const prefix = Object.keys(roots).find((p) => url.startsWith(p));
        if (!prefix) return next();
        const root = roots[prefix]!;
        const file = normalize(join(root, url.slice(prefix.length)));
        if (!file.startsWith(root)) return next();
        try {
          const body = await readFile(file);
          res.setHeader('content-type', extname(file) === '.json' ? 'application/json' : 'application/octet-stream');
          res.end(body);
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [repoFiles()],
  server: { fs: { allow: [repo] }, port: 5198, strictPort: true },
  worker: { format: 'es' },
  logLevel: 'warn',
});
