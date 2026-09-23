// Static density rules, on the source AST. Every listener's browser queries part code on its main
// thread, and the server only analyses a window of bars, so what any later bar can cost has to be
// bounded before anything runs. Three layers:
//  1. Arguments that multiply events or the work of a query (fast, ply, segment, chop, echo, euclid,
//     inside, swing, shuffle, chunk, every…) must be numeric constants inside fixed ranges. A patterned
//     argument can detonate at any later bar (design-review: `.fast("<0!16 1>".mul(50000).add(1))` is
//     quiet for 16 bars, then 80 000 haps), and the room can push a knob anywhere in its range.
//  2. Arguments whose value sets the work per event (scaleTranspose walks its offset one scale step at
//     a time) must be literal numbers within a bound.
//  3. A conservative worst case of events per bar for the whole expression — sum of structure
//     sources (mini strings, literals) × product of multipliers, where multipliers applied
//     repeatedly (echoWith, plyWith) are raised to their repetition count, and every patterned
//     argument joined into its receiver multiplies by its polyphony: `.gain("[1,1,1]")` plays each
//     event three times. It must stay below STATIC_EVENTS_CEILING, so no bar, however far in the
//     future, can produce more; this catches constant multipliers stacked behind late conditions
//     (`.lastOf(100, x => x.ply(16).ply(16))`).
import type { Expression, Node, SpreadElement } from 'acorn';
import { MAX_DENSITY_FACTOR, MAX_PART_ONSETS_PER_BAR } from '../shared/limits.ts';
import { ALLOWLIST } from './allowlist.ts';
import { checkMini } from './mini.ts';

/** Worst-case events per bar any validated part may be able to produce (16× the per-part limit). */
export const STATIC_EVENTS_CEILING = MAX_DENSITY_FACTOR * MAX_PART_ONSETS_PER_BAR;

const D = MAX_DENSITY_FACTOR;
const MIN_FRACTION = 1 / D;
/** every/firstOf/lastOf build an array of this many patterns. */
const MAX_CYCLE_COUNT = 1024;
/** binaryNL bit lists (JavaScript bit operations are 32-bit). */
const MAX_BITS = 32;

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
  /** The iterated copies sound together (echoWith) rather than one after another (plyWith). */
  layered?: boolean;
  /** Cross-argument check; returns a message when violated. */
  check?: (v: number[]) => string | null;
}

const factorArg = (label = 'factor'): ArgRule => ({ index: 0, label, min: 0, max: D });
const slowArg = (index = 0, label = 'factor'): ArgRule => ({ index, label, min: MIN_FRACTION, max: 1e6 });
const countArg = (index: number, label: string, max: number, min = 1): ArgRule => ({ index, label, min, max });
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
const iterated = (arity: number, fn: number, layered: boolean): DensitySpec => ({ arity, args: [factorArg('count')], iterate: fn, layered, factor: ([n]) => Math.max(1, n!) });
// chunk(n, f) builds an n-step pattern and joins the part into each step; its work grows with n.
const chunked: DensitySpec = { arity: 2, args: [countArg(0, 'count', D)] };
// every(n, f) builds an array of n patterns (Array(n - 1).fill), per query when n is patterned.
const cycles: DensitySpec = { arity: 2, args: [countArg(0, 'cycle count', MAX_CYCLE_COUNT)] };
// shuffle/scramble build n slices and query n of them per cycle; scramble may repeat the densest.
const parts = (factor?: DensitySpec['factor']): DensitySpec => ({ arity: 1, args: [countArg(0, 'parts', D)], factor });

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
  // inside(n, f) is f(pat.slow(n)).fast(n): whatever structure f adds plays n times faster.
  inside: { arity: 2, args: [{ index: 0, label: 'factor', min: MIN_FRACTION, max: D }], factor: ([v]) => Math.max(1, v!) },
  outside: { arity: 2, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!) },
  // swingBy(x, n) is inside(n, late(seq(0, x / 2))).
  swingBy: { arity: 2, args: [countArg(1, 'slices', D)] },
  swing: { arity: 1, args: [countArg(0, 'slices', D)] },
  shuffle: parts(),
  scramble: parts(([n]) => Math.max(1, n!)),
  chunk: chunked,
  slowchunk: chunked,
  slowChunk: chunked,
  chunkBack: chunked,
  chunkback: chunked,
  fastchunk: chunked,
  fastChunk: chunked,
  chunkinto: chunked,
  chunkInto: chunked,
  chunkbackinto: chunked,
  chunkBackInto: chunked,
  every: cycles,
  firstOf: cycles,
  lastOf: cycles,
  echo: { arity: 3, args: [factorArg('count')], factor: ([n]) => Math.max(1, n!) },
  stut: { arity: 3, args: [factorArg('count')], factor: ([n]) => Math.max(1, n!) },
  echoWith: iterated(3, 2, true),
  echowith: iterated(3, 2, true),
  stutWith: iterated(3, 2, true),
  stutwith: iterated(3, 2, true),
  plyWith: iterated(2, 1, false),
  plywith: iterated(2, 1, false),
  plyForEach: iterated(2, 1, false),
  plyforeach: iterated(2, 1, false),
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
  // Lists built for every event.
  randL: { arity: 1, args: [countArg(0, 'length', MAX_PART_ONSETS_PER_BAR, 0)] },
  binaryNL: { arity: [1, 2], args: [{ index: 1, label: 'bits', min: 1, max: MAX_BITS, fallback: 16 }] },
};

