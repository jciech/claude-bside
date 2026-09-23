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
