// Static density rules. Two layers, both on the source AST:
//  1. Arguments that multiply event density (fast, ply, segment, chop, echo, euclid…) must be
//     numeric constants inside fixed ranges. A patterned argument can detonate at any future bar
//     (design-review: `.fast("<0!16 1>".mul(50000).add(1))` is quiet for 16 bars, then 80 000 haps).
//  2. A conservative worst case of events per bar for the whole expression — sum of structure
//     sources (mini strings, literals) × product of multipliers, where multipliers applied
//     repeatedly (echoWith, plyWith) are raised to their repetition count. It must stay below
//     STATIC_EVENTS_CEILING, so no bar, however far in the future, can produce more; this catches
//     constant multipliers stacked behind late conditions (`.lastOf(100, x => x.ply(16).ply(16))`).
import type { Expression, Node, SpreadElement } from 'acorn';
import { MAX_DENSITY_FACTOR, MAX_PART_ONSETS_PER_BAR } from '../shared/limits.ts';
import { ALLOWLIST } from './allowlist.ts';
import { checkMini } from './mini.ts';

/** Worst-case events per bar any validated part may be able to produce (16× the per-part limit). */
export const STATIC_EVENTS_CEILING = MAX_DENSITY_FACTOR * MAX_PART_ONSETS_PER_BAR;

const D = MAX_DENSITY_FACTOR;
const MIN_FRACTION = 1 / D;

interface ArgRule {
  index: number;
  label: string;
  min: number;
  max: number;
  /** Absent argument value (e.g. binaryN's bit count). */
  fallback?: number;
  /** Also bound the magnitude from below (linger(-0.25) is fine, linger(0.001) is not). */
  minAbs?: number;
}

export interface DensitySpec {
  /** Arguments passed explicitly (method form); the global form may add the pattern last. */
  arity: number | [number, number];
  args: ArgRule[];
  /** How much the call multiplies events per bar, given the constant arguments. */
  factor?: (v: number[]) => number;
  /** Events per bar this call creates on its own (run(8) → 8). */
  source?: (v: number[]) => number;
  /** Index of a function applied cumulatively `v[0]` times (echoWith, plyWith). */
  iterate?: number;
  /** Cross-argument check; returns a message when violated. */
  check?: (v: number[]) => string | null;
}

const factorArg = (label = 'factor'): ArgRule => ({ index: 0, label, min: 0, max: D });
const slowArg = (index = 0, label = 'factor'): ArgRule => ({ index, label, min: MIN_FRACTION, max: 1e6 });
const times: DensitySpec = { arity: 1, args: [factorArg()], factor: ([v]) => Math.max(1, v!) };
const slower: DensitySpec = { arity: 1, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!) };
const euclidArgs: ArgRule[] = [
  { index: 0, label: 'pulses', min: 0, max: D },
  { index: 1, label: 'steps', min: 1, max: D },
];
const euclidCheck = ([p, s]: number[]) => (p! > s! ? 'pulses must not exceed steps' : null);
const euclid = (arity: number): DensitySpec => ({ arity, args: euclidArgs, factor: ([p]) => Math.max(1, p!), check: euclidCheck });
const span = (label: string): DensitySpec => ({
  arity: 2,
  args: [
    { index: 0, label: `${label} start`, min: -1e6, max: 1e6 },
    { index: 1, label: `${label} end`, min: -1e6, max: 1e6 },
  ],
  factor: ([b, e]) => Math.max(1, e! - b!),
  check: ([b, e]) => (e! <= b! ? 'end must be after start' : e! - b! > D ? `a span longer than ${D} cycles plays them all in one bar` : null),
});
const iterated = (arity: number, fn: number): DensitySpec => ({ arity, args: [factorArg('count')], iterate: fn, factor: ([n]) => Math.max(1, n!) });

