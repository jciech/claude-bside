import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { parse, type Node } from 'acorn';
import { walk } from 'estree-walker';
import { describe, expect, it } from 'vitest';
import { ENGINE_OWNED_KEYS } from '../../src/shared/limits.ts';
import { ALLOWLIST } from '../../src/strudel/allowlist.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const allowed = (name: string) => ALLOWLIST.globals.has(name) || ALLOWLIST.methods.has(name) || ALLOWLIST.controls.has(name);

describe('denylist', () => {
  it('denies every engine-owned hap key everywhere (ENGINE_OWNED_KEYS ⊆ denied)', () => {
    for (const key of ENGINE_OWNED_KEYS) {
      expect(ALLOWLIST.denied.has(key), key).toBe(true);
      expect(allowed(key), key).toBe(false);
    }
  });

  it('never lets an allowed control write an engine-owned or denied key (aliases included)', () => {
    const probe = core.pure({}) as unknown as Record<string, (v: unknown) => { firstCycleValues: Record<string, unknown>[] }>;
    for (const name of ALLOWLIST.controls) {
      for (const arg of [0.5, [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]]) {
        let value: Record<string, unknown> | undefined;
        try {
          value = probe[name]!(core.pure(arg)).firstCycleValues[0];
        } catch {
          continue;
        }
        for (const key of Object.keys(value ?? {})) {
          expect(ENGINE_OWNED_KEYS.has(key), `${name} writes ${key}`).toBe(false);
          expect(ALLOWLIST.denied.has(key), `${name} writes ${key}`).toBe(false);
        }
      }
    }
  });

  it('includes everything ARCHITECTURE §11.1 and the design review name, each with a reason', () => {
    const required = [
      'worklet', 'bbexpr', 'byteBeatExpression', 'K', 'compileKabel', 'as', 'hydra', 'initHydra', 'H', 'samples', 'aliasBank',
      'setSoundfontUrl', 'loadSoundfont', 'setcps', 'setcpm', 'cps', 'cpm', 'hush', 'all', 'each', 'repl', 'useRNG',
      'withValue', 'fmap', 'withHap', 'withHaps', 'filter', 'filterHaps', 'filterValues', 'bind', 'innerBind', 'outerBind',
      'squeezeBind', 'onTrigger', 'onTriggerTime', 'draw', 'onPaint', 'log', 'logValues', 'applyN', 'source', 'src', 'FX', 'fxr',
      'FXr', 'FXrel', 'FXrelease', 'ch', 'channels', 'nudge', 'lfo', 'env', 'bmod', 'orbit', 'o', 'duck', 'duckorbit', 'duckdepth',
      'duckattack', 'duckonset', 'color', 'markcss', 'analyze', 'fft', 'scope', 'tscope', 'fscope', 'spectrum', 'pianoroll',
      'midi', 'osc', 'backgroundImage', 'cleanupUi', 'speak', 'whenKey', 'keyDown', 'timeline', 'reset_timelines',
      'calculateSteps', 'registerVoicings', 'addVoicings', 'setDefaultVoicings', 'voicingAlias', 'resetVoicings', 'reset_state',
      'setCpsFunc', 'setPattern', 'setTriggerFunc', 'setIsStarted', 'evaluate', 'evalScope', 'register', 'createParam',
      'registerControl', 'setStringParser', 'miniAllStrings', 'compose', 'curry', 'constructor', '__proto__', 'prototype',
      'call', 'apply', 'bind', 'm',
    ];
    for (const name of required) {
      expect(ALLOWLIST.denied.get(name)?.length ?? 0, name).toBeGreaterThan(20);
      expect(allowed(name), name).toBe(false);
    }
  });

  it('keeps pickF (pattern-level functions) and the everyday API', () => {
    for (const name of ['pickF', 's', 'n', 'note', 'stack', 'seq', 'cat', 'every', 'sometimes', 'off', 'jux', 'superimpose', 'scale', 'voicing', 'lpf', 'room', 'delay', 'bank', 'euclid', 'struct', 'mask', 'seed', 'knob']) {
      expect(allowed(name), name).toBe(true);
    }
  });
});

describe('allowed names', () => {
  it('all exist in the runtime they are used with', () => {
    const scope: Record<string, unknown> = { ...core, ...mini, ...tonal };
    for (const name of ALLOWLIST.globals) if (name !== 'knob') expect(scope[name], name).toBeDefined();
    const proto = core.Pattern.prototype as Record<string, unknown>;
    for (const name of ALLOWLIST.methods) expect(name in proto, name).toBe(true);
  });

  it('do not reach the DOM, the network or the listener\'s devices (runtime sources)', () => {
    const scope: Record<string, unknown> = { ...core, ...mini, ...tonal };
    const proto = core.Pattern.prototype as Record<string, unknown>;
    const browser = /\b(document|window|fetch|XMLHttpRequest|navigator|localStorage|sessionStorage|WebSocket|speechSynthesis|importScripts)\b/;
    for (const name of ALLOWLIST.globals) {
      const v = scope[name];
      if (typeof v === 'function') expect(browser.test(v.toString()), name).toBe(false);
    }
    for (const name of ALLOWLIST.methods) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      const fn = d?.value ?? d?.get;
      if (typeof fn === 'function') expect(browser.test(fn.toString()), name).toBe(false);
    }
  });

  it('do not reach the DOM, the network or the listener\'s devices (transitively, in the Strudel sources)', () => {
    const tainted = taintedStrudelNames();
    expect(tainted.has('backgroundImage')).toBe(true); // the scan does see real sinks
    expect(tainted.has('whenKey')).toBe(true);
    expect(tainted.has('onTriggerTime')).toBe(true);
    const leaks = [...tainted].filter(allowed);
    expect(leaks).toEqual([]);
  });
});

