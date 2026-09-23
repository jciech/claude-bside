// The autopilot's arranger: realises a section role from an ensemble with a recipe of moves per
// layer — which layers play, when they enter and leave, how loud, which code variant, and where the
// knobs sit and travel — and a transition and a liner note. Parts the section before was already
// playing continue (same code → carried, no restart). Each role has several recipes; the movement
// takes them in turn, so a role never comes back arranged the same way.
import { MAX_PARTS_PER_SECTION, PERCUSSIVE_ROLES, SECTION_LENGTHS, type SectionLength, type SectionRole, type Span } from '../../shared/music.ts';
import type { Automation, Knob, PartPlan, SectionPlan } from '../../shared/plan.ts';
import { CROSSFADE_MAX_BARS } from '../../shared/schedule.ts';
import type { Ensemble, Layer, TemplatePart } from './library/index.ts';
import { fillScale } from './library/scale.ts';
import { variantCode, type Variant } from './variants.ts';

/** What the arranger needs to know about the section before (a SectionSummary fits). */
export interface PrevView {
  bars: number;
  role?: SectionRole;
  scale?: string;
  parts: readonly { id: string; code: string; exitBar: number | null; level: number; knobValuesAtEnd: Readonly<Record<string, number>> }[];
}

export interface ArrangeInput {
  ensemble: Ensemble;
  role: SectionRole;
  /** The movement's home key. */
  scale: string;
  /**
   * Its away keys (related modes), preferred first, for recipes that leave home: the first that
   * differs from the section before, so leaving home is always a change. Absent or empty = home.
   */
  away?: readonly string[];
  bpm: number;
  /** Ramp from the previous tempo over this many bars (0 = none). */
  rampBars: number;
  bars: SectionLength;
  prev: PrevView | null;
  /** The previous section was this ensemble (so its parts can continue). */
  sameEnsemble: boolean;
  /** Leave out percussive parts (a beatless bridge lets the tempo jump). */
  beatless: boolean;
  targets: { intensity: Span; brightness: Span } | null;
  name: string;
  seed: number;
  /**
   * How many sections of this role the movement already has: each one takes the next recipe, so
   * the same role comes back arranged differently. Absent = a recipe chosen by seed.
   */
  occurrence?: number;
  /** Where the movement starts in the role's recipes (a per-movement offset). */
  rotation?: number;
  /** Code variants each part may play (boot-validated), by part id; absent = any that applies. */
  variants?: ReadonlyMap<string, readonly Variant[]>;
}

export interface Arranged {
  section: SectionPlan;
  /** The section as the next one sees it (filled code for carried parts too). */
  view: PrevView;
}

/** Where a knob rests or travels: `dark` is its calm end, `bright` its lively one (by `follows`). */
type KnobMove = 'hold' | 'dark' | 'open' | 'sweep' | 'dip' | 'bright' | 'close';
type Shape = 'swell' | 'rise' | 'fadeOut' | 'fadeIn';

interface Move {
  /** Entry as a fraction of the section (fresh parts only). */
  enter?: number;
  /** Exit as a fraction; 1 = the last bar. */
  exit?: number;
  /** × the template's fader. */
  level?: number;
  shape?: Shape;
  /** Code variants to choose from (seeded); `base` when none applies. */
  variants?: Variant[];
  knob?: KnobMove;
  /** Only one part of a layer with several (seeded). */
  one?: boolean;
  /** Leave out percussive parts of this layer (pulse hats in a quiet section). */
  tonal?: boolean;
}

interface Recipe {
  layers: Partial<Record<Layer, Move>>;
  /** Played in the movement's away key (a related mode) instead of its home key. */
  away?: boolean;
}