const DENSITY_SPECS: Readonly<Record<string, DensitySpec>> = {
  fast: times,
  hurry: times,
  ply: times,
  segment: times,
  seg: times,
  chop: times,
  striate: times,
  fastGap: times,
  fastgap: times,
  slow: slower,
  sparsity: slower,
  loopAt: slower,
  loopat: slower,
  loopAtCps: { arity: 2, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!) },
  loopatcps: { arity: 2, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!) },
  linger: { arity: 1, args: [{ index: 0, label: 'fraction', min: -1e6, max: 1e6, minAbs: MIN_FRACTION }], factor: ([v]) => Math.max(1, 1 / Math.abs(v!)) },
  ribbon: { arity: 2, args: [slowArg(1, 'length')], factor: ([, c]) => Math.max(1, 1 / c!) },
  rib: { arity: 2, args: [slowArg(1, 'length')], factor: ([, c]) => Math.max(1, 1 / c!) },
  zoom: span('zoom'),
  focus: span('focus'),
  echo: { arity: 3, args: [factorArg('count')], factor: ([n]) => Math.max(1, n!) },
  stut: { arity: 3, args: [factorArg('count')], factor: ([n]) => Math.max(1, n!) },
  echoWith: iterated(3, 2),
  echowith: iterated(3, 2),
  stutWith: iterated(3, 2),
  stutwith: iterated(3, 2),
  plyWith: iterated(2, 1),
  plywith: iterated(2, 1),
  plyForEach: iterated(2, 1),
  plyforeach: iterated(2, 1),
  iter: { arity: 1, args: [factorArg('count')] },
  iterBack: { arity: 1, args: [factorArg('count')] },
  iterback: { arity: 1, args: [factorArg('count')] },
  euclid: euclid(2),
  euclidLegato: euclid(2),
  euclidRot: euclid(3),
  euclidrot: euclid(3),
  euclidLegatoRot: euclid(3),
  euclidish: euclid(3),
  eish: euclid(3),
  bite: { arity: 2, args: [{ index: 0, label: 'pieces', min: 1, max: D }] },
  run: { arity: 1, args: [factorArg('length')], source: ([n]) => n! },
  randrun: { arity: 1, args: [factorArg('length')], source: ([n]) => n! },
  binaryN: { arity: [1, 2], args: [{ index: 1, label: 'bits', min: 1, max: D, fallback: 16 }], source: ([, bits]) => bits! },
  binary: { arity: 1, args: [{ index: 0, label: 'number', min: 0, max: 2 ** D - 1 }], source: ([n]) => Math.max(1, Math.floor(Math.log2(Math.max(1, n!))) + 1) },
};

/** Own-property lookup: part code chooses the names, and `constructor` must not find Object's. */
const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);

export const densitySpec = (name: string): DensitySpec | undefined => own(DENSITY_SPECS, name);

/** Functions whose arguments at these indices are pattern → pattern functions. */
const FUNCTION_ARGS: Readonly<Record<string, number[] | 'all'>> = {
  every: [1], firstOf: [1], lastOf: [1], when: [1], within: [2], inside: [1], outside: [1],
  chunk: [1], slowchunk: [1], slowChunk: [1], chunkBack: [1], chunkback: [1], fastchunk: [1], fastChunk: [1],
  chunkinto: [1], chunkInto: [1], chunkbackinto: [1], chunkBackInto: [1],
  sometimesBy: [1], someCyclesBy: [1], sometimes: [0], someCycles: [0], often: [0], rarely: [0],
  almostNever: [0], almostAlways: [0], always: [0], never: [0],
  off: [1], jux: [0], juxBy: [1], juxby: [1], superimpose: 'all', layer: 'all', into: [1],
  echoWith: [2], echowith: [2], stutWith: [2], stutwith: [2], plyWith: [1], plywith: [1], plyForEach: [1], plyforeach: [1],
  pickF: [1], pickmodF: [1],
};

/** Extra copies a function fans out into (stack of the original and the transformed pattern). */
const FANOUT: Readonly<Record<string, (fns: number) => number>> = {
  off: () => 2, jux: () => 2, juxBy: () => 2, juxby: () => 2,
  superimpose: (k) => 1 + k,
  layer: (k) => Math.max(1, k),
};

/** Joins that play one pattern inside every event of another (events multiply). */
const SQUEEZES = new Set(['squeeze', 'squeezein', 'squeezeout', 'inhabit', 'inhabitmod', 'pickSqueeze', 'pickmodSqueeze', 'bite']);
const SQUEEZE_FACTOR = MAX_PART_ONSETS_PER_BAR;
/** Chord symbols expand to at most this many simultaneous notes. */
const VOICING_FACTOR = 8;

/** Methods whose arguments shape values only; their events come from the receiver. */
const VALUE_ONLY = new Set([
  'mask', 'maskAll', 'when', 'every', 'firstOf', 'lastOf', 'within', 'inside', 'outside', 'chunk', 'slowchunk', 'slowChunk',
  'chunkBack', 'chunkback', 'fastchunk', 'fastChunk', 'chunkinto', 'chunkInto', 'chunkbackinto', 'chunkBackInto',
  'sometimes', 'sometimesBy', 'someCycles', 'someCyclesBy', 'often', 'rarely', 'almostNever', 'almostAlways', 'always',
  'never', 'off', 'jux', 'juxBy', 'juxby', 'superimpose', 'layer', 'into', 'degrade', 'degradeBy', 'undegrade',
  'undegradeBy', 'degradeByWith', 'shuffle', 'scramble', 'late', 'early', 'swing', 'swingBy', 'seed', 'range', 'rangex',
  'range2', 'round', 'floor', 'ceil', 'toBipolar', 'fromBipolar', 'invert', 'inv', 'scale', 'transpose', 'trans', 'strans',
  'scaleTranspose', 'scaleTrans', 'voicing', 'voicings', 'rootNotes', 'rev', 'revv', 'palindrome', 'brak', 'press',
  'pressBy', 'repeatCycles', 'fit', 'compress', 'bypass', 'asNumber', 'ratio', 'chunk', 'hurry', ...Object.keys(DENSITY_SPECS),
]);

