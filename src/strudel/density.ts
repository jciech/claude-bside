// Static density rules, on the source AST. Every listener's browser queries part code on its main
// thread, and the server only analyses a window of bars, so what any later bar can cost has to be
// bounded before anything runs. Three layers:
//  1. Arguments that multiply events or the work of a query (fast, ply, segment, chop, echo, euclid,
//     inside, swing, shuffle, chunk, every…) must be numeric constants inside fixed ranges. A patterned
//     argument can detonate at any later bar (design-review: `.fast("<0!16 1>".mul(50000).add(1))` is
//     quiet for 16 bars, then 80 000 haps), and the room can push a knob anywhere in its range.
//  2. Arguments whose value sets the work per event (scaleTranspose walks its offset one scale step at
//     a time) must be literal numbers within a bound.
//  3. A conservative worst case of the haps a query of one bar builds — onsets, and the fragments and
//     intermediate haps Strudel creates on the way: the sum of structure sources (mini strings,
//     literals) and of the work of every join, × the product of multipliers (multipliers applied
//     repeatedly, by echoWith and plyWith, are raised to their repetition count). Joins cost what
//     Strudel does for them (core/pattern.mjs):
//       - a patterned value (controls, operators, mask: appLeft) is read over the whole of every
//         receiver event, so its own multipliers count, and so does the length of the receiver's
//         events (`s("bd").slow(1e5).gain("1*16")` reads 1.6 million values per query); each
//         receiver event also plays once per value sounding (`.gain("[1,1,1]")` plays it 3 times);
//       - an out-join (struct, arp, pick, out…) takes its structure from the argument and re-reads the
//         whole receiver at each structure event, so the receiver's multipliers count however few
//         onsets come out, and so does the length of the structure's events;
//       - a squeeze (bite, inhabit, squeeze, reset…) plays one pattern inside every event of the
//         other: their events multiply;
//       - a join that queries a pattern again for every event of another pays the pattern's fixed
//         cost per query (the part that does not shrink with the query: reading values across long
//         events) each time.
//     It must stay below STATIC_EVENTS_CEILING, so no bar, however far in the future, can cost more;
//     this catches constant multipliers stacked behind late conditions
//     (`.lastOf(100, x => x.ply(16).ply(16))`). A value that cannot be computed counts as unbounded.
// The engine's query budget (./guard.ts) is the runtime backstop for whatever this model misses.
import type { Expression, Node, SpreadElement } from 'acorn';
import { MAX_DENSITY_FACTOR, MAX_PART_ONSETS_PER_BAR } from '../shared/limits.ts';
import { ALLOWLIST } from './allowlist.ts';
import { checkMini } from './mini.ts';

/** Worst-case haps a query of one bar of any validated part may build (16× the per-part onset limit). */
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

/** The constant arguments' values `v` below are in the order of `args` (one per rule). */
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
  /** A constant structure the call imposes (segment, euclid: pat.struct(…)): its events per cycle and their length. */
  structure?: (v: number[]) => { events: number; span: number };
  /** How often one query of the result queries the pattern again, over pieces (chunk, swing, shuffle). */
  requery?: (v: number[]) => number;
  /** How the call changes the length of the pattern's events. */
  span?: (span: number, v: number[]) => number;
  /** Cross-argument check; returns a message when violated. */
  check?: (v: number[]) => string | null;
}

const factorArg = (label = 'factor'): ArgRule => ({ index: 0, label, min: 0, max: D });
const slowArg = (index = 0, label = 'factor'): ArgRule => ({ index, label, min: MIN_FRACTION, max: 1e6 });
const countArg = (index: number, label: string, max: number, min = 1): ArgRule => ({ index, label, min, max });
/** A factor of 0 is silence. */
const shorter = (span: number, v: number) => (v > 0 ? span / v : 0);
const times = (span?: DensitySpec['span']): DensitySpec => ({ arity: 1, args: [factorArg()], factor: ([v]) => Math.max(1, v!), span });
const faster = times((s, [v]) => shorter(s, v!));
const slower: DensitySpec = { arity: 1, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!), span: (s, [v]) => s * v! };
const segment: DensitySpec = { arity: 1, args: [factorArg()], structure: ([v]) => (v! > 0 ? { events: v!, span: 1 / v! } : { events: 0, span: 0 }) };
const euclidArgs: ArgRule[] = [
  { index: 0, label: 'pulses', min: 0, max: D },
  { index: 1, label: 'steps', min: 1, max: D },
];
const euclidCheck = ([p, s]: number[]) => (p! > s! ? 'pulses must not exceed steps' : null);
// euclid(p, s) is pat.struct(p pulses of s steps); the legato forms stretch each pulse up to the next.
const euclid = (arity: number, legato = false): DensitySpec => ({
  arity,
  args: euclidArgs,
  structure: ([p, s]) => ({ events: p!, span: legato ? 1 : 1 / s! }),
  check: euclidCheck,
});
const span = (label: string): DensitySpec => ({
  arity: 2,
  args: [
    { index: 0, label: `${label} start`, min: -1e6, max: 1e6 },
    { index: 1, label: `${label} end`, min: -1e6, max: 1e6 },
  ],
  factor: ([b, e]) => Math.max(1, e! - b!),
  span: (s, [b, e]) => shorter(s, e! - b!),
  check: ([b, e]) => (e! <= b! ? 'end must be after start' : e! - b! > D ? `a span longer than ${D} cycles plays them all in one bar` : null),
});
// Their copies are counted one by one (walkCall), so there is no factor.
const iterated = (arity: number, fn: number, layered: boolean): DensitySpec => ({ arity, args: [factorArg('count')], iterate: fn, layered });
// chunk(n, f) is pat.when(an n-step pattern, f): the part is queried again for each of the n steps.
const chunked: DensitySpec = { arity: 2, args: [countArg(0, 'count', D)], requery: ([n]) => n! };
// every(n, f) builds an array of n patterns (Array(n - 1).fill), per query when n is patterned.
const cycles: DensitySpec = { arity: 2, args: [countArg(0, 'cycle count', MAX_CYCLE_COUNT)] };
// shuffle/scramble bite the part into n slices and query n of them per cycle; scramble may repeat the densest.
const parts = (factor?: DensitySpec['factor']): DensitySpec => ({ arity: 1, args: [countArg(0, 'parts', D)], factor, requery: ([n]) => n! });
// swingBy(x, n) is inside(n, late(seq(0, x / 2))): the part is queried again for 2 pieces of each of n slices.
const swings = (arity: number): DensitySpec => ({ arity, args: [countArg(arity - 1, 'slices', D)], requery: ([n]) => 2 * n! });