// Drops push every fader up a little: the loudest point of the side.
const DROP_A: Recipe = {
  layers: {
    beat: { level: 1.15 },
    back: { level: 1.15 },
    pulse: { level: 1.15 },
    low: { level: 1.15, knob: 'bright' },
    harmony: { level: 1.15, knob: 'bright' },
    hook: { level: 1.15, variants: ['up'] },
    color: { level: 0.9 },
  },
};
const DROP_B: Recipe = {
  layers: {
    beat: { level: 1.15 },
    back: { level: 1.15 },
    pulse: { one: true, level: 1.15 },
    low: { level: 1.15 },
    harmony: { level: 1.15, knob: 'hold' },
    hook: { level: 1.15, variants: ['iter', 'down'] },
    color: { level: 1.15 },
  },
  away: true,
};
// Drums, bass and hook hit first; the chords arrive four bars in.
const DROP_C: Recipe = {
  layers: {
    beat: { level: 1.15 },
    back: { level: 1.15 },
    pulse: { level: 1.15 },
    low: { level: 1.15, knob: 'bright' },
    harmony: { enter: 0.25, shape: 'fadeIn', level: 0.9 },
    hook: { level: 1.15, variants: ['half', 'thin'] },
    color: { level: 0.7 },
  },
};

/**
 * Recipes per role, taken in turn through a movement so a role never comes back the same: another
 * key, another hook variant, the harmony held back. Intro: sparse and rising. Groove: the full
 * band. Build: rising toward a drop that brings the bass back. Drop: everything, restarted after a
 * breath or a riser. Breakdown and interlude: drums and bass away, harmony down and darker. Bridge:
 * the away key and another colour. Outro: parts leave one by one while harmony and colour fade.
 */
const RECIPES: Record<SectionRole, Recipe[]> = {
  intro: [
    { layers: { harmony: { level: 0.85, shape: 'swell', knob: 'open' }, color: { enter: 0.25, level: 0.7, shape: 'fadeIn' }, pulse: { enter: 0.5, shape: 'fadeIn' }, low: { enter: 0.75 } } },
    { layers: { color: { level: 0.8 }, harmony: { enter: 0.25, shape: 'fadeIn', knob: 'open' }, hook: { enter: 0.5, level: 0.6, variants: ['thin', 'half'], shape: 'fadeIn' }, low: { enter: 0.75 } } },
    { layers: { harmony: { level: 0.85, shape: 'swell', knob: 'open' }, pulse: { enter: 0.25, level: 0.7, shape: 'fadeIn' }, back: { enter: 0.75, level: 0.7 }, low: { enter: 0.5 } } },
  ],
  groove: [
    { layers: { beat: {}, back: {}, pulse: {}, low: {}, harmony: { knob: 'hold' }, color: { level: 0.7 }, hook: { enter: 0.5, variants: ['base'] } } },
    { layers: { beat: {}, back: {}, pulse: { one: true }, low: {}, harmony: { knob: 'bright' }, color: {}, hook: { variants: ['up', 'iter', 'base'] } }, away: true },
    // The chords hold back for the first quarter: rhythm, bass and hook carry it until they return.
    { layers: { beat: {}, back: {}, pulse: {}, low: {}, harmony: { enter: 0.25, shape: 'fadeIn', knob: 'hold' }, color: { level: 0.85 }, hook: { variants: ['iter', 'half', 'up'] } } },
    // Tighter: one pulse, the colour back, the harmony an octave away, the hook varied.
    { layers: { beat: {}, back: { level: 0.8 }, pulse: { one: true, level: 0.8 }, low: { knob: 'bright' }, harmony: { level: 0.85, variants: ['up', 'down'] }, color: { level: 0.7 }, hook: { enter: 0.25, variants: ['thin', 'half', 'iter'] } } },
  ],
  // Strip back to the harmony and the riser, then layer up; kick and bass wait for the drop.
  build: [
    { layers: { harmony: { level: 0.85, shape: 'rise', knob: 'sweep' }, pulse: { enter: 0.25, shape: 'rise' }, back: { enter: 0.5, level: 0.8 }, hook: { enter: 0.75, variants: ['base', 'up'] } } },
    {
      layers: { harmony: { level: 0.85, shape: 'rise', knob: 'sweep' }, hook: { enter: 0.75, variants: ['thin', 'half'] }, pulse: { enter: 0.5, shape: 'rise' }, back: { enter: 0.75, shape: 'rise' }, color: { level: 0.6 } },
      away: true,
    },
  ],
  drop: [DROP_A, DROP_B, DROP_C],
  breakdown: [
    { layers: { harmony: { level: 0.6, knob: 'dip', variants: ['half'] }, hook: { enter: 0.25, level: 0.7, variants: ['thin', 'half'] }, color: { level: 0.55 }, low: { exit: 0.25 } } },
    { layers: { harmony: { level: 0.6, knob: 'dark', variants: ['half', 'base'] }, color: { level: 0.6 }, hook: { enter: 0.5, level: 0.6, variants: ['half', 'thin'] } }, away: true },
  ],
  bridge: [
    { layers: { harmony: { level: 0.8, knob: 'hold' }, color: {}, low: {}, hook: { variants: ['up', 'iter', 'base'] }, back: { level: 0.8 } }, away: true },
    { layers: { color: {}, pulse: { tonal: true, variants: ['half', 'iter', 'base'] }, low: {}, hook: { variants: ['down', 'iter', 'half'] }, harmony: { enter: 0.25, level: 0.7, knob: 'dark', shape: 'fadeIn' } }, away: true },
  ],
  interlude: [
    { layers: { harmony: { level: 0.55, knob: 'dark' }, color: { level: 0.6 }, hook: { enter: 0.5, level: 0.5, variants: ['thin'] } } },
    { layers: { color: { level: 0.65 }, harmony: { level: 0.55, knob: 'dark' }, pulse: { tonal: true, enter: 0.5, level: 0.5, variants: ['half', 'thin'] } }, away: true },
  ],
  outro: [
    { layers: { beat: { exit: 0.5 }, back: { exit: 0.5 }, pulse: { exit: 0.75 }, low: { exit: 0.75 }, harmony: { shape: 'fadeOut', knob: 'close' }, color: { shape: 'fadeOut' }, hook: { exit: 0.25 } } },
    { layers: { beat: { exit: 0.25 }, back: { exit: 0.5 }, pulse: { exit: 0.5 }, low: { exit: 0.5 }, hook: { exit: 0.75, variants: ['thin', 'base'] }, harmony: { shape: 'fadeOut', knob: 'close' }, color: { shape: 'fadeOut' } } },
  ],
  transition: [{ layers: { harmony: {}, color: {}, pulse: {} } }],
  reprise: [DROP_A, DROP_B, DROP_C],
};

