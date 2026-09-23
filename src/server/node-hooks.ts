// @kabelsalat/web 0.4.x declares "type":"module" but its "main" (dist/index.js) is an IIFE with
// no ESM exports. Node ignores the "module" field, so @strudel/core 1.2.6 (repl.mjs:15) fails to
// link. Redirect to the real ESM build.
//
// Preloaded with `node --import` for the server process. Worker threads must call
// registerStrudelHooks() themselves before a dynamic import of Strudel: workers spawned under
// vitest don't inherit the preload, and explicit Worker execArgv would drop it.
import { registerHooks } from 'node:module';

let registered = false;

export function registerStrudelHooks(): void {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (specifier === '@kabelsalat/web' && resolved.url.endsWith('/dist/index.js')) {
        return { ...resolved, url: resolved.url.replace(/\/dist\/index\.js$/, '/dist/index.mjs'), format: 'module' };
      }
      return resolved;
    },
  });
}

registerStrudelHooks();
