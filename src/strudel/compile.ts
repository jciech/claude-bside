// Validated part code → Strudel Pattern, identically in the browser (new Function) and in the
// server's checker workers (a vm evaluator). The Strudel scope is passed as function PARAMETERS —
// exactly the allowlisted values plus the transpiler's `m` and the part's `knob` — so nothing is
// installed on globalThis (no evalScope) and nothing else is reachable by name.
// Callers must run validatePart() first; the post-transpile invariant here is a second line.
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import { transpiler } from '@strudel/transpiler';
import type { Issue } from '../shared/analysis.ts';
import { ALLOWLIST } from './allowlist.ts';
import './guard.ts'; // the query budget must be in place before part code builds any pattern
import { checkTranspiled } from './validate.ts';

export interface KnobBinder {
  (name: string): unknown /* a Pattern, e.g. signal(...) */;
}

export interface CompiledPart {
  pattern: any /* Strudel Pattern */;
  miniLocations: { start: number; end: number }[];
}

export type Evaluator = (source: string, names: string[], values: unknown[]) => unknown;

/** Thrown by compilePart with an issue phrased for the composer. */
export class CompileError extends Error {
  readonly issue: Issue;
  constructor(issue: Issue) {
    super(issue.message);
    this.name = 'CompileError';
    this.issue = issue;
  }
}

let scope: { names: string[]; values: unknown[]; set: Set<string> } | null = null;

function scopeTable() {
  if (scope) return scope;
  const all: Record<string, unknown> = { ...core, ...mini, ...tonal };
  const names: string[] = [];
  const values: unknown[] = [];
  for (const name of ALLOWLIST.globals) {
    if (name === 'knob' || all[name] === undefined) continue;
    names.push(name);
    values.push(all[name]);
  }
  for (const name of ALLOWLIST.scopeOnly) {
    names.push(name);
    values.push(all[name]);
  }
  scope = { names, values, set: new Set([...names, 'knob']) };
  return scope;
}

/** Exactly the allowlisted values plus `m` (not `knob`, which is per part). */
export function allowedScope(): Record<string, unknown> {
  const { names, values } = scopeTable();
  return Object.fromEntries(names.map((n, i) => [n, values[i]]));
}

const functionEvaluator: Evaluator = (source, names, values) =>
  new Function(...names, `"use strict";\n${source}`)(...values);

/** knob("cut") arrives as the transpiled m('cut', …) Pattern; knob('cut') as a string. */
function knobName(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  if (core.isPattern(arg)) {
    const pat = arg as { __pure?: unknown; firstCycleValues?: unknown[] };
    const v = pat.__pure ?? pat.firstCycleValues?.[0];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

export function compilePart(code: string, opts: { knob: KnobBinder; evaluator?: Evaluator }): CompiledPart {
  const table = scopeTable();
  let output: string;
  let locations: [number, number][];
  try {
    const t = transpiler(code, { wrapAsync: false, addReturn: true, emitMiniLocations: true, emitWidgets: false }) as {
      output: string;
      miniLocations: [number, number][];
    };
    output = t.output;
    locations = t.miniLocations;
  } catch (e) {
    throw new CompileError({ severity: 'error', rule: 'syntax', message: `Could not transpile the code: ${(e as Error).message}` });
  }
  const problem = checkTranspiled(output, table.set);
  if (problem) {
    throw new CompileError({ severity: 'error', rule: 'denied', message: `The transpiled code failed the safety invariant (${problem}).`, hint: 'Run validatePart() first.' });
  }

  const knob = (arg: unknown) => {
    const name = knobName(arg);
    if (name === undefined) throw new Error('knob() needs the name of a declared knob, e.g. knob("cut")');
    return opts.knob(name);
  };
  let result: unknown;
  try {
    result = (opts.evaluator ?? functionEvaluator)(output, [...table.names, 'knob'], [...table.values, knob]);
  } catch (e) {
    throw new CompileError(runtimeIssue(e));
  }
  if (!core.isPattern(result)) {
    throw new CompileError({
      severity: 'error',
      rule: 'not-pattern',
      message: `The code evaluated to ${result === undefined ? 'undefined' : typeof result}, not a pattern.`,
      hint: 'The last expression must be a pattern, e.g. s("bd*4") or note("c e g").s("piano").',
    });
  }
  return { pattern: result, miniLocations: locations.map(([start, end]) => ({ start, end })) };
}

/** Turns an exception thrown while building the pattern into a repairable issue. */
export function runtimeIssue(e: unknown): Issue {
  const message = String((e as Error)?.message ?? e);
  const issue: Issue = { severity: 'error', rule: 'runtime', message: `Error while building the pattern: ${message}` };
  const arity = /\.(\w+)\(\) expects (\d+) inputs but got (\d+)/.exec(message);
  if (/timed out/i.test(message)) {
    issue.rule = 'timeout';
    issue.hint = 'Building the pattern took too long; simplify it.';
  } else if (arity) {
    issue.hint = arity[1] === 'echo'
      ? 'echo(count, time, feedback) repeats events; for an audio delay use .delay(0.3).'
      : `.${arity[1]}() takes ${arity[2]} argument${arity[2] === '1' ? '' : 's'}.`;
  } else if (/is not a function/.test(message)) {
    issue.hint = 'A value is being called like a function. Check that methods follow a pattern (single-quoted strings are not patterns) and that functions passed to every()/sometimes() are written like x => x.fast(2).';
  } else if (/\[mini\]/.test(message)) {
    issue.rule = 'mini';
  } else if (/Invalid array length/.test(message)) {
    issue.hint = 'Euclid rhythms need 0 ≤ pulses ≤ steps, e.g. "bd(3,8)".';
  }
  return issue;
}