/** Roles whose parts restart at bar 0, so a breath or riser before them is heard. */
const RESTARTS: ReadonlySet<SectionRole> = new Set(['drop', 'reprise']);

/** Roughly how long each role lasts, in seconds; bars follow from the tempo. */
const ROLE_SECONDS: Record<SectionRole, number> = {
  intro: 45,
  groove: 70,
  build: 30,
  drop: 60,
  breakdown: 40,
  bridge: 45,
  interlude: 40,
  outro: 40,
  transition: 15,
  reprise: 60,
};

const PLAYABLE_LENGTHS = SECTION_LENGTHS.filter((l) => l >= 16);

/** Composed length for a role at a tempo: the playable length nearest its duration (≥ `minBars`). */
export function barsFor(role: SectionRole, bpm: number, minBars = 0): SectionLength {
  if (role === 'transition') return 8;
  const want = (ROLE_SECONDS[role] * bpm) / 240;
  const nearest = PLAYABLE_LENGTHS.reduce((best, l) => (Math.abs(l - want) < Math.abs(best - want) ? l : best), PLAYABLE_LENGTHS[0]!);
  return PLAYABLE_LENGTHS.find((l) => l >= Math.max(nearest, minBars)) ?? 64;
}

/** Seconds a role lasts at a tempo, as barsFor composes it. */
export const secondsFor = (role: SectionRole, bpm: number): number => (barsFor(role, bpm) * 240) / bpm;

/**
 * Offsets from the ensemble's mood (intensity), and density/tension spans per role, roughly what
 * the checker measures for the recipes (tension only rises when a section gets brighter and denser
 * toward its end, which the build's riser does).
 */
