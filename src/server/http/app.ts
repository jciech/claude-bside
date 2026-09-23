// The Express app minus the client: security headers, the sound palette and the API. main.ts adds
// the client (Vite middleware in development, the built bundle in production) behind it.
import { join, relative, isAbsolute, resolve } from 'node:path';
import express, { Router, type Express } from 'express';
import { createApiRouter, type ApiDeps } from './api.ts';
import { securityHeaders } from './security.ts';

export interface HttpAppDeps extends ApiDeps {
  /** Directory holding catalog.json and maps/ (served at /palette). */
  paletteDir: string;
}

/**
 * The catalog changes on every rebuild, so it is revalidated often. Maps change only with a rebuild;
 * fetched with the catalog version as `?v=` they are immutable, otherwise cached for an hour.
 */
function paletteRouter(dir: string): Router {
  const router = Router();
  router.get('/catalog.json', (_req, res, next) => {
    res.sendFile(join(dir, 'catalog.json'), { headers: { 'Cache-Control': 'public, max-age=60, must-revalidate' } }, (err) => err && next());
  });
  router.use(
    '/maps',
    express.static(join(dir, 'maps'), {
      index: false,
      redirect: false,
      dotfiles: 'deny',
      setHeaders: (res) => {
        const versioned = typeof res.req.query.v === 'string';
        res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600');
      },
    }),
  );
  router.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  return router;
}

export function createHttpApp(deps: HttpAppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', deps.config.trustProxy);
  app.use(securityHeaders(deps.config));
  app.use('/palette', paletteRouter(deps.paletteDir));
  app.use('/api', createApiRouter(deps));
  return app;
}

/** True when `path` is `root` or lies inside it. */
export function isInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