/** Own-property lookup: part code chooses the names, and `constructor` must not find Object's. */
const own = <T>(table: Readonly<Record<string, T>>, name: string): T | undefined => (Object.hasOwn(table, name) ? table[name] : undefined);

export const densitySpec = (name: string): DensitySpec | undefined => own(DENSITY_SPECS, name);

export interface ValueBound {
  index: number;
  label: string;
  maxAbs: number;
  why: string;
}

const scaleSteps: ValueBound = { index: 0, label: 'offset', maxAbs: 128, why: 'each note walks the offset one scale step at a time' };
const VALUE_BOUNDS: Readonly<Record<string, ValueBound>> = { scaleTranspose: scaleSteps, scaleTrans: scaleSteps, strans: scaleSteps };

/** Arguments that must be literal numbers (or a mini string of numbers) within ±maxAbs. */
export const valueBound = (name: string): ValueBound | undefined => own(VALUE_BOUNDS, name);

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

// How a method argument joins its receiver (core/pattern.mjs, pick.mjs). By default an argument is a
// patterned value (appLeft / innerJoin): the receiver keeps its structure, and each of its events
// repeats once per value sounding at that moment — × the argument's polyphony.
/** Arguments that play alongside the receiver (pat.stack(b), xfade's other pattern): events add. */
const STACK_ARGS: Readonly<Record<string, number[] | 'all'>> = {
  stack: 'all', seq: 'all', sequence: 'all', cat: 'all', fastcat: 'all', slowcat: 'all', xfade: [1],
};
/** Arguments that bring the structure, the receiver sampled at each of their onsets (appRight, outerJoin). */
const OUT_ARGS: Readonly<Record<string, number[] | 'all'>> = {
  struct: 'all', structAll: 'all', out: 'all', mix: 'all', arp: 'all', scrub: 'all', pick: 'all', pickmod: 'all', slice: [1], splice: [1],
};
/** Calls whose events all come from their arguments (mix keeps the receiver's too). */
const OUT_JOINS = new Set(Object.keys(OUT_ARGS).filter((name) => name !== 'mix'));
/** One of the argument's patterns is chosen for each receiver event. */
const CHOICES = new Set(['pickOut', 'pickmodOut', 'choose', 'choose2']);
/** Joins that play or restart one pattern inside every event of another (events multiply). */
const SQUEEZES = new Set([
  'squeeze', 'squeezein', 'squeezeout', 'inhabit', 'inhabitmod', 'pickSqueeze', 'pickmodSqueeze', 'bite',
  'reset', 'restart', 'resetAll', 'restartAll', 'pickRestart', 'pickmodRestart', 'pickReset', 'pickmodReset',
]);
const SQUEEZE_FACTOR = MAX_PART_ONSETS_PER_BAR;
/** Operator modes (pat.add.out(…)) by how they join. */
const MODE_ROLES: Readonly<Record<string, ArgRole>> = {
  in: 'value', out: 'out', mix: 'mix', squeeze: 'squeeze', squeezein: 'squeeze', squeezeout: 'squeeze', reset: 'squeeze', restart: 'squeeze',
};
/** Chord symbols expand to at most this many simultaneous notes. */
const VOICING_FACTOR = 8;
/** Global combinators whose arguments sound together. */
const STACK_GLOBALS = new Set(['stack', 'pr', 'polyrhythm', 'stackLeft', 'stackRight', 'stackCentre', 'seqPLoop']);
/** Global combinators that play one argument at a time. */
const SEQUENCE_GLOBALS = new Set([
  'seq', 'sequence', 'fastcat', 'cat', 'slowcat', 'slowcatPrime', 'randcat', 'wrandcat', 'chooseCycles', 'wchooseCycles',
  'timeCat', 'timecat', 'stepcat', 'arrange', 'choose', 'chooseIn', 'chooseOut', 'wchoose',
]);