/** Numeric value of a constant expression: numbers, arithmetic of numbers, a "2" mini literal. */
export function constantValue(node: Node): number | null {
  const n = node as Expression;
  switch (n.type) {
    case 'Literal':
      if (typeof n.value === 'number') return n.value;
      if (typeof n.value === 'string' && n.raw?.[0] === '"') return checkMiniConstant(n.value);
      return null;
    case 'TemplateLiteral':
      return n.expressions.length === 0 ? checkMiniConstant(n.quasis[0]!.value.raw) : null;
    case 'UnaryExpression': {
      const v = constantValue(n.argument);
      return v === null ? null : n.operator === '-' ? -v : n.operator === '+' ? v : null;
    }
    case 'BinaryExpression': {
      const a = constantValue(n.left);
      const b = constantValue(n.right);
      if (a === null || b === null) return null;
      const ops: Record<string, (x: number, y: number) => number> = {
        '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y, '**': (x, y) => x ** y,
      };
      const r = ops[n.operator]?.(a, b);
      return r === undefined || !Number.isFinite(r) ? null : r;
    }
    default:
      return null;
  }
}

function checkMiniConstant(value: string): number | null {
  const m = checkMini(value);
  return m.ok ? m.constant : null;
}

// ─── Worst-case bound ───────────────────────────────────────────────────────────────────────────

export interface DensityBound {
  events: number;
  /** Human-readable multipliers, largest first. */
  multipliers: string[];
}

interface Acc {
  w: number;
  p: number;
  why: [string, number][];
}

interface Env {
  consts: Map<string, { w: number; p: number; why: [string, number][] }>;
  params: Map<string, number>[];
}

const fresh = (): Acc => ({ w: 0, p: 1, why: [] });
const mul = (acc: Acc, f: number, label: string) => {
  if (f <= 1) return;
  acc.p = Math.min(acc.p * f, 1e15);
  acc.why.push([label, f]);
};

/** Worst-case events per bar for a validated program (const declarations + one expression). */
export function densityBound(declarations: { name: string; init: Node }[], expression: Node): DensityBound {
  const env: Env = { consts: new Map(), params: [] };
  for (const d of declarations) {
    const acc = fresh();
    walk(d.init, acc, true, env);
    env.consts.set(d.name, acc);
  }
  const acc = fresh();
  walk(expression, acc, true, env);
  const multipliers = acc.why
    .sort((a, b) => b[1] - a[1])
    .map(([label, f]) => `${label} ×${Number.isInteger(f) ? f : f.toFixed(1)}`);
  return { events: Math.max(1, acc.w) * acc.p, multipliers };
}

function walk(node: Node | SpreadElement | null | undefined, acc: Acc, structural: boolean, env: Env): void {
  if (!node) return;
  const n = node as Expression;
  switch (n.type) {
    case 'Literal':
      if (!structural) return;
      if (typeof n.value === 'string' && n.raw?.[0] === '"') acc.w += miniEvents(n.value);
      else acc.w += 1;
      return;
    case 'TemplateLiteral':
      if (structural) acc.w += miniEvents(n.quasis[0]!.value.raw);
      return;
    case 'Identifier': {
      if (!structural) return;
      for (const scope of env.params) {
        if (scope.has(n.name)) {
          scope.set(n.name, scope.get(n.name)! + 1);
          return;
        }
      }
      const c = env.consts.get(n.name);
      if (c) {
        acc.w += c.w;
        acc.p = Math.min(acc.p * c.p, 1e15);
        acc.why.push(...c.why);
      } else acc.w += 1;
      return;
    }
    case 'ArrayExpression':
      for (const el of n.elements) walk(el, acc, structural, env);
      return;
    case 'ObjectExpression':
      for (const prop of n.properties) if (prop.type === 'Property') walk(prop.value, acc, structural, env);
      return;
    case 'BinaryExpression':
      walk(n.left, acc, structural, env);
      walk(n.right, acc, structural, env);
      return;
    case 'UnaryExpression':
      walk(n.argument, acc, structural, env);
      return;
    case 'ArrowFunctionExpression': {
      const f = applyFunction(n, env);
      acc.w += f.w;
      acc.p = Math.min(acc.p * f.p, 1e15);
      acc.why.push(...f.why);
      return;
    }
    case 'CallExpression':
      return walkCall(n, acc, structural, env);
    default:
      return;
  }
}