const DENSITY_SPECS: Readonly<Record<string, DensitySpec>> = {
  fast: faster,
  hurry: faster,
  ply: times(),
  segment,
  seg: segment,
  chop: times((s, [v]) => (v! >= 1 ? s / v! : s)),
  striate: times((s, [v]) => (v! >= 1 ? s / v! : s)),
  fastGap: faster,
  fastgap: faster,
  slow: slower,
  sparsity: slower,
  loopAt: slower,
  loopat: slower,
  loopAtCps: { ...slower, arity: 2 },
  loopatcps: { ...slower, arity: 2 },
  linger: { arity: 1, args: [{ index: 0, label: 'fraction', min: -1e6, max: 1e6, minAbs: MIN_FRACTION }], factor: ([v]) => Math.max(1, 1 / Math.abs(v!)) },
  ribbon: { arity: 2, args: [slowArg(1, 'length')], factor: ([c]) => Math.max(1, 1 / c!) },
  rib: { arity: 2, args: [slowArg(1, 'length')], factor: ([c]) => Math.max(1, 1 / c!) },
  zoom: span('zoom'),
  focus: span('focus'),
  // inside(n, f) is f(pat.slow(n)).fast(n): whatever structure f adds plays n times faster.
  inside: { arity: 2, args: [{ index: 0, label: 'factor', min: MIN_FRACTION, max: D }], factor: ([v]) => Math.max(1, v!) },
  outside: { arity: 2, args: [slowArg()], factor: ([v]) => Math.max(1, 1 / v!) },
  swingBy: swings(2),
  swing: swings(1),
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
  euclidLegato: euclid(2, true),
  euclidRot: euclid(3),
  euclidrot: euclid(3),
  euclidLegatoRot: euclid(3, true),
  euclidish: euclid(3, true),
  eish: euclid(3, true),
  bite: { arity: 2, args: [{ index: 0, label: 'pieces', min: 1, max: D }] },
  run: { arity: 1, args: [factorArg('length')], source: ([n]) => n! },
  randrun: { arity: 1, args: [factorArg('length')], source: ([n]) => n! },
  binaryN: { arity: [1, 2], args: [{ index: 1, label: 'bits', min: 1, max: D, fallback: 16 }], source: ([bits]) => bits! },
  binary: { arity: 1, args: [{ index: 0, label: 'number', min: 0, max: 2 ** D - 1 }], source: ([n]) => bitsOf(n!) },
  // Lists built for every event. binaryL counts bits from each value: Infinity would never stop.
  randL: { arity: 1, args: [countArg(0, 'length', MAX_PART_ONSETS_PER_BAR, 0)] },
  binaryNL: { arity: [1, 2], args: [{ index: 1, label: 'bits', min: 1, max: MAX_BITS, fallback: 16 }] },
  binaryL: { arity: 1, args: [{ index: 0, label: 'number', min: 0, max: 2 ** MAX_BITS - 1 }] },
};

const bitsOf = (n: number) => Math.max(1, Math.floor(Math.log2(Math.max(1, n))) + 1);

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

/** Query the pattern in two branches (stack of pat.degradeBy(x) and f(pat.undegradeBy(1 - x))). */
const QUERIED_TWICE = new Set(['sometimesBy', 'sometimes', 'someCyclesBy', 'someCycles', 'often', 'rarely', 'almostNever', 'almostAlways', 'within']);

