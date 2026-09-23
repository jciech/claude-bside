// Preloaded with `node --import` before anything touches @strudel/*.
// @kabelsalat/web 0.4.x declares "type":"module" but its "main" (dist/index.js) is an IIFE with
// no ESM exports. Node ignores the "module" field, so @strudel/core 1.2.6 (repl.mjs:15) fails to
// link. Redirect to the real ESM build. Hooks registered here also apply in worker threads
// because workers inherit process.execArgv (and therefore this --import).
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (specifier === '@kabelsalat/web' && resolved.url.endsWith('/dist/index.js')) {
      return { ...resolved, url: resolved.url.replace(/\/dist\/index\.js$/, '/dist/index.mjs'), format: 'module' };
    }
    return resolved;
  },
});
