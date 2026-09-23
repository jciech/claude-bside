// Hard bounds on what model-written code may put into a hap. Applied twice:
//  - server: the analyzer reports violations as errors so the composer can fix them;
//  - client: the performer runs `sanitizeModelValue` INNERMOST — directly on the evaluated part
//    pattern, before its own engine wrappers (orbit, duck, level) — because server analysis only
//    samples a window of cycles.
// Keys are the stored hap-value names (e.g. `.lpf()` stores `cutoff`, `.legato()` stores `clip`,
// `.fm()` stores `fmi`).

export interface Range {
  min: number;
  max: number;
}

export const HAP_LIMITS: Readonly<Record<string, Range>> = {
  gain: { min: 0, max: 1 },
  velocity: { min: 0, max: 1 },
  postgain: { min: 0, max: 1.5 },
  pan: { min: 0, max: 1 },
  room: { min: 0, max: 1 },
  roomsize: { min: 0.1, max: 6 },
  roomfade: { min: 0, max: 6 },
  roomlp: { min: 200, max: 20000 },
  roomdim: { min: 200, max: 20000 },
  dry: { min: 0, max: 1 },
  delay: { min: 0, max: 0.9 },
  delaytime: { min: 0, max: 1 },
  delayfeedback: { min: 0, max: 0.9 },
  cutoff: { min: 20, max: 20000 },
  hcutoff: { min: 20, max: 20000 },
  bandf: { min: 20, max: 20000 },
  resonance: { min: 0, max: 20 },
  hresonance: { min: 0, max: 20 },
  bandq: { min: 0, max: 20 },
  lpenv: { min: -8, max: 8 },
  hpenv: { min: -8, max: 8 },
  bpenv: { min: -8, max: 8 },
  shape: { min: 0, max: 0.9 },
  shapevol: { min: 0, max: 1 },
  distort: { min: 0, max: 3 },
  distortvol: { min: 0, max: 1 },
  crush: { min: 2, max: 16 },
  coarse: { min: 1, max: 32 },
  speed: { min: -4, max: 4 },
  attack: { min: 0, max: 8 },
  decay: { min: 0, max: 8 },
  sustain: { min: 0, max: 1 },
  release: { min: 0, max: 6 },
  clip: { min: 0, max: 8 },
  unison: { min: 1, max: 9 },
  detune: { min: 0, max: 1 },
  penv: { min: -48, max: 48 },
  vib: { min: 0, max: 20 },
  vibmod: { min: 0, max: 12 },
  tremolodepth: { min: 0, max: 1 },
  phaserdepth: { min: 0, max: 1 },
  noise: { min: 0, max: 1 },
  density: { min: 0, max: 1 },
};

/** FM index keys: fmi, fmi2…fmi8 and the operator matrix fmiIJ. */
const FM_INDEX_KEY = /^fmi\d{0,2}$/;
const FM_INDEX_RANGE: Range = { min: 0, max: 12 };

/**
 * Keys model code may never set: engine-owned routing/tempo, per-hap effect chains and modulators
 * (unbounded CPU and loudness bypasses), and code-execution sinks. The validator denies the
 * corresponding methods; this list strips them defensively. Must stay a subset of the validator's
 * denied keys (a shared test asserts it).
 */
export const ENGINE_OWNED_KEYS: ReadonlySet<string> = new Set([
  'orbit',
  'duckorbit',
  'duckdepth',
  'duckattack',
  'duckonset',
  'cps',
  'workletSrc',
  'byteBeatExpression',
  'byteBeatStartTime',
  'analyze',
  'fft',
  'bus',
  'busgain',
  'FX',
  'FXrelease',
  'lfo',
  'env',
  'bmod',
  'source',
  'src',
  'channels',
  'nudge',
  'color',
  'markcss',
]);

/** Maximum onsets per bar for a single part, and for a whole section mix. */
export const MAX_PART_ONSETS_PER_BAR = 64;
export const MAX_MIX_ONSETS_PER_BAR = 192;
/** Performer backstops: haps per part per scheduler tick, and per tick overall. */
export const MAX_PART_HAPS_PER_TICK = 64;
export const MAX_HAPS_PER_TICK = 256;
/** Performer backstop that does not depend on client timing: onsets of one part within one bar. */
export const MAX_PART_ONSETS_PLAYED_PER_BAR = 2 * MAX_PART_ONSETS_PER_BAR;
/** Density-multiplying arguments (fast, ply, `*n`, segment, chop…) must be constants ≤ this. */
export const MAX_DENSITY_FACTOR = 16;