// How a method argument joins its receiver (core/pattern.mjs, pick.mjs). By default an argument is a
// patterned value: controls and operators read it over each receiver event (appLeft), a registered
// function with a patterned argument queries the receiver once per argument event (innerJoin).
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
/** Out-joins that read the receiver across the whole of each structure event (appRight); the others read it over parts. */
const READS_WHOLES = new Set(['struct', 'structAll', 'out']);
/** One of the argument's patterns is chosen for each receiver event. */
const CHOICES = new Set(['pickOut', 'pickmodOut', 'choose', 'choose2']);
/** Joins that play or restart one pattern inside every event of another (events multiply). */
const SQUEEZES = new Set([
  'squeeze', 'squeezein', 'squeezeout', 'inhabit', 'inhabitmod', 'pickSqueeze', 'pickmodSqueeze', 'bite',
  'reset', 'restart', 'resetAll', 'restartAll', 'pickRestart', 'pickmodRestart', 'pickReset', 'pickmodReset',
]);
/**
 * Calls that read their value arguments over each receiver event even when constant (reify(0.5) is
 * pure(0.5), queried per event), like controls and operators; they never query the receiver again.
 */
const READS_ONLY = new Set(['mask', 'maskAll', 'in', 'partials', 'phases', 'xfade', 'soft', 'hard', 'cubic', 'diode', 'asym', 'fold', 'sinefold', 'chebyshev']);
const readsOnly = (name: string) => ALLOWLIST.controls.has(name) || ALLOWLIST.operators.has(name) || READS_ONLY.has(name);
/**
 * Registered functions (a patterned argument queries the receiver once per value event) that also read
 * constants over each event of their pattern: hurry (.mul(speed)), range (.mul().add()), echo and stut
 * (.gain()), striate (.set()), loopAt (.speed().unit()), the envelopes.
 */
const READS_CONSTANTS = new Set(['ad', 'adsr', 'ar', 'ds', 'range', 'rangex', 'range2', 'hurry', 'echo', 'stut', 'striate', 'loopAt', 'loopat', 'loopAtCps', 'loopatcps', 'scrub']);
const readsConstants = (name: string) => readsOnly(name) || READS_CONSTANTS.has(name);
/** Copies of the pattern queried side by side: each pays its fixed cost (echo's delayed copies, ribbon's restarts). */
const COPIES = new Set(['echo', 'stut', 'ribbon', 'rib']);
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

/** A global call that sources events itself; other globals are transformations used as functions (a control with a pattern is `pat.set(…)`). */
const isGlobalSource = (name: string, args: readonly unknown[]) =>
  (ALLOWLIST.controls.has(name) && args.length < 2) || STACK_GLOBALS.has(name) || SEQUENCE_GLOBALS.has(name) || !ALLOWLIST.methods.has(name);

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

/** A JavaScript number (or arithmetic of numbers): Strudel reifies it as pure(value), which registered functions take as is. */
function isPlainNumber(node: Node): boolean {
  const n = node as Expression;
  if (n.type === 'Literal') return typeof n.value === 'number';
  if (n.type === 'UnaryExpression') return isPlainNumber(n.argument);
  if (n.type === 'BinaryExpression') return isPlainNumber(n.left) && isPlainNumber(n.right);
  return false;
}

// ─── Worst-case bound ───────────────────────────────────────────────────────────────────────────

export interface DensityBound {
  /** Haps a query of one bar can build (at least the onsets it plays). */
  events: number;
  /** Human-readable multipliers, largest first. */
  multipliers: string[];
}

/**
 * Work so far: `max(1, w) × p` haps per bar; additive terms are stored divided by `p` at the time they
 * are added, so later multipliers scale them and earlier ones do not. `f` is what any query pays
 * whatever its length (reading values across long events), in haps: every re-query pays it again,
 * copies multiply it, time transformations (fast, ply) leave it. `inW`/`inF` hold the events and
 * fixed cost of the pattern a function is applied to: they count inside the function, but the caller
 * already counts them.
 */
interface Acc {
  w: number;
  p: number;
  f: number;
  inW: number;
  inF: number;
  why: [string, number][];
}

/** Events that sound at once, and the longest event in cycles (0 for continuous signals). */
interface Shape {
  poly: number;
  span: number;
}

/** The pattern a function or a transformation is applied to. */
interface Input extends Shape {
  events: number;
  fixed: number;
}

type Arrow = Extract<Expression, { type: 'ArrowFunctionExpression' }>;
type Call = Extract<Expression, { type: 'CallExpression' }>;

interface Param {
  /** How often the body uses the parameter as structure. */
  uses: number;
  input: Input;
}

interface Env {
  consts: Map<string, Acc>;
  shapes: Map<string, Shape>;
  /** Function constants (`const up = x => …`), applied where they are passed. */
  fns: Map<string, Arrow>;
  params: Map<string, Param>[];
  /** The pattern the function being walked is applied to (a curried `struct("x*4")` samples it). */
  input: Input;
  /** Evaluations left: functions are re-applied where they are passed, and per repetition of echoWith… */
  work: number;
  /** Shapes computed under the current bindings of parameters and input. */
  memo: WeakMap<object, Shape>;
}

