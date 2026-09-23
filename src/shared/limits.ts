// Hard numeric bounds on hap values. Applied twice:
//  - server: the analyzer reports violations as errors so the composer can fix them;
//  - client: the performer clamps every hap outermost, because server analysis only samples a
//    window of cycles (a spike at cycle 15 would pass an 8-cycle check).
// Keys are the stored hap-value names (e.g. `.lpf()` stores `cutoff`, `.legato()` stores `clip`).

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
  roomsize: { min: 0.1, max: 8 },
  roomfade: { min: 0, max: 8 },
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
  distort: { min: 0, max: 3 },
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
  fmi: { min: 0, max: 12 },
  penv: { min: -48, max: 48 },
  vib: { min: 0, max: 20 },
  vibmod: { min: 0, max: 12 },
  tremolodepth: { min: 0, max: 1 },
  phaserdepth: { min: 0, max: 1 },
  noise: { min: 0, max: 1 },
  duckdepth: { min: 0, max: 1 },
};

/**
 * Keys the model's code may never set; the performer owns routing, tempo and code-execution
 * sinks. The validator rejects the corresponding methods; the clamp strips them defensively.
 */
export const ENGINE_OWNED_KEYS: ReadonlySet<string> = new Set([
  'orbit',
  'duckorbit',
  'cps',
  'workletSrc',
  'byteBeatExpression',
  'byteBeatStartTime',
  'analyze',
  'fft',
  'bus',
  'busgain',
]);

export interface LimitViolation {
  key: string;
  value: number;
  range: Range;
}

export function findLimitViolations(value: Record<string, unknown>): LimitViolation[] {
  const out: LimitViolation[] = [];
  for (const [key, range] of Object.entries(HAP_LIMITS)) {
    const v = value[key];
    if (typeof v === 'number' && (v < range.min || v > range.max || Number.isNaN(v))) {
      out.push({ key, value: v, range });
    }
  }
  return out;
}

/** Returns a copy with every bounded numeric key clamped and engine-owned keys removed. */
export function clampHapValue<T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = { ...value };
  for (const key of ENGINE_OWNED_KEYS) delete out[key];
  for (const [key, range] of Object.entries(HAP_LIMITS)) {
    const v = out[key];
    if (typeof v !== 'number') continue;
    out[key] = Number.isNaN(v) ? range.min : Math.min(range.max, Math.max(range.min, v));
  }
  return out as T;
}