describe('generated file', () => {
  it('is what scripts/gen-allowlist.ts produces from the installed Strudel', () => {
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', './src/server/node-hooks.ts', 'scripts/gen-allowlist.ts', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(out).toMatch(/up to date/);
  });
});

// ─── Taint scan ──────────────────────────────────────────────────────────────────────────────────
// Parses @strudel/core, mini and tonal sources; a top-level declaration (exported const/function,
// class method, Pattern.prototype.x assignment, register('x', …) callback) is tainted when it
// references a browser API directly, or any tainted declaration by name. The logger only dispatches
// a CustomEvent carrying its message, so calling it does not taint.

const BROWSER = new Set(['document', 'window', 'fetch', 'XMLHttpRequest', 'navigator', 'localStorage', 'sessionStorage', 'WebSocket', 'speechSynthesis', 'SpeechSynthesisUtterance', 'importScripts', 'EventSource', 'indexedDB']);
const SINKS_THAT_DO_NOT_TAINT = new Set(['logger', 'errorLogger']);

interface Decl {
  names: string[];
  refs: Set<string>;
}

function refsOf(node: Node): Set<string> {
  const refs = new Set<string>();
  walk(node as never, {
    enter(n: any, parent: any) {
      if (n.type === 'Identifier') {
        const isKey = parent?.type === 'Property' && parent.key === n && !parent.computed;
        const isMemberProp = parent?.type === 'MemberExpression' && parent.property === n && !parent.computed;
        if (!isKey || isMemberProp) refs.add(n.name);
      }
    },
  });
  return refs;
}

function registeredNames(node: Node): string[] {
  const names: string[] = [];
  walk(node as never, {
    enter(n: any) {
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && /^(register|stepRegister)$/.test(n.callee.name)) {
        const first = n.arguments[0];
        if (first?.type === 'Literal') names.push(first.value);
        if (first?.type === 'ArrayExpression') for (const el of first.elements) if (el?.type === 'Literal') names.push(el.value);
      }
    },
  });
  return names;
}

function declarationsOf(file: string): Decl[] {
  const program = parse(readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
  const decls: Decl[] = [];
  const bindings = (p: any): string[] =>
    p.type === 'Identifier' ? [p.name] : p.type === 'ObjectPattern' ? p.properties.flatMap((x: any) => bindings(x.value ?? x.argument)) : p.type === 'ArrayPattern' ? p.elements.filter(Boolean).flatMap(bindings) : [];
  for (let stmt of program.body as any[]) {
    if ((stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') && stmt.declaration) stmt = stmt.declaration;
    if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) decls.push({ names: [...bindings(d.id), ...registeredNames(d)], refs: refsOf(d.init ?? d) });
    } else if (stmt.type === 'FunctionDeclaration') {
      decls.push({ names: [stmt.id.name], refs: refsOf(stmt) });
    } else if (stmt.type === 'ClassDeclaration') {
      for (const m of stmt.body.body) if (m.key?.type === 'Identifier') decls.push({ names: [m.key.name], refs: refsOf(m) });
    } else if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'AssignmentExpression' && stmt.expression.left.type === 'MemberExpression') {
      const left = stmt.expression.left;
      decls.push({ names: left.property?.name ? [left.property.name] : [], refs: refsOf(stmt.expression.right) });
    } else {
      // Top-level side effects (e.g. `if (typeof window…) document.addEventListener(…)`) taint what they assign.
      const refs = refsOf(stmt);
      const assigned: string[] = [];
      walk(stmt as never, {
        enter(n: any) {
          if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier') assigned.push(n.left.name);
        },
      });
      decls.push({ names: [...assigned, ...registeredNames(stmt)], refs });
    }
  }
  return decls;
}

function taintedStrudelNames(): Set<string> {
  const files = ['core', 'mini', 'tonal'].flatMap((pkg) => {
    const dir = `${root}/node_modules/@strudel/${pkg}`;
    return readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'vite.config.mjs').map((f) => `${dir}/${f}`);
  });
  const decls = files.flatMap(declarationsOf);
  const tainted = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of decls) {
      if (d.names.every((n) => tainted.has(n))) continue;
      const hit = [...d.refs].some((r) => BROWSER.has(r) || (tainted.has(r) && !SINKS_THAT_DO_NOT_TAINT.has(r)));
      if (hit) {
        for (const n of d.names) if (!SINKS_THAT_DO_NOT_TAINT.has(n) && !tainted.has(n)) {
          tainted.add(n);
          changed = true;
        }
      }
    }
  }
  return tainted;
}