const LIMIT = 1e15;
/** Far above any real part; code that needs more is bounded as unboundable instead of stalling the validator. */
const WORK_BUDGET = 20_000;
const ONE: Shape = { poly: 1, span: 1 };
const SIGNAL: Shape = { poly: 1, span: 0 };
const UNBOUNDED: Shape = { poly: LIMIT, span: LIMIT };
/** NaN and Infinity count as unbounded. */
const cap = (x: number) => (x < LIMIT ? x : LIMIT);
const fresh = (): Acc => ({ w: 0, p: 1, f: 0, inW: 0, inF: 0, why: [] });
const mul = (acc: Acc, f: number, label: string) => {
  const factor = cap(f);
  if (factor <= 1) return;
  acc.p = cap(acc.p * factor);
  acc.why.push([label, factor]);
};
/** The pattern is queried `k` times side by side: its events and its fixed cost multiply. */
const copies = (acc: Acc, k: number, label: string) => {
  mul(acc, k, label);
  scaleFixed(acc, k);
};
const scaleFixed = (acc: Acc, k: number) => {
  if (!(k > 1)) return;
  acc.f = cap(acc.f * k);
  acc.inF = cap(acc.inF * k);
};
/** Haps a query of one bar of `a` builds, its function input included. */
const load = (a: Acc) => cap(Math.max(1, a.w + a.inW) * a.p);
/** What any query of `a` costs however short, its function input included. */
const fixedCost = (a: Acc) => cap(a.f + a.inF);
const addWork = (acc: Acc, x: number) => {
  acc.w = cap(acc.w + cap(Math.max(0, x)) / acc.p);
};
const addFixed = (acc: Acc, x: number) => {
  acc.f = cap(acc.f + cap(Math.max(0, x)));
};
/** Adds a function result's events and multipliers (its input is the caller's own pattern, already counted). */
const merge = (acc: Acc, b: Acc) => {
  acc.w = cap(acc.w + b.w);
  acc.p = cap(acc.p * b.p);
  acc.f = cap(acc.f + b.f);
  acc.why.push(...b.why);
};
/** Adds an argument walked on its own, as if it had been walked into `acc`. */
const absorb = (acc: Acc, b: Acc) => {
  merge(acc, b);
  acc.inW = Math.max(acc.inW, (b.inW * b.p) / acc.p);
  acc.inF = Math.max(acc.inF, b.inF);
};
const combine = (a: Shape, b: Shape): Shape => ({ poly: Math.max(a.poly, b.poly), span: Math.max(a.span, b.span) });

/** Worst-case haps per bar for a validated program (const declarations + one expression). */
export function densityBound(declarations: { name: string; init: Node }[], expression: Node): DensityBound {
  const env: Env = {
    consts: new Map(),
    shapes: new Map(),
    fns: new Map(),
    params: [],
    input: { poly: 1, span: 1, events: 1, fixed: 0 },
    work: WORK_BUDGET,
    memo: new WeakMap(),
  };
  for (const d of declarations) {
    if (d.init.type === 'ArrowFunctionExpression') {
      env.fns.set(d.name, d.init as Arrow);
      continue;
    }
    const acc = fresh();
    walk(d.init, acc, env);
    env.consts.set(d.name, acc);
    env.shapes.set(d.name, shape(d.init, env));
  }
  const acc = fresh();
  walk(expression, acc, env);
  if (env.work < 0) return { events: LIMIT, multipliers: ['functions repeated inside repeated functions, too deeply nested to bound'] };
  const multipliers = acc.why
    .sort((a, b) => b[1] - a[1])
    .map(([label, f]) => `${label} ×${Number.isInteger(f) ? f : f.toFixed(1)}`);
  return { events: cap(Math.max(1, acc.w) * acc.p), multipliers };
}