const SHAPES: Record<SectionRole, { intensity: [number, number]; density: [number, number]; tension: [number, number] }> = {
  intro: { intensity: [-0.25, -0.1], density: [0.35, 0.6], tension: [0.05, 0.15] },
  groove: { intensity: [0, 0], density: [0.85, 0.9], tension: [0.06, 0.08] },
  build: { intensity: [-0.15, 0.1], density: [0.7, 0.95], tension: [0.1, 0.5] },
  drop: { intensity: [0.05, 0.05], density: [0.95, 0.95], tension: [0.1, 0.1] },
  breakdown: { intensity: [-0.2, -0.2], density: [0.5, 0.45], tension: [0.05, 0.08] },
  bridge: { intensity: [-0.1, -0.1], density: [0.7, 0.7], tension: [0.05, 0.08] },
  interlude: { intensity: [-0.2, -0.2], density: [0.4, 0.45], tension: [0.03, 0.06] },
  outro: { intensity: [-0.05, -0.2], density: [0.8, 0.45], tension: [0.08, 0.05] },
  transition: { intensity: [-0.1, -0.05], density: [0.6, 0.6], tension: [0.05, 0.15] },
  reprise: { intensity: [0.05, 0.05], density: [0.95, 0.95], tension: [0.1, 0.1] },
};

const RISER: TemplatePart = { id: 'riser', role: 'texture', layer: 'color', code: '', level: 0.7 };
/** Riser fader in proportion to the band: a noise sweep shouldn't outshout a quiet ensemble's drop. */
const riserLevel = (ensemble: Ensemble) => round2(0.4 + 0.4 * ensemble.mood.intensity);

/**
 * The build's riser, synth-only so it works with every ensemble: a noise roll that doubles in
 * density and opens its high-pass across the section. Pattern time starts at the section's bar 0,
 * so the ramps span exactly `bars`.
 */
export function riserCode(bars: number): string {
  const q = bars / 4;
  return [
    `s("white*<4!${q} 8!${q} 16!${2 * q}>")`,
    `  .hpf(saw.range(200, 10000).slow(${bars}))`,
    '  .decay(0.06)',
    '  .sustain(0)',
    `  .gain(saw.range(0.02, 0.4).slow(${bars}))`,
    '  .pan(sine.range(0.35, 0.65).fast(2))',
  ].join('\n');
}

const clamp01 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function targetsFor(role: SectionRole, ensemble: Ensemble, expected: ArrangeInput['targets']): SectionPlan['targets'] {
  const shape = SHAPES[role];
  const mood = ensemble.mood;
  const span = (pair: [number, number]): Span => ({ start: clamp01(pair[0]), end: clamp01(pair[1]) });
  return {
    intensity: expected?.intensity ?? span([mood.intensity + shape.intensity[0], mood.intensity + shape.intensity[1]]),
    brightness: expected?.brightness ?? span([mood.brightness, mood.brightness]),
    density: span(shape.density),
    tension: span(shape.tension),
  };
}