type ArgRole = 'const' | 'fn' | 'source' | 'stack' | 'out' | 'mix' | 'squeeze' | 'choice' | 'value';

const listed = (table: Readonly<Record<string, number[] | 'all'>>, name: string, i: number): boolean => {
  const entry = own(table, name);
  return entry === 'all' || (entry?.includes(i) ?? false);
};

function argRole(name: string, i: number, arg: Node, spec: DensitySpec | undefined, isMethod: boolean): ArgRole {
  if (spec?.args.some((r) => r.index === i)) return 'const';
  if (listed(FUNCTION_ARGS, name, i) || arg.type === 'ArrowFunctionExpression') return 'fn';
  if (!isMethod) return 'source';
  if (listed(STACK_ARGS, name, i)) return 'stack';
  if (listed(OUT_ARGS, name, i)) return name === 'mix' ? 'mix' : 'out';
  if (SQUEEZES.has(name)) return 'squeeze';
  if (CHOICES.has(name)) return 'choice';
  return 'value';
}

/** A global call that sources events itself; other globals are transformations used as functions. */
const isGlobalSource = (name: string) =>
  ALLOWLIST.controls.has(name) || STACK_GLOBALS.has(name) || SEQUENCE_GLOBALS.has(name) || !ALLOWLIST.methods.has(name);

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

type Arrow = Extract<Expression, { type: 'ArrowFunctionExpression' }>;
type Call = Extract<Expression, { type: 'CallExpression' }>;

interface Param {
  /** How often the body uses the parameter as structure. */
  uses: number;
  /** Polyphony of the pattern the function is applied to. */
  poly: number;
}

interface Env {
  consts: Map<string, Acc>;
  polys: Map<string, number>;
  /** Function constants (`const up = x => …`), applied where they are passed. */
  fns: Map<string, Arrow>;
  params: Map<string, Param>[];
  /** Polyphony of the pattern the function being walked is applied to (a curried `struct("x*4")` samples it). */
  input: number;
  /** Evaluations left: functions are re-applied where they are passed, and per repetition of echoWith… */
  work: number;
}

const LIMIT = 1e15;
/** Far above any real part; code that needs more is bounded as unboundable instead of stalling the validator. */
const WORK_BUDGET = 20_000;
const cap = (x: number) => Math.min(x, LIMIT);
const fresh = (): Acc => ({ w: 0, p: 1, why: [] });
const mul = (acc: Acc, f: number, label: string) => {
  if (f <= 1) return;
  acc.p = cap(acc.p * f);
  acc.why.push([label, f]);
};

/** Worst-case events per bar for a validated program (const declarations + one expression). */
export function densityBound(declarations: { name: string; init: Node }[], expression: Node): DensityBound {
  const env: Env = { consts: new Map(), polys: new Map(), fns: new Map(), params: [], input: 1, work: WORK_BUDGET };
  for (const d of declarations) {
    if (d.init.type === 'ArrowFunctionExpression') {
      env.fns.set(d.name, d.init as Arrow);
      continue;
    }
    const acc = fresh();
    walk(d.init, acc, true, env);
    env.consts.set(d.name, acc);
    env.polys.set(d.name, polyphony(d.init, env));
  }
  const acc = fresh();
  walk(expression, acc, true, env);
  if (env.work < 0) return { events: LIMIT, multipliers: ['functions repeated inside repeated functions, too deeply nested to bound'] };
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
      const param = paramOf(n.name, env);
      if (param) {
        param.uses++;
        return;
      }
      const c = env.consts.get(n.name);
      if (c) {
        acc.w += c.w;
        acc.p = cap(acc.p * c.p);
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
      const f = applyFunction(n, env, env.input);
      acc.w += f.w;
      acc.p = cap(acc.p * f.p);
      acc.why.push(...f.why);
      return;
    }
    case 'CallExpression':
      return walkCall(n, acc, structural, env);
    default:
      return;
  }
}