function walk(node: Node | SpreadElement | null | undefined, acc: Acc, env: Env): void {
  if (!node) return;
  const n = node as Expression;
  switch (n.type) {
    case 'Literal':
      if (typeof n.value === 'string' && n.raw?.[0] === '"') acc.w = cap(acc.w + miniEvents(n.value));
      else acc.w += 1;
      return;
    case 'TemplateLiteral':
      acc.w = cap(acc.w + miniEvents(n.quasis[0]!.value.raw));
      return;
    case 'Identifier': {
      const param = paramOf(n.name, env);
      if (param) {
        param.uses++;
        acc.inW = Math.max(acc.inW, param.input.events / acc.p);
        acc.inF = Math.max(acc.inF, param.input.fixed);
        return;
      }
      const c = env.consts.get(n.name);
      if (c) merge(acc, c);
      else acc.w += 1; // a signal: one hap per query
      return;
    }
    case 'ArrayExpression':
      for (const el of n.elements) walk(el, acc, env);
      return;
    case 'ObjectExpression':
      for (const prop of n.properties) if (prop.type === 'Property') walk(prop.value, acc, env);
      return;
    case 'BinaryExpression':
      walk(n.left, acc, env);
      walk(n.right, acc, env);
      return;
    case 'UnaryExpression':
      walk(n.argument, acc, env);
      return;
    case 'ArrowFunctionExpression':
      merge(acc, applyFunction(n, env, env.input));
      return;
    case 'CallExpression':
      return walkCall(n, acc, env);
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

/** Runs `body` with `env.input` (and a memo for its bindings) set to `input`. */
function withInput<T>(env: Env, input: Input, body: () => T): T {
  const { input: outer, memo } = env;
  env.input = input;
  env.memo = new WeakMap();
  try {
    return body();
  } finally {
    env.input = outer;
    env.memo = memo;
  }
}

/** Runs `body` with an arrow's parameters bound to `input`; also returns the most uses of one. */
function withParams<T>(arrow: Arrow, env: Env, input: Input, body: () => T): [T, number] {
  const params = new Map<string, Param>();
  for (const p of arrow.params) if (p.type === 'Identifier') params.set(p.name, { uses: 0, input });
  env.params.unshift(params);
  try {
    return [withInput(env, input, body), Math.max(0, ...[...params.values()].map((p) => p.uses))];
  } finally {
    env.params.shift();
  }
}

/** A function argument's own sources and multipliers (param used r times → ×r), applied to `input`. */
function applyFunction(fn: Node, env: Env, input: Input): Acc {
  const acc = fresh();
  if (--env.work < 0) return acc;
  const n = fn as Expression;
  if (n.type === 'Identifier') {
    const arrow = env.fns.get(n.name);
    if (arrow) return applyFunction(arrow, env, input);
    if (env.consts.has(n.name)) walk(n, acc, env);
    return acc; // rev, palindrome…
  }
  if (n.type !== 'ArrowFunctionExpression') {
    withInput(env, input, () => walk(n, acc, env)); // a transformation waiting for its pattern: fast(2), add("[0,12]")
    return acc;
  }
  const [, uses] = withParams(n, env, input, () => walk(n.body, acc, env));
  copies(acc, uses, 'the function uses its pattern');
  return acc;
}

/** A constant read over each event of `r` (controls, operators, hurry's speed…) costs what the events last. */
function longEvents(acc: Acc, r: Shape, shown: string): void {
  if (!(r.span > 1)) return;
  addWork(acc, r.poly * (1 + r.span));
  addFixed(acc, r.poly * r.span);
  acc.why.push([`${shown} reads its values across ${fmt(r.span)}-cycle events`, cap(r.span)]);
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

/** Constant argument values in rule order (a pattern or knob counts as the rule's maximum). */
const specValues = (spec: DensitySpec | undefined, args: readonly Node[]): number[] =>
  spec ? spec.args.map((r) => { const a = args[r.index]; return a ? (constantValue(a) ?? r.max) : (r.fallback ?? r.max); }) : [];

/** The pattern arguments of a call's global form. */
const patternArgs = (args: readonly Node[], roles: ArgRole[]) => args.filter((_, i) => roles[i] === 'source');

function walkCall(call: Call, acc: Acc, env: Env): void {
  const { name, receiver, mode } = calleeName(call);
  const args = call.arguments;
  if (name === null) {
    walk(call.callee, acc, env);
    for (const a of args) walk(a, acc, env);
    return;
  }
  if (name === 'knob') return;
  const isMethod = receiver !== null;
  const shown = isMethod ? `.${name}${mode ? `.${mode}` : ''}()` : `${name}()`;

  if (name === 'morph' && !isMethod) {
    acc.w = cap(acc.w + listLength(args[0]));
    for (const a of args) mul(acc, shape(a, env).poly, `${shown} stacked inputs`);
    return;
  }

  const spec = densitySpec(name);
  const values = specValues(spec, args);
  const roles = args.map((arg, i): ArgRole => (mode ? (own(MODE_ROLES, mode) ?? 'value') : argRole(name, i, arg, spec, isMethod)));
  const fnArgs: Node[] = args.filter((_, i) => roles[i] === 'fn').flatMap((a): Node[] => (a.type === 'ArrayExpression' ? a.elements.filter((e) => e !== null) : [a]));

  if (!isMethod && isGlobalSource(name, args)) {
    args.forEach((arg, i) => {
      if (roles[i] !== 'source') return;
      walk(arg, acc, env);
      if (name === 'stackBy' && i === 0) mul(acc, shape(arg, env).poly, `${shown} stacked values`);
    });
    applySpec(acc, spec, values, name);
    return;
  }

  // The pattern the call transforms: the receiver, or in a global form the last pattern argument or
  // (curried) the pattern the function is applied to. An out-join's events come from its structure,
  // so its receiver is walked on its own and counts as the work of reading it.
  const restructures = isMethod && (mode === 'out' || OUT_JOINS.has(name) || spec?.structure !== undefined);
  let r: Input;
  if (receiver) {
    const target = restructures ? fresh() : acc;
    walk(receiver, target, env);
    r = { ...shape(receiver, env), events: load(target), fixed: fixedCost(target) };
    if (target !== acc) acc.why.push(...target.why);
  } else {
    const pats = patternArgs(args, roles);
    const sides = pats.map((arg) => side(arg, env));
    const last = sides.length ? sides[sides.length - 1]!.shape : SIGNAL;
    const pattern = () => ({ ...combine(env.input, last), events: Math.max(env.input.events, load(acc)), fixed: env.input.fixed + fixedCost(acc) });
    if (SQUEEZES.has(name)) {
      if (sides.length) absorb(acc, sides[sides.length - 1]!.acc);
      r = pattern();
      for (const s of sides.slice(0, -1)) squeezeWith(acc, s, r, shown);
    } else {
      for (const s of sides) absorb(acc, s.acc);
      r = pattern();
      // Each pattern argument is a value joined into the pattern (or is the pattern: counted twice).
      sides.forEach((s, i) => {
        mul(acc, s.shape.poly, `${shown} stacked values`);
        joinValue(acc, s, isPlainNumber(pats[i]!), name, r, shown);
      });
      if (OUT_JOINS.has(name)) outJoin(acc, costOf(sides), r, READS_WHOLES.has(name), shown);
    }
  }

  applySpec(acc, spec, values, name);
  if (name === 'voicing' || name === 'voicings') mul(acc, VOICING_FACTOR, 'voicing() chord notes');

  if (isMethod) {
    const at = (role: ArgRole) => args.filter((_, i) => roles[i] === role);
    let joinedValue = false;
    args.forEach((arg, i) => {
      if (roles[i] === 'stack') walk(arg, acc, env);
      if (roles[i] !== 'value') return;
      const s = side(arg, env);
      mul(acc, s.shape.poly, `${shown} stacked values`);
      joinedValue = joinValue(acc, s, isPlainNumber(arg), name, r, shown) || joinedValue;
    });
    const choices = at('choice');
    if (choices.length) {
      const c = side(choices, env);
      mul(acc, Math.max(1, ...choices.map((a) => choiceShape(a, env).poly)), `${shown} stacked choices`);
      addWork(acc, load(c.acc) + r.events * fixedCost(c.acc));
      addFixed(acc, fixedCost(c.acc));
      acc.why.push(...c.acc.why);
    }
    const outs = at('out');
    if (outs.length) {
      const s = outs.map((a) => side(a, env));
      for (const x of s) acc.why.push(...x.acc.why);
      outJoin(acc, costOf(s), r, mode === 'out' || READS_WHOLES.has(name), shown);
    }
    for (const arg of at('mix')) {
      const m = side(arg, env);
      const events = load(m.acc);
      const fixed = fixedCost(m.acc);
      // appBoth tries every pair of events; each pair that overlaps is an event.
      addWork(acc, events * (1 + r.poly) + r.events * (m.shape.poly + events) + r.events * fixed + events * r.fixed);
      addFixed(acc, fixed);
      acc.why.push(...m.acc.why);
    }
    for (const arg of at('squeeze')) squeezeWith(acc, side(arg, env), r, shown);
    if (!joinedValue && !restructures && readsConstants(name)) longEvents(acc, r, shown);
  }

  const structure = spec?.structure?.(values);
  if (structure) outJoin(acc, { events: structure.events, poly: 1, span: structure.span, fixed: 0 }, r, true, shown);
  const requery = spec?.requery?.(values) ?? (QUERIED_TWICE.has(name) ? 1 : 0);
  // Each piece pays the fixed cost, and cuts an event of every layer in two.
  if (requery > 0) addWork(acc, requery * (r.fixed + r.poly));
  if (QUERIED_TWICE.has(name)) scaleFixed(acc, 2);

  if (!fnArgs.length) return;
  if (spec?.iterate !== undefined) {
    // n copies (stacked by echoWith, played in turn by plyWith); copy i is the function applied to copy i - 1.
    const n = Math.max(1, values[0] ?? 1);
    let copy: Input = r;
    let events = r.events;
    for (let i = 1; i < n; i++) {
      const results = fnArgs.map((el) => applyFunction(el, env, copy));
      const shapes = fnArgs.map((el) => applyShape(el, env, copy));
      copy = {
        poly: Math.max(1, ...shapes.map((s) => s.poly)),
        span: Math.max(0, ...shapes.map((s) => s.span)),
        events: results.reduce((a, f) => cap(a + load(f)), 0),
        fixed: results.reduce((a, f) => cap(a + fixedCost(f)), 0),
      };
      events = cap(events + copy.events);
      addWork(acc, copy.events);
      addFixed(acc, copy.fixed);
      if (i === 1) for (const f of results) acc.why.push(...f.why);
    }
    if (n > 1) acc.why.push([`${name}(${fmt(n)}) copies`, cap(events / Math.max(1, r.events))]);
    return;
  }
  const input = name === 'inside' ? { ...r, span: r.span * values[0]! } : name === 'outside' ? { ...r, span: r.span / values[0]! } : r;
  const fns = fnArgs.map((el) => applyFunction(el, env, input));
  const fanout = own(FANOUT, name);
  if (fanout) copies(acc, fanout(fns.length), `${name}()`);
  for (const f of fns) merge(acc, f);
}

function applySpec(acc: Acc, spec: DensitySpec | undefined, values: number[], name: string): void {
  if (spec?.factor) (COPIES.has(name) ? copies : mul)(acc, spec.factor(values), `${name}(${values.map(fmt).join(', ')})`);
  if (spec?.source) acc.w = cap(acc.w + Math.max(0, spec.source(values)));
}

/** A pattern argument walked on its own. */
function side(arg: Node | Node[], env: Env): { acc: Acc; shape: Shape } {
  const acc = fresh();
  const list = Array.isArray(arg) ? arg : [arg];
  for (const a of list) walk(a, acc, env);
  return { acc, shape: list.map((a) => shape(a, env)).reduce(combine, SIGNAL) };
}

interface Cost {
  events: number;
  poly: number;
  span: number;
  fixed: number;
}

const costOf = (sides: { acc: Acc; shape: Shape }[]): Cost => ({
  events: sides.reduce((a, s) => cap(a + load(s.acc)), 0),
  poly: sides.reduce((a, s) => cap(a * Math.max(1, s.shape.poly)), 1),
  span: Math.max(0, ...sides.map((s) => s.shape.span)),
  fixed: sides.reduce((a, s) => cap(a + fixedCost(s.acc)), 0),
});

/**
 * A patterned value joined into the pattern `r` (whose work `acc` holds). Controls and operators read
 * it over the whole of each event of `r` (appLeft), plain numbers included; a registered function
 * takes a plain number as is, and with a pattern queries `r` once per value event (innerJoin).
 * Returns whether the value is read over each event.
 */
function joinValue(acc: Acc, a: { acc: Acc; shape: Shape }, plain: boolean, name: string, r: Input, shown: string): boolean {
  const reads = readsConstants(name) || !plain;
  const binds = !plain && !readsOnly(name);
  const value = load(a.acc);
  const fixed = fixedCost(a.acc);
  if (reads) {
    addWork(acc, value * r.poly * (1 + r.span) + r.events * fixed);
    addFixed(acc, r.poly * (value * r.span + a.shape.poly + fixed));
    if (r.span > 1) acc.why.push([`${shown} reads its value across ${fmt(r.span)}-cycle events`, cap(r.span)]);
  }
  if (binds) {
    addWork(acc, value * (r.fixed + r.poly));
    scaleFixed(acc, a.shape.poly);
    addFixed(acc, fixed);
  }
  acc.why.push(...a.acc.why);
  return reads;
}

/**
 * The structure comes from `s`, and each of its events samples the pattern `r`: every sounding event
 * of `r` comes out once per structure event, and `r` is queried again per structure event, across the
 * event's whole (appRight: struct, out) or over its part (arp, pick, scrub, slice).
 */
function outJoin(acc: Acc, s: Cost, r: Input, readsWholes: boolean, shown: string): void {
  const reads = r.events * (readsWholes ? s.poly * (1 + s.span) : 1 + s.poly);
  addWork(acc, s.events * (1 + r.poly) + reads + s.events * r.fixed + r.events * s.fixed);
  addFixed(acc, s.poly * ((readsWholes ? r.events * s.span : 0) + r.poly + r.fixed) + s.fixed);
  if (r.poly > 1) acc.why.push([`${shown} samples every sounding event`, cap(r.poly)]);
  if (readsWholes && s.poly * s.span > 1) acc.why.push([`${shown} reads the pattern across each structure event`, cap(s.poly * s.span)]);
}

/** One pattern plays (or restarts) inside every event of the other: events multiply, and each pays the other's fixed cost. */
function squeezeWith(acc: Acc, s: { acc: Acc; shape: Shape }, r: Input, shown: string): void {
  const events = load(s.acc);
  const fixed = fixedCost(s.acc);
  mul(acc, events, `${shown} plays one pattern inside every event of another`);
  addWork(acc, r.events * fixed + events * r.fixed);
  scaleFixed(acc, s.shape.poly);
  addFixed(acc, r.poly * fixed);
  acc.why.push(...s.acc.why);
}

// ─── Shape: polyphony and event length ─────────────────────────────────────────────────────────

function shape(node: Node | SpreadElement | null | undefined, env: Env): Shape {
  if (!node) return ONE;
  const hit = env.memo.get(node);
  if (hit) return hit;
  const s = computeShape(node, env);
  env.memo.set(node, s);
  return s;
}

function computeShape(node: Node | SpreadElement, env: Env): Shape {
  const n = node as Expression;
  switch (n.type) {
    case 'Literal':
      return typeof n.value === 'string' && n.raw?.[0] === '"' ? miniShape(n.value) : ONE;
    case 'TemplateLiteral':
      return miniShape(n.quasis[0]!.value.raw);
    case 'Identifier': {
      const p = paramOf(n.name, env);
      if (p) return { poly: p.input.poly, span: p.input.span };
      return env.shapes.get(n.name) ?? SIGNAL;
    }
    case 'ArrayExpression':
      return n.elements.reduce((s, el) => stackOf(s, shape(el, env)), ONE);
    case 'ObjectExpression':
      return n.properties.reduce((s, prop) => (prop.type === 'Property' ? stackOf(s, shape(prop.value, env)) : s), ONE);
    case 'CallExpression':
      return callShape(n, env);
    default:
      return ONE; // numbers, arithmetic of numbers, functions
  }
}

/** Values joined together: polyphonies multiply, the longest event wins. */
const stackOf = (a: Shape, b: Shape): Shape => ({ poly: cap(a.poly * b.poly), span: Math.max(a.span, b.span) });

/** Shape of `fn` applied to a pattern of shape `input`. */
function applyShape(fn: Node, env: Env, input: Shape): Shape {
  if (--env.work < 0) return UNBOUNDED;
  const n = fn as Expression;
  const bound: Input = { ...input, events: 1, fixed: 0 };
  if (n.type === 'Identifier') {
    const arrow = env.fns.get(n.name);
    return arrow ? applyShape(arrow, env, input) : input;
  }
  if (n.type === 'ArrowFunctionExpression') return withParams(n, env, bound, () => shape(n.body, env))[0];
  return withInput(env, bound, () => shape(n, env)); // a transformation waiting for its pattern: fast(2), add("[0,12]")
}

function callShape(call: Call, env: Env): Shape {
  if (--env.work < 0) return UNBOUNDED;
  const { name, receiver, mode } = calleeName(call);
  const args = call.arguments;
  const shapes = () => args.map((a) => shape(a, env));
  if (name === null) return [call.callee, ...args].map((a) => shape(a, env)).reduce(stackOf, ONE);
  if (name === 'knob') return SIGNAL;
  if (receiver === null) {
    if (STACK_GLOBALS.has(name)) return { poly: cap(shapes().reduce((s, x) => s + x.poly, 0)), span: Math.max(0, ...shapes().map((x) => x.span)) };
    if (SEQUENCE_GLOBALS.has(name) || (ALLOWLIST.controls.has(name) && args.length < 2)) {
      return { poly: Math.max(1, ...shapes().map((x) => x.poly)), span: Math.max(0, ...shapes().map((x) => x.span)) };
    }
    if (name === 'morph') return { poly: cap([listLength(args[0]), ...shapes().map((x) => x.poly)].reduce((a, b) => a * b, 1)), span: 1 };
  }
  const source = receiver === null && isGlobalSource(name, args);
  const spec = densitySpec(name);
  const values = specValues(spec, args);
  const roles = args.map((arg, i): ArgRole => (mode ? (own(MODE_ROLES, mode) ?? 'value') : argRole(name, i, arg, spec, receiver !== null)));
  const pats = args.filter((_, i) => roles[i] === 'source');
  const base = receiver
    ? shape(receiver, env)
    : source
      ? ONE
      : combine(env.input, pats.length ? shape(pats[pats.length - 1], env) : SIGNAL);

  const fnArgs: Node[] = [];
  let joined = 1;
  let stacked = 0;
  let span = base.span;
  let structure = -1;
  args.forEach((arg, i) => {
    const role = roles[i]!;
    if (role === 'const') return;
    if (role === 'fn') {
      const list = arg.type === 'ArrayExpression' ? arg.elements : [arg];
      for (const el of list) if (el) fnArgs.push(el);
      return;
    }
    const s = role === 'choice' ? choiceShape(arg, env) : shape(arg, env);
    if (role === 'stack') stacked += s.poly;
    else joined = cap(joined * s.poly);
    if (role === 'out') structure = Math.max(structure, s.span);
    else if (role !== 'value' && role !== 'choice') span = Math.max(span, s.span);
  });
  if (structure >= 0) span = structure;
  if (spec?.span) span = spec.span(span, values);
  const imposed = spec?.structure?.(values);
  if (imposed) span = imposed.span;

  let p = base.poly;
  if (spec?.iterate !== undefined) {
    let q = base;
    p = 0;
    for (let i = 0; i < Math.max(1, values[0] ?? 1); i++) {
      p = spec.layered ? cap(p + q.poly) : Math.max(p, q.poly);
      span = Math.max(span, q.span);
      q = fnArgs.map((f) => applyShape(f, env, q)).reduce(combine, q);
    }
  } else if (fnArgs.length) {
    const scale = name === 'inside' ? values[0]! : name === 'outside' ? 1 / values[0]! : 1;
    const results = fnArgs.map((f) => applyShape(f, env, { poly: base.poly, span: base.span * scale }));
    // The original (except for layer) plus each function's result: covers every, when, off, jux, superimpose…
    p = results.reduce((s, x) => cap(s + x.poly), name === 'layer' ? 0 : base.poly);
    span = Math.max(name === 'layer' ? 0 : span, ...results.map((x) => x.span / scale));
  }
  p = cap(p * joined);
  if (name === 'echo' || name === 'stut') p = cap(p * Math.max(1, values[0] ?? 1));
  if (name === 'voicing' || name === 'voicings') p = cap(p * VOICING_FACTOR);
  return { poly: cap(p + stacked), span: cap(span) };
}

/** One alternative plays at a time: the widest one counts. */
function choiceShape(arg: Node, env: Env): Shape {
  const n = arg as Expression;
  const widest = (xs: Shape[]) => ({ poly: Math.max(1, ...xs.map((x) => x.poly)), span: Math.max(0, ...xs.map((x) => x.span)) });
  if (n.type === 'ArrayExpression') return widest(n.elements.map((el) => shape(el, env)));
  if (n.type === 'ObjectExpression') return widest(n.properties.map((prop) => (prop.type === 'Property' ? shape(prop.value, env) : ONE)));
  return shape(arg, env);
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
  if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'binaryL') {
    return bitsOf(specValues(densitySpec('binaryL'), n.arguments)[0] ?? 2 ** MAX_BITS - 1);
  }
  return STATIC_EVENTS_CEILING;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000));

function miniEvents(value: string): number {
  const m = checkMini(value);
  return m.ok ? m.events : 1;
}

function miniShape(value: string): Shape {
  const m = checkMini(value);
  return m.ok ? { poly: Math.max(1, m.polyphony), span: m.span } : ONE;
}

function miniList(value: string): number {
  const m = checkMini(value);
  return m.ok ? m.listLength : 1;
}