/** A small stable hash for seeded choices that differ per part. */
function mix(seed: number, text: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

/**
 * The recipe for a role and whether it leaves home: the movement takes the recipes in turn from its
 * `rotation`, and each full pass through them swaps home and away, so a recipe never comes back in
 * the same key. Bridges always leave.
 */
export function recipeFor(role: SectionRole, occurrence: number | undefined, rotation: number, seed: number): { recipe: Recipe; away: boolean } {
  const recipes = RECIPES[role];
  const recipe = recipes[(occurrence === undefined ? seed : rotation + occurrence) % recipes.length]!;
  const flip = occurrence !== undefined && Math.floor(occurrence / recipes.length) % 2 === 1;
  return { recipe, away: role === 'bridge' || (!!recipe.away !== flip) };
}

// ─── Knobs ──────────────────────────────────────────────────────────────────────────────────────

/** The knob's lively end: toward max unless it follows an inverted axis (more send when calm). */
const liveEnd = (k: Knob) => (k.follows.startsWith('-') ? k.min : k.max);
const calmEnd = (k: Knob) => (k.follows.startsWith('-') ? k.max : k.min);
/** A knob value as plans carry it: rounded, then clamped, so a range like 0.125–0.875 is never left. */
export const knobValue = (k: Knob, v: number) => Math.min(k.max, Math.max(k.min, round2(v)));
const toward = (k: Knob, end: number, t: number) => knobValue(k, k.default + (end - k.default) * t);

interface KnobPlan {
  /** Declared default for this section (what the checker measures, and fresh parts start from). */
  rest: number;
  lanes: Automation[];
}

/**
 * Where a knob rests and how it travels. `start` is where a carried part's knob already is (null
 * for fresh parts, which start at `rest`); a carried knob glides to its resting value in two bars.
 */
function knobPlan(k: Knob, move: KnobMove, bars: number, start: number | null, jitter: number): KnobPlan {
  const curve: Automation['curve'] = k.min > 0 && k.name === 'cut' ? 'exp' : 'linear';
  const lane = (fromBar: number, toBar: number, from: number, to: number): Automation => ({ target: `knob:${k.name}`, fromBar, toBar, from: knobValue(k, from), to: knobValue(k, to), curve });
  const dark = toward(k, calmEnd(k), 0.65);
  const settle = (rest: number): KnobPlan => ({ rest, lanes: start !== null && Math.abs(start - rest) > 1e-6 ? [lane(0, Math.min(2, bars), start, rest)] : [] });
  const half = Math.max(1, Math.floor(bars / 2));
  switch (move) {
    case 'hold':
      return settle(toward(k, jitter >= 0 ? liveEnd(k) : calmEnd(k), Math.abs(jitter)));
    case 'bright':
      return settle(toward(k, liveEnd(k), 0.45));
    case 'dark':
      return settle(dark);
    case 'open': {
      const from = start ?? dark;
      return { rest: dark, lanes: from !== k.default ? [lane(0, bars, from, k.default)] : [] };
    }
    case 'sweep': {
      const from = start ?? k.default;
      const to = knobValue(k, liveEnd(k));
      return { rest: knobValue(k, from), lanes: to !== from ? [lane(0, bars, from, to)] : [] };
    }
    case 'dip': {
      const from = start ?? dark;
      return { rest: dark, lanes: [lane(0, half, from, dark), lane(half, bars, dark, k.default)] };
    }
    case 'close': {
      const from = start ?? k.default;
      const to = toward(k, calmEnd(k), 0.9);
      return { rest: knobValue(k, from), lanes: to !== from ? [lane(0, bars, from, to)] : [] };
    }
  }
}

// ─── Arranging ──────────────────────────────────────────────────────────────────────────────────

interface Draft {
  tp: TemplatePart;
  variant: Variant;
  code: string;
  /** Same code as the part the section before was still playing. */
  carried: boolean;
  restart: boolean;
  level: number;
  enterBar: number;
  exitBar: number | null;
  knobs: Knob[];
  automation: Automation[];
  knobValuesAtEnd: Record<string, number>;
}

function chooseParts(input: ArrangeInput, recipe: Recipe): { tp: TemplatePart; move: Move }[] {
  const { ensemble, seed } = input;
  const quiet = input.role === 'breakdown' || input.role === 'interlude';
  const out: { tp: TemplatePart; move: Move }[] = [];
  for (const layer of Object.keys(recipe.layers) as Layer[]) {
    const move = recipe.layers[layer]!;
    let parts = ensemble.parts.filter((p) => p.layer === layer);
    if (input.beatless || move.tonal || quiet) parts = parts.filter((p) => !PERCUSSIVE_ROLES.has(p.role));
    if (move.one && parts.length > 1) parts = [parts[mix(seed, layer) % parts.length]!];
    for (const tp of parts) out.push({ tp, move });
  }
  const order = new Map(ensemble.parts.map((p, i) => [p.id, i]));
  out.sort((a, b) => order.get(a.tp.id)! - order.get(b.tp.id)!);
  if (out.length) return out;
  const tonal = ensemble.parts.filter((p) => !PERCUSSIVE_ROLES.has(p.role)).slice(0, 2);
  return (tonal.length ? tonal : ensemble.parts.slice(0, 1)).map((tp) => ({ tp, move: {} }));
}

function pickVariant(input: ArrangeInput, tp: TemplatePart, wanted: readonly Variant[] | undefined): Variant {
  if (!wanted?.length) return 'base';
  const allowed = input.variants?.get(tp.id);
  const usable = wanted.filter((v) => (allowed ? allowed.includes(v) : true) && variantCode(tp, v) !== null);
  return usable.length ? usable[mix(input.seed, tp.id) % usable.length]! : 'base';
}

function levelLanes(shape: Shape | undefined, level: number, enterBar: number, bars: number): Automation[] {
  const lane = (fromBar: number, toBar: number, from: number, to: number, curve: Automation['curve']): Automation => ({ target: 'level', fromBar, toBar, from: round2(from), to: round2(to), curve });
  switch (shape) {
    case 'swell':
      return [lane(enterBar, Math.min(bars, enterBar + Math.max(2, Math.floor(bars / 2))), level * 0.3, level, 'exp')];
    case 'rise':
      return [lane(0, bars, level * 0.6, level, 'exp')];
    case 'fadeOut':
      return [lane(Math.floor(bars / 2), bars, level, level * 0.05, 'exp')];
    case 'fadeIn':
      return enterBar > 0 ? [lane(enterBar, Math.min(bars, enterBar + 2), level * 0.1, level, 'exp')] : [lane(0, Math.min(bars, 4), level * 0.2, level, 'exp')];
    default:
      return [];
  }
}

export function arrangeSection(input: ArrangeInput): Arranged {
  const { ensemble, role, bars, prev } = input;
  const { recipe, away } = recipeFor(role, input.occurrence, input.rotation ?? 0, input.seed);
  const scale = (away && input.away?.find((s) => s !== prev?.scale)) || input.scale;
  const prevParts = new Map((prev?.parts ?? []).map((p) => [p.id, p]));
  const restarts = RESTARTS.has(role);
  const barAt = (fraction: number) => Math.min(bars - 1, Math.max(1, Math.round(fraction * bars)));
  const jitter = [0, 0.3, -0.3][input.seed % 3]!;

  const chosen = chooseParts(input, recipe);
  // Something plays from bar 0: when the recipe opens on a layer this ensemble lacks, the part it
  // brings in first comes forward (before its level lanes are shaped around the entry).
  const entries = chosen.map(({ move }) => (move.enter === undefined ? 0 : barAt(move.enter)));
  const opener = entries.includes(0) ? -1 : entries.indexOf(Math.min(...entries));
  const drafts: Draft[] = chosen.map(({ tp, move }, i) => {
    const entry = i === opener ? 0 : entries[i]!;
    const variant = pickVariant(input, tp, move.variants);
    const code = fillScale(variantCode(tp, variant) ?? tp.code, scale);
    const before = prevParts.get(tp.id);
    const carried = !!before && before.code === code && before.exitBar === null;
    // A part the section before was playing steps out and re-enters later by restarting.
    const restart = carried && (restarts || entry > 0);
    const level = round2(Math.min(1, tp.level * (move.level ?? 1)));
    const enterBar = carried && !restart ? 0 : entry;
    const rawExit = move.exit === undefined ? null : move.exit >= 1 ? bars - 1 : barAt(move.exit);
    const exitBar = rawExit !== null && rawExit <= enterBar ? null : rawExit;

    const knobs: Knob[] = [];
    const automation: Automation[] = [];
    const knobValuesAtEnd: Record<string, number> = {};
    for (const k of tp.knobs ?? []) {
      const inherited = carried ? (before.knobValuesAtEnd[k.name] ?? null) : null;
      const plan = knobPlan(k, move.knob ?? (role === 'build' ? 'sweep' : 'hold'), bars, inherited === null ? null : knobValue(k, inherited), move.knob ? jitter : 0);
      knobs.push({ ...k, default: plan.rest });
      automation.push(...plan.lanes);
      knobValuesAtEnd[k.name] = plan.lanes.length ? plan.lanes[plan.lanes.length - 1]!.to : (inherited ?? plan.rest);
    }
    const shaped = levelLanes(move.shape, level, enterBar, bars);
    const settles = carried && !restart && !shaped.some((a) => a.fromBar === 0) && Math.abs(20 * Math.log10(level / Math.max(0.01, before.level))) >= 1;
    if (settles) automation.push({ target: 'level', fromBar: 0, toBar: Math.min(2, bars), from: round2(before.level), to: level, curve: 'linear' });
    automation.push(...shaped);
    return { tp, variant, code, carried, restart, level, enterBar, exitBar, knobs, automation, knobValuesAtEnd };
  });

  if (role === 'build' && drafts.length < MAX_PARTS_PER_SECTION && !drafts.some((d) => d.tp.id === RISER.id)) {
    const code = riserCode(bars);
    drafts.push({ tp: RISER, variant: 'base', code, carried: false, restart: false, level: riserLevel(ensemble), enterBar: 0, exitBar: null, knobs: [], automation: [], knobValuesAtEnd: {} });
  }
  const ids = new Set(drafts.map((d) => d.tp.id));
  const parts: PartPlan[] = drafts.map((d) => {
    const targets = (d.tp.duck?.targets ?? []).filter((t) => ids.has(t) && t !== d.tp.id);
    return {
      id: d.tp.id,
      role: d.tp.role,
      code: d.carried ? null : d.code,
      restart: d.restart,
      chromatic: false,
      level: d.level,
      enterBar: d.enterBar,
      exitBar: d.exitBar,
      knobs: d.knobs,
      automation: d.automation,
      duck: d.tp.duck && targets.length ? { targets, depth: d.tp.duck.depth, releaseSec: d.tp.duck.releaseSec } : null,
    };
  });

  const keyMoved = !!prev?.scale && prev.scale !== scale && input.sameEnsemble;
  const section: SectionPlan = {
    name: input.name,
    role,
    bars,
    bpm: input.bpm,
    tempoRampBars: Math.min(bars, input.rampBars),
    tempoRampAt: 'start',
    scale,
    chords: null,
    targets: targetsFor(role, ensemble, input.targets),
    transitionIn: transitionFor(input, drafts, keyMoved),
    parts,
    reprise: null,
    publicNote: linerNote(
      ensemble,
      role,
      drafts.filter((d) => d.tp.id !== RISER.id).map((d) => ({ layer: d.tp.layer, enterBar: d.enterBar, exitBar: d.exitBar, variant: d.variant })),
      prev !== null && !input.sameEnsemble,
      scale !== input.scale ? scale : null,
    ),
  };
  const view: PrevView = {
    bars,
    role,
    scale,
    parts: drafts.map((d) => ({ id: d.tp.id, code: d.code, exitBar: d.exitBar, level: d.level, knobValuesAtEnd: d.knobValuesAtEnd })),
  };
  return { section, view };
}

function transitionFor(input: ArrangeInput, drafts: readonly Draft[], keyMoved: boolean): SectionPlan['transitionIn'] {
  const { prev, role, bars, seed } = input;
  if (!prev || drafts.every((d) => d.carried && !d.restart)) return { type: 'cut', bars: 0 };
  const room = Math.floor(Math.min(CROSSFADE_MAX_BARS, bars / 2, prev.bars / 2));
  const preRoll = (n: number) => Math.max(1, Math.min(n, prev.bars));
  if (input.rampBars > 0 || input.beatless) return { type: 'filter', bars: preRoll(4) };
  if (!input.sameEnsemble) return room >= 1 ? { type: 'crossfade', bars: Math.min(room, 8) } : { type: 'cut', bars: 0 };
  switch (role) {
    case 'drop':
    case 'reprise':
      return prev.role === 'build' && seed % 2 === 0 ? { type: 'breath', bars: 1 } : { type: 'riser', bars: preRoll(prev.role === 'build' ? 4 : 2) };
    case 'breakdown':
      return { type: 'filter', bars: preRoll(4) };
    case 'interlude':
      return room >= 1 ? { type: 'crossfade', bars: Math.min(room, 4) } : { type: 'cut', bars: 0 };
    case 'bridge':
      return keyMoved ? { type: 'filter', bars: preRoll(2) } : { type: 'cut', bars: 0 };
    case 'groove':
      return prev.role === 'breakdown' || prev.role === 'interlude' || prev.role === 'bridge' ? (seed % 2 === 0 ? { type: 'riser', bars: preRoll(2) } : { type: 'cut', bars: 0 }) : { type: 'cut', bars: 0 };
    default:
      return { type: 'cut', bars: 0 };
  }
}

// ─── Liner notes ────────────────────────────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const VARIANT_WORDS: Partial<Record<Variant, string>> = { up: 'an octave up', down: 'an octave down', half: 'at half speed', thin: 'thinned out', iter: 'turning its phrase around' };

/** A short, specific note in the autopilot's voice, from the ensemble's layer labels. */
export function linerNote(
  ensemble: Ensemble,
  role: SectionRole,
  present: { layer: Layer; enterBar: number; exitBar: number | null; variant?: Variant }[],
  arriving: boolean,
  movedTo: string | null = null,
): string {
  const label = (layer: Layer) => (present.some((p) => p.layer === layer) ? ensemble.labels[layer] : undefined);
  const at = (layer: Layer) => present.find((p) => p.layer === layer);
  const all = present.map((p) => ensemble.labels[p.layer]).filter((l, i, a): l is string => !!l && a.indexOf(l) === i);
  const hookWord = () => {
    const h = at('hook');
    const word = h?.variant ? VARIANT_WORDS[h.variant] : undefined;
    return h && word && ensemble.labels.hook ? `, ${ensemble.labels.hook} ${word}` : '';
  };
  const opener = arriving ? `${ensemble.name}: ` : '';
  let text: string;
  switch (role) {
    case 'intro': {
      const first = label('harmony') ?? label('color') ?? all[0] ?? 'a single voice';
      const later = [label('pulse'), label('hook'), label('back'), label('low')].filter((l): l is string => !!l && l !== first);
      text = `It opens on ${first}${later.length ? `, with ${list(later)} joining along the way` : ''}.`;
      break;
    }
    case 'groove': {
      const base = [label('beat'), label('low')].filter((l): l is string => !!l);
      const hook = at('hook');
      text = `Into the groove: ${list(base.length ? base : all.slice(0, 2))}${label('harmony') ? ` under ${label('harmony')}` : ''}${hook && hook.enterBar > 0 ? `, and from bar ${hook.enterBar} ${ensemble.labels.hook} in answer` : hookWord()}.`;
      break;
    }
    case 'build': {
      const waiting = [ensemble.labels.beat, ensemble.labels.low].filter((l, i): l is string => !!l && !label((['beat', 'low'] as const)[i]!));
      text = `Winding it up: a noise riser climbs, filters open, ${label('pulse') ?? 'the rhythm'} thickening${waiting.length ? `, ${list(waiting)} waiting for the drop` : ''}.`;
      break;
    }
    case 'drop':
    case 'reprise':
      text = `Everything at once: ${list(all.slice(0, 4))}${hookWord()}.`;
      break;
    case 'breakdown':
      text = `The drums fall away, leaving ${list([label('harmony'), label('hook')].filter((l): l is string => !!l)) || all[0]} in the air.`;
      break;
    case 'bridge':
      text = `A side road${movedTo ? ` into ${movedTo.replace(/:/g, ' ')}` : ''}: ${list(all.slice(0, 3))}${hookWord()}.`;
      break;
    case 'interlude':
      text = `A breath between songs: ${list(all.slice(0, 3))}.`;
      break;
    case 'outro':
      text = `Winding down: the parts leave one by one, and last of all ${label('harmony') ?? all[all.length - 1] ?? 'the last voice'} fades out.`;
      break;
    case 'transition':
      text = `Crossing over on ${list(all.slice(0, 2))}.`;
      break;
  }
  return (opener ? `${opener}${text.charAt(0).toLowerCase()}${text.slice(1)}` : cap(text)).slice(0, 280);
}
