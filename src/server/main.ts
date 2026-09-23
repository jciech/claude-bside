// B-Side server: one process serves the API, the listener socket and the client (Vite middleware in
// development, the built bundle in production). Wiring order: docs/IMPLEMENTATION.md.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import { join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import express, { type Express } from 'express';
import type { ViteDevServer } from 'vite';
import { DEFAULT_BPM, bpmToCps } from '../shared/music.ts';
import { createTimeline } from '../shared/timeline.ts';
import { parseCatalog } from '../strudel/catalog.ts';
import { createChecker } from './check/checker.ts';
import { createClaudeComposer } from './composer/claude.ts';
import { createExternalComposer } from './composer/external.ts';
import { composerSystemPrompt } from './composer/reference.ts';
import { createScriptedComposer } from './composer/scripted.ts';
import { createConductor } from './conductor/conductor.ts';
import { createStore } from './conductor/store.ts';
import { REPO_ROOT, listenHost, loadConfig } from './config.ts';
import { createHttpApp, isInside } from './http/app.ts';
import { createLogger } from './log.ts';
import { createRoomClock, serverNow } from './room/clock.ts';
import { createCrowd } from './room/crowd.ts';
import { attachRoom, createBroadcaster, createRoomServer } from './room/socket.ts';
import type { ServerConfig } from './types.ts';

const CLIENT_ROOT = join(REPO_ROOT, 'src', 'client');
const DIST_CLIENT = join(REPO_ROOT, 'dist', 'client');
const SHUTDOWN_GRACE_MS = 10_000;

loadDotenv({ quiet: true });
const log = createLogger('main');

async function serveClient(app: Express, config: ServerConfig, httpServer: ReturnType<typeof createServer>): Promise<ViteDevServer | null> {
  if (!config.dev) {
    app.use(
      express.static(DIST_CLIENT, {
        index: false,
        setHeaders: (res, file) => {
          res.setHeader('Cache-Control', file.includes(join('client', 'assets')) ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
        },
      }),
    );
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.accepts('html')) return next();
      res.sendFile(join(DIST_CLIENT, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
    });
    return null;
  }
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    configFile: join(REPO_ROOT, 'vite.config.ts'),
    root: CLIENT_ROOT,
    appType: 'spa',
    server: {
      middlewareMode: true,
      hmr: { server: httpServer },
      // vite.config.ts lets the dev server read the whole repository; never the data dir.
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', `${config.dataDir.replaceAll('\\', '/')}/**`] },
    },
  });
  app.use(vite.middlewares);
  return vite;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, process.argv.slice(2));
  if (process.env.BSIDE_COMPOSER?.trim() === 'claude' && config.driver !== 'claude') {
    log.warn('BSIDE_COMPOSER=claude but ANTHROPIC_API_KEY is not set; starting on the scripted autopilot');
  }
  const paletteDir = join(config.catalogPath, '..');
  const exposed = [paletteDir, config.dev ? CLIENT_ROOT : DIST_CLIENT].find((root) => isInside(config.dataDir, root));
  if (exposed) throw new Error(`BSIDE_DATA_DIR (${config.dataDir}) must be outside every served directory (${exposed})`);
  if (!config.dev && !existsSync(join(DIST_CLIENT, 'index.html'))) throw new Error(`no client build in ${DIST_CLIENT}; run \`npm run build\` first`);

  const store = createStore(config.dataDir, createLogger('store'));
  const catalog = parseCatalog(JSON.parse(readFileSync(config.catalogPath, 'utf8')));
  const checker = createChecker({ catalog });
  const composers = {
    claude: process.env.ANTHROPIC_API_KEY?.trim() ? createClaudeComposer({ config, catalog, log: createLogger('claude') }) : undefined,
    external: createExternalComposer({ log: createLogger('external') }),
    scripted: await createScriptedComposer({ catalog, checker, log: createLogger('scripted') }),
  };
  const clock = createRoomClock({ timeline: createTimeline(serverNow(), bpmToCps(DEFAULT_BPM)), log: createLogger('clock') });

  // socket.io wraps the server's request listener when it attaches, so requests go through a
  // trampoline that exists before the app does.
  let handler: RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const httpServer = createServer((req, res) => handler(req, res));
  const io = createRoomServer(httpServer, config);
  const broadcaster = createBroadcaster(io);
  const crowd = createCrowd({ broadcaster, config, store, log: createLogger('crowd') });
  const conductor = createConductor({ clock, crowd, checker, store, log: createLogger('conductor'), config, catalog, composers, broadcaster });
  await conductor.start();
  clock.start();
  crowd.start({ cycle: () => clock.cycle(), needle: () => conductor.needle() });
  attachRoom(io, { crowd, conductor, clock, config, log: createLogger('socket') });

  const app = createHttpApp({ conductor, crowd, clock, config, log: createLogger('http'), reference: () => composerSystemPrompt(catalog), paletteDir });
  const vite = await serveClient(app, config, httpServer);
  handler = app;

  const host = listenHost(process.env, config);
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, host, resolve);
  });
  log.info('B-Side is listening', { url: `http://${host ?? 'localhost'}:${config.port}`, dev: config.dev, driver: config.driver, dataDir: config.dataDir });

  let closing = false;
  const shutdown = async (reason: string, code: number) => {
    if (closing) {
      if (reason === 'SIGINT') process.exit(130);
      return;
    }
    closing = true;
    log.info('shutting down', { reason });
    setTimeout(() => process.exit(code || 1), SHUTDOWN_GRACE_MS).unref();
    const step = async (name: string, fn: () => unknown) => {
      try {
        await fn();
      } catch (err) {
        log.error(`shutdown: ${name} failed`, { err });
      }
    };
    await step('crowd', () => crowd.stop());
    await step('conductor', () => conductor.stop());
    await step('clock', () => clock.stop());
    await step('identities', () => crowd.persist());
    await step('store', () => store.flush());
    await step('checker', () => checker.close());
    await step('vite', () => vite?.close());
    await step('server', () => {
      const closed = new Promise<void>((resolve) => io.close(() => resolve()));
      httpServer.closeAllConnections();
      return closed;
    });
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
    void shutdown('uncaught exception', 1);
  });
}

main().catch((err: unknown) => {
  log.error('B-Side failed to start', { err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  process.exit(1);
});
