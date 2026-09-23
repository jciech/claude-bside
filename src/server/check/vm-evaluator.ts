// Evaluates transpiled part code inside a vm context that has no ambient globals and cannot generate
// code from strings. vm is not a security boundary (host objects leak their prototypes): the AST
// allowlist is. This removes everything reachable by name and adds a synchronous time limit.
import vm from 'node:vm';
import type { Evaluator } from '../../strudel/compile.ts';

export function createVmEvaluator(timeoutMs = 250): Evaluator {
  const context = vm.createContext(Object.create(null) as object, {
    name: 'strudel-part',
    codeGeneration: { strings: false, wasm: false },
  }) as Record<string, unknown>;
  return (source, names, values) => {
    context.__scope = values;
    try {
      return vm.runInContext(`(function (${names.join(', ')}) {"use strict";\n${source}\n}).apply(undefined, __scope)`, context, {
        timeout: timeoutMs,
        filename: 'part.js',
      });
    } finally {
      delete context.__scope;
    }
  };
}