function paramOf(name: string, env: Env): Param | undefined {
  for (const scope of env.params) {
    const p = scope.get(name);
    if (p) return p;
  }
  return undefined;
}

/** Runs `body` with an arrow's parameters bound to a pattern of polyphony `poly`; also returns the most uses of one. */
function withParams<T>(arrow: Arrow, env: Env, poly: number, body: () => T): [T, number] {
  const params = new Map<string, Param>();
  for (const p of arrow.params) if (p.type === 'Identifier') params.set(p.name, { uses: 0, poly });
  env.params.unshift(params);
  const outer = env.input;
  env.input = poly;
  try {
    return [body(), Math.max(0, ...[...params.values()].map((p) => p.uses))];
  } finally {
    env.params.shift();
    env.input = outer;
  }
}

/** A function argument's own sources and multiplier (param used r times → ×r), applied to a pattern of polyphony `input`. */
function applyFunction(fn: Node, env: Env, input: number): Acc {
  const acc = fresh();
  if (--env.work < 0) return acc;
  const n = fn as Expression;
  if (n.type === 'Identifier') {
    const arrow = env.fns.get(n.name);
    if (arrow) return applyFunction(arrow, env, input);
    if (env.consts.has(n.name)) walk(n, acc, true, env);
    return acc; // rev, palindrome…
  }
  if (n.type !== 'ArrowFunctionExpression') {
    const outer = env.input;
    env.input = input;
    try {
      walk(n, acc, true, env);
    } finally {
      env.input = outer;
    }
    return acc;
  }
  const [, uses] = withParams(n, env, input, () => walk(n.body, acc, true, env));
  mul(acc, uses, 'the function uses its pattern');
  return acc;
}