/**
 * What one query of one part may cost before it is stopped (src/strudel/guard.ts): pattern queries
 * made (and patterns built while querying), and haps returned, summed over every level of the pattern.
 * No single query may cover more cycles than haps remain (a leaf builds one per cycle at once).
 */
export interface QueryLimits {
  calls: number;
  haps: number;
}

// Calibration (test/strudel/guard.test.ts keeps it true): every autopilot template in every variant,
// the build riser, the composer's reference-card examples, the fixture snapshot and the validator's
// idiomatic corpus (603 distinct codes), knobs at their defaults, wrapped and queried as the
// performer does them, bars 0–63:
//  - a quarter-bar query (longer than any scheduler tick: 0.25 s of look-ahead at 180 BPM is 0.19 bar;
//    a steady tick is 0.025 bar) took at most 428 calls and 758 haps (glass-drift's pad at half
//    speed re-reads its values over its 4-bar events in every query);
//  - a one-bar query took at most 1356 calls and 1328 haps (idm's arp with iter).
// The limits sit 20× or more above those. Overhead, best of 9 runs of 1/40-bar queries: a budgeted
// query takes 6–18% longer (2–9 µs on 30–300 µs), half of it the check on the span a query covers;
// with no budget active the accessor is within noise (−3…+4%).
/** Queries up to this many bars (every audio tick) get QUERY_BUDGET_TICK. */
export const QUERY_BUDGET_TICK_BARS = 1 / 4;
export const QUERY_BUDGET_TICK: QueryLimits = { calls: 10_000, haps: 16_000 };
/** Longer queries (visual lookahead, preloading, the checker's bars) get this much per bar they span. */
export const QUERY_BUDGET_PER_BAR: QueryLimits = { calls: 30_000, haps: 30_000 };

/** The budget of one query spanning `bars` bars. */
export function queryBudget(bars: number): QueryLimits {
  if (bars <= QUERY_BUDGET_TICK_BARS) return QUERY_BUDGET_TICK;
  const n = Math.max(1, Math.ceil(bars - 1e-9));
  return { calls: n * QUERY_BUDGET_PER_BAR.calls, haps: n * QUERY_BUDGET_PER_BAR.haps };
}

export interface LimitViolation {
  key: string;
  value: unknown;
  range: Range | null;
  reason: 'range' | 'engine-owned' | 'structured';
}

function rangeFor(key: string): Range | undefined {
  return HAP_LIMITS[key] ?? (FM_INDEX_KEY.test(key) ? FM_INDEX_RANGE : undefined);
}

export function findLimitViolations(value: Record<string, unknown>): LimitViolation[] {
  const out: LimitViolation[] = [];
  for (const [key, v] of Object.entries(value)) {
    if (ENGINE_OWNED_KEYS.has(key)) {
      out.push({ key, value: v, range: null, reason: 'engine-owned' });
      continue;
    }
    if (v !== null && (typeof v === 'object' || typeof v === 'function')) {
      out.push({ key, value: typeof v === 'function' ? '[function]' : v, range: null, reason: 'structured' });
      continue;
    }
    const range = rangeFor(key);
    if (range && typeof v === 'number' && (Number.isNaN(v) || v < range.min || v > range.max)) {
      out.push({ key, value: v, range, reason: 'range' });
    }
  }
  return out;
}

/**
 * Returns a copy safe to hand to superdough: engine-owned keys and any object/array/function-valued
 * keys removed, bounded numeric keys clamped. The performer applies this before its own wrappers.
 */
export function sanitizeModelValue<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (ENGINE_OWNED_KEYS.has(key)) continue;
    if (v !== null && (typeof v === 'object' || typeof v === 'function')) continue;
    const range = rangeFor(key);
    if (range && typeof v === 'number') {
      out[key] = Number.isNaN(v) ? range.min : Math.min(range.max, Math.max(range.min, v));
    } else {
      out[key] = v;
    }
  }
  return out as T;
}
