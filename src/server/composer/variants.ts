// Per-section variety for the autopilot: deterministic code variants of a template part (register
// shifts, thinning, half speed, rotation) and colour moves of a scale (the relative mode on the same
// notes, or a parallel mode). Variants are boot-validated per part like the templates themselves.
import { PITCHED_ROLES } from '../../shared/music.ts';
import type { Ensemble, Layer, TemplatePart } from './library/index.ts';
import { parseScale, pitchClass, scaleOf, transposeTonic } from './library/scale.ts';

/** How a template part is played in one section. `base` is the template as written. */
export const VARIANTS = ['base', 'up', 'down', 'thin', 'half', 'iter'] as const;
export type Variant = (typeof VARIANTS)[number];

const OCTAVE = /\$SCALE([1-6])/g;
const VARIED_LAYERS: ReadonlySet<Layer> = new Set(['hook', 'pulse', 'color', 'harmony']);

function octaves(code: string): number[] {
  return [...code.matchAll(OCTAVE)].map((m) => Number(m[1]));
}

const shift = (code: string, by: number) => code.replace(OCTAVE, (_, n: string) => `$SCALE${Number(n) + by}`);

/**
 * The template code for a variant (placeholders kept), or null when the variant doesn't apply:
 * register moves only for pitched non-bass parts written against `$SCALEn`; thinning and rotation only
 * for hook, pulse and colour layers (harmony may move register or slow to half speed).
 */
export function variantCode(part: TemplatePart, variant: Variant): string | null {
  if (variant === 'base') return part.code;
  if (!VARIED_LAYERS.has(part.layer)) return null;
  const pitched = PITCHED_ROLES.has(part.role) && part.role !== 'bass';
  const regs = octaves(part.code);
  switch (variant) {
    case 'up':
      return pitched && regs.length && Math.max(...regs) <= 5 ? shift(part.code, 1) : null;
    case 'down':
      return pitched && regs.length && Math.min(...regs) >= 4 ? shift(part.code, -1) : null;
    case 'thin':
      return part.layer === 'harmony' ? null : `${part.code}\n  .degradeBy(0.5)`;
    case 'half':
      return `${part.code}\n  .slow(2)`;
    case 'iter':
      return pitched && part.layer !== 'harmony' ? `${part.code}\n  .iter(4)` : null;
  }
}

/** Every variant a part could play (validated at boot before the arranger may use it). */
export function partVariants(part: TemplatePart): { variant: Variant; code: string }[] {
  return VARIANTS.flatMap((variant) => {
    const code = variantCode(part, variant);
    return code === null ? [] : [{ variant, code }];
  });
}

// ─── Colour moves ─────────────────────────────────────────────────────────────────────────────

/** Diatonic modes by their degree in the parent major scale (semitones above its tonic). */
const MODE_DEGREE: Record<string, number> = { major: 0, ionian: 0, dorian: 2, phrygian: 4, lydian: 5, mixolydian: 7, minor: 9, aeolian: 9, locrian: 11 };
const PENTATONIC_DEGREE: Record<string, number> = { 'major:pentatonic': 0, 'minor:pentatonic': 9 };
const SAME_NOTES: ReadonlyArray<readonly [string, string]> = [['minor', 'aeolian'], ['major', 'ionian']];

const sameSet = (a: string, b: string) => a === b || SAME_NOTES.some(([x, y]) => (a === x && b === y) || (a === y && b === x));

function degreeTable(mode: string): Record<string, number> | null {
  if (mode in MODE_DEGREE) return MODE_DEGREE;
  if (mode in PENTATONIC_DEGREE) return PENTATONIC_DEGREE;
  return null;
}

/**
 * Scales a section can move to for a change of colour, nearest first: the same notes around another
 * tonic (relative modes), then another mode on the same tonic. Only modes the ensemble is written for.
 * Alternating scales and modes outside the diatonic families have none.
 */
export function colourMoves(ens: Pick<Ensemble, 'modes'>, scale: string): string[] {
  const tokens = parseScale(scale);
  if (!tokens || tokens.length !== 1) return [];
  const { tonic, mode } = tokens[0]!;
  if (pitchClass(tonic) === null) return [];
  const out: string[] = [];
  const table = degreeTable(mode);
  if (table) {
    const parent = -table[mode]!;
    for (const other of ens.modes) {
      if (sameSet(other, mode) || !(other in table)) continue;
      out.push(scaleOf(transposeTonic(tonic, parent + table[other]!), other));
    }
  }
  for (const other of ens.modes) {
    if (sameSet(other, mode) || out.some((s) => s.endsWith(`:${other}`) && s.startsWith(`${tonic}:`))) continue;
    out.push(scaleOf(tonic, other));
  }
  return out;
}