/** A function argument's own sources and multiplier (param used r times → ×r). */
function applyFunction(fn: Node, env: Env): Acc {
  const acc = fresh();
  if (fn.type === 'Identifier' && !env.consts.has((fn as Extract<Expression, { type: 'Identifier' }>).name)) return acc; // rev, palindrome…
  if (fn.type !== 'ArrowFunctionExpression') {
    walk(fn, acc, true, env);
    return acc;
  }
  const arrow = fn as Extract<Expression, { type: 'ArrowFunctionExpression' }>;
  const params = new Map<string, number>();
  for (const p of arrow.params) if (p.type === 'Identifier') params.set(p.name, 0);
  env.params.unshift(params);
  walk(arrow.body, acc, true, env);
  env.params.shift();
  const uses = Math.max(0, ...params.values());
  mul(acc, uses, 'the function uses its pattern');
  return acc;
}

function calleeName(call: Extract<Expression, { type: 'CallExpression' }>): { name: string | null; receiver: Node | null; mode: string | null } {
  const c = call.callee;
  if (c.type === 'Identifier') return { name: c.name, receiver: null, mode: null };
  if (c.type === 'MemberExpression' && c.property.type === 'Identifier') {
    const obj = c.object;
    if (
      obj.type === 'MemberExpression' && obj.property.type === 'Identifier' &&
      ALLOWLIST.operators.has(obj.property.name) && ALLOWLIST.operatorModes.has(c.property.name)
    ) {
      return { name: obj.property.name, receiver: obj.object, mode: c.property.name };
    }
    return { name: c.property.name, receiver: obj, mode: null };
  }
  return { name: null, receiver: null, mode: null };
}

function walkCall(call: Extract<Expression, { type: 'CallExpression' }>, acc: Acc, structural: boolean, env: Env): void {
  const { name, receiver, mode } = calleeName(call);
  const isMethod = receiver !== null;
  if (receiver) walk(receiver, acc, structural, env);
  if (name === null) {
    walk(call.callee, acc, structural, env);
    for (const a of call.arguments) walk(a, acc, structural, env);
    return;
  }
  if (name === 'knob' || !structural) return;

  if (mode) {
    if (mode.startsWith('squeeze')) mul(acc, SQUEEZE_FACTOR, `.${name}.${mode}()`);
    for (const a of call.arguments) walk(a, acc, mode !== 'in', env);
    return;
  }

  const spec = densitySpec(name);
  const values = spec ? spec.args.map((r) => { const a = call.arguments[r.index]; return a ? (constantValue(a) ?? r.max) : (r.fallback ?? r.max); }) : [];
  const constIdx = new Set(spec?.args.map((r) => r.index));
  const fnIdx = own(FUNCTION_ARGS, name);
  const isFnArg = (i: number) => fnIdx === 'all' || (fnIdx?.includes(i) ?? false);

  if (spec?.factor) mul(acc, spec.factor(values), `${name}(${values.map(fmt).join(', ')})`);
  if (spec?.source) acc.w += spec.source(values);
  if (SQUEEZES.has(name)) mul(acc, SQUEEZE_FACTOR, `${name}()`);
  if (name === 'voicing' || name === 'voicings') mul(acc, VOICING_FACTOR, 'voicing() chord notes');

  const fns: Acc[] = [];
  call.arguments.forEach((arg, i) => {
    if (constIdx.has(i)) return;
    if (isFnArg(i) || arg.type === 'ArrowFunctionExpression') {
      const list = arg.type === 'ArrayExpression' ? arg.elements : [arg];
      for (const el of list) if (el) fns.push(applyFunction(el, env));
      return;
    }
    const argStructural = !isMethod || !(VALUE_ONLY.has(name) || ALLOWLIST.controls.has(name) || ALLOWLIST.operators.has(name));
    walk(arg, acc, argStructural, env);
  });

  if (spec?.iterate !== undefined) {
    const n = Math.max(1, values[0] ?? 1);
    for (const f of fns) {
      acc.w += f.w * n;
      mul(acc, f.p ** (n - 1), `${name}(${fmt(n)}) repeats its function`);
      if (f.w > 0) mul(acc, n, `${name}(${fmt(n)}) layers new material`);
    }
    return;
  }
  const fanout = own(FANOUT, name);
  if (fanout) mul(acc, fanout(fns.length), `${name}()`);
  for (const f of fns) {
    acc.w += f.w;
    acc.p = Math.min(acc.p * f.p, 1e15);
    acc.why.push(...f.why);
  }
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

function miniEvents(value: string): number {
  const m = checkMini(value);
  return m.ok ? m.events : 1;
}