function calleeName(call: Call): { name: string | null; receiver: Node | null; mode: string | null } {
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

const specValues = (spec: DensitySpec | undefined, args: readonly Node[]): number[] =>
  spec ? spec.args.map((r) => { const a = args[r.index]; return a ? (constantValue(a) ?? r.max) : (r.fallback ?? r.max); }) : [];

/** The polyphony a function argument of this call is applied to. */
function inputOf(receiver: Node | null, args: readonly Node[], env: Env): number {
  if (receiver) return polyphony(receiver, env);
  // A global form: the pattern is the last argument, or (curried) the pattern the function is applied to.
  return Math.max(env.input, polyphony(args[args.length - 1], env));
}

function walkCall(call: Call, acc: Acc, structural: boolean, env: Env): void {
  const { name, receiver, mode } = calleeName(call);
  const isMethod = receiver !== null;
  const outJoin = isMethod && (mode ? own(MODE_ROLES, mode) === 'out' : OUT_JOINS.has(name ?? ''));
  // An out-join takes its structure from the arguments; the receiver only contributes its polyphony.
  if (receiver && !outJoin) walk(receiver, acc, structural, env);
  if (name === null) {
    walk(call.callee, acc, structural, env);
    for (const a of call.arguments) walk(a, acc, structural, env);
    return;
  }
  if (name === 'knob' || !structural) return;
  const args = call.arguments;
  const shown = isMethod ? `.${name}${mode ? `.${mode}` : ''}()` : `${name}()`;
  const samples = () => mul(acc, isMethod ? polyphony(receiver, env) : env.input, `${shown} samples every sounding event`);

  if (mode) {
    const role = own(MODE_ROLES, mode) ?? 'value';
    if (role === 'squeeze') mul(acc, SQUEEZE_FACTOR, shown);
    for (const a of args) joinArg(a, role, acc, env, shown);
    if (role === 'out' || role === 'mix') samples();
    return;
  }

  if (name === 'morph' && !isMethod) {
    acc.w += listLength(args[0]);
    for (const a of args) mul(acc, polyphony(a, env), `${shown} stacked inputs`);
    return;
  }

  const spec = densitySpec(name);
  const values = specValues(spec, args);
  if (spec?.factor) mul(acc, spec.factor(values), `${name}(${values.map(fmt).join(', ')})`);
  if (spec?.source) acc.w += spec.source(values);
  if (SQUEEZES.has(name)) mul(acc, SQUEEZE_FACTOR, `${name}()`);
  if (name === 'voicing' || name === 'voicings') mul(acc, VOICING_FACTOR, 'voicing() chord notes');
  const transformation = !isMethod && !isGlobalSource(name);

  const fnArgs: Node[] = [];
  let mixes = false;
  args.forEach((arg, i) => {
    const role = argRole(name, i, arg, spec, isMethod);
    if (role === 'const') return;
    if (role === 'fn') {
      const list = arg.type === 'ArrayExpression' ? arg.elements : [arg];
      for (const el of list) if (el) fnArgs.push(el);
      return;
    }
    if (role === 'source') {
      walk(arg, acc, true, env);
      if (transformation || (name === 'stackBy' && i === 0)) mul(acc, polyphony(arg, env), `${shown} stacked values`);
      return;
    }
    if (role === 'mix') mixes = true;
    joinArg(arg, role, acc, env, shown);
  });
  if (outJoin || mixes || (transformation && OUT_JOINS.has(name))) samples();

  let input = fnArgs.length ? inputOf(receiver, args, env) : 1;
  if (spec?.iterate !== undefined) {
    const n = Math.max(1, values[0] ?? 1);
    // Each repetition applies the function to the previous one's result.
    for (let i = 1; i < n; i++) input = Math.max(input, ...fnArgs.map((f) => applyPolyphony(f, env, input)));
    for (const f of fnArgs.map((el) => applyFunction(el, env, input))) {
      acc.w += f.w * n;
      mul(acc, f.p ** (n - 1), `${name}(${fmt(n)}) repeats its function`);
      if (f.w > 0) mul(acc, n, `${name}(${fmt(n)}) layers new material`);
    }
    return;
  }
  const fns = fnArgs.map((el) => applyFunction(el, env, input));
  const fanout = own(FANOUT, name);
  if (fanout) mul(acc, fanout(fns.length), `${name}()`);
  for (const f of fns) {
    acc.w += f.w;
    acc.p = cap(acc.p * f.p);
    acc.why.push(...f.why);
  }
}

function joinArg(arg: Node, role: ArgRole, acc: Acc, env: Env, shown: string): void {
  switch (role) {
    case 'stack':
    case 'out':
    case 'squeeze':
      return walk(arg, acc, true, env);
    case 'mix':
      walk(arg, acc, true, env);
      return mul(acc, polyphony(arg, env), `${shown} stacked values`);
    case 'choice':
      return mul(acc, choicePolyphony(arg, env), `${shown} stacked choices`);
    default:
      return mul(acc, polyphony(arg, env), `${shown} stacked values`);
  }
}

// ─── Polyphony ──────────────────────────────────────────────────────────────────────────────────

/** Worst case of events sounding at the same moment. */
function polyphony(node: Node | SpreadElement | null | undefined, env: Env): number {
  if (!node) return 1;
  const n = node as Expression;
  switch (n.type) {
    case 'Literal':
      return typeof n.value === 'string' && n.raw?.[0] === '"' ? miniPolyphony(n.value) : 1;
    case 'TemplateLiteral':
      return miniPolyphony(n.quasis[0]!.value.raw);
    case 'Identifier':
      return paramOf(n.name, env)?.poly ?? env.polys.get(n.name) ?? 1;
    case 'ArrayExpression':
      return n.elements.reduce((p, el) => cap(p * polyphony(el, env)), 1);
    case 'ObjectExpression':
      return n.properties.reduce((p, prop) => (prop.type === 'Property' ? cap(p * polyphony(prop.value, env)) : p), 1);
    case 'CallExpression':
      return callPolyphony(n, env);
    default:
      return 1; // numbers, arithmetic of numbers, functions
  }
}

/** Polyphony of `fn` applied to a pattern of polyphony `input`. */
function applyPolyphony(fn: Node, env: Env, input: number): number {
  if (--env.work < 0) return LIMIT;
  const n = fn as Expression;
  if (n.type === 'Identifier') {
    const arrow = env.fns.get(n.name);
    return arrow ? applyPolyphony(arrow, env, input) : input;
  }
  if (n.type === 'ArrowFunctionExpression') return withParams(n, env, input, () => polyphony(n.body, env))[0];
  const outer = env.input;
  env.input = input;
  try {
    return cap(input * polyphony(n, env)); // a transformation waiting for its pattern: fast(2), add("[0,12]")
  } finally {
    env.input = outer;
  }
}

function callPolyphony(call: Call, env: Env): number {
  if (--env.work < 0) return LIMIT;
  const { name, receiver, mode } = calleeName(call);
  const args = call.arguments;
  const product = (xs: number[]) => xs.reduce((a, b) => cap(a * b), 1);
  if (name === null) return product([polyphony(call.callee, env), ...args.map((a) => polyphony(a, env))]);
  if (name === 'knob') return 1;
  if (receiver === null) {
    if (STACK_GLOBALS.has(name)) return cap(args.reduce((s, a) => s + polyphony(a, env), 0));
    if (SEQUENCE_GLOBALS.has(name) || ALLOWLIST.controls.has(name)) return Math.max(1, ...args.map((a) => polyphony(a, env)));
    if (name === 'morph') return product([listLength(args[0]), ...args.map((a) => polyphony(a, env))]);
  }
  const input = receiver ? polyphony(receiver, env) : 1;
  if (mode) return product([input, ...args.map((a) => polyphony(a, env))]);

  const spec = densitySpec(name);
  const values = specValues(spec, args);
  const fnArgs: Node[] = [];
  let joined = 1;
  let stacked = 0;
  args.forEach((arg, i) => {
    const role = argRole(name, i, arg, spec, receiver !== null);
    if (role === 'const') return;
    if (role === 'fn') {
      const list = arg.type === 'ArrayExpression' ? arg.elements : [arg];
      for (const el of list) if (el) fnArgs.push(el);
    } else if (role === 'stack') stacked += polyphony(arg, env);
    else if (role === 'choice') joined = cap(joined * choicePolyphony(arg, env));
    else joined = cap(joined * polyphony(arg, env));
  });

  let p = input;
  if (spec?.iterate !== undefined) {
    let q = input;
    p = 0;
    for (let i = 0; i < Math.max(1, values[0] ?? 1); i++) {
      p = spec.layered ? cap(p + q) : Math.max(p, q);
      q = Math.max(q, ...fnArgs.map((f) => applyPolyphony(f, env, q)));
    }
  } else if (fnArgs.length) {
    // The original (except for layer) plus each function's result: covers every, when, off, jux, superimpose…
    p = fnArgs.reduce((s, f) => cap(s + applyPolyphony(f, env, input)), name === 'layer' ? 0 : input);
  }
  p = cap(p * joined);
  if (name === 'echo' || name === 'stut') p = cap(p * Math.max(1, values[0] ?? 1));
  if (name === 'voicing' || name === 'voicings') p = cap(p * VOICING_FACTOR);
  return cap(p + stacked);
}

/** One alternative plays at a time: the widest one counts. */
function choicePolyphony(arg: Node, env: Env): number {
  const n = arg as Expression;
  if (n.type === 'ArrayExpression') return Math.max(1, ...n.elements.map((el) => polyphony(el, env)));
  if (n.type === 'ObjectExpression') return Math.max(1, ...n.properties.map((prop) => (prop.type === 'Property' ? polyphony(prop.value, env) : 1)));
  return polyphony(arg, env);
}

/** Longest list morph() may turn into events per cycle; any other computed list counts as unbounded. */
function listLength(node: Node | SpreadElement | undefined): number {
  const n = node as Expression | undefined;
  if (!n) return 1;
  if (n.type === 'ArrayExpression') return Math.max(1, n.elements.length);
  if (n.type === 'Literal' && typeof n.value === 'string' && n.raw?.[0] === '"') return miniList(n.value);
  if (n.type === 'TemplateLiteral') return miniList(n.quasis[0]!.value.raw);
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && (n.callee.name === 'binaryNL' || n.callee.name === 'randL')) {
    return Math.max(1, specValues(densitySpec(n.callee.name), n.arguments)[0] ?? 1);
  }
  return STATIC_EVENTS_CEILING;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

function miniEvents(value: string): number {
  const m = checkMini(value);
  return m.ok ? m.events : 1;
}

function miniPolyphony(value: string): number {
  const m = checkMini(value);
  return m.ok ? Math.max(1, m.polyphony) : 1;
}

function miniList(value: string): number {
  const m = checkMini(value);
  return m.ok ? m.listLength : 1;
}
