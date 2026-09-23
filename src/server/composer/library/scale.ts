// Scale strings as sections carry them: "D:dorian", "D4:minor:pentatonic", or a per-bar alternation
// "<D:dorian G:mixolydian>". Library code is written in scale degrees against `$SCALE` placeholders
// and filled here, so the same ensemble plays in any key the movement is in.

export interface ScaleToken {
  tonic: string;
  octave: number | null;
  /** Colon-joined mode, lower-case: "dorian", "minor:pentatonic", "purvi:raga". */
  mode: string;
}

const TONIC = /^([A-Ga-g])([#b]?)(\d)?$/;
const PLACEHOLDER = /\$SCALE([1-6])?/g;

/** The tonics, one spelling each (Strudel reads both, flats read better in liner notes). */
export const TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;

/** Tokens of a scale string, or null when any token isn't `Tonic[octave]:mode`. */
export function parseScale(scale: string): ScaleToken[] | null {
  const words = scale.replace(/[<>[\]]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const out: ScaleToken[] = [];
  for (const word of words) {
    const [head, ...rest] = word.split(':');
    const m = TONIC.exec(head ?? '');
    if (!m || !rest.length || rest.some((r) => !/^[a-z0-9#'-]+$/i.test(r))) return null;
    out.push({ tonic: m[1]!.toUpperCase() + m[2], octave: m[3] ? Number(m[3]) : null, mode: rest.join(':').toLowerCase() });
  }
  return out;
}

/** The same scale with every tonic moved to `octave` (null drops explicit octaves). */
export function withOctave(scale: string, octave: number | null): string {
  return scale.replace(/(^|[\s<[])([A-Ga-g][#b]?)\d?(?=:)/g, (_, before: string, tonic: string) => `${before}${tonic}${octave ?? ''}`);
}

/** Replaces `$SCALE` / `$SCALEn` in library code with `scale` (tonic in octave n). */
export function fillScale(code: string, scale: string): string {
  return code.replace(PLACEHOLDER, (_, octave: string | undefined) => withOctave(scale, octave ? Number(octave) : null));
}

export const scaleOf = (tonic: string, mode: string): string => `${tonic}:${mode}`;

/** Semitone of a tonic (C = 0), or null. */
export function pitchClass(tonic: string): number | null {
  const m = TONIC.exec(tonic);
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1]!.toLowerCase() as 'c'];
  return (base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
}

/** The tonic `semitones` above `tonic`, spelled from TONICS. */
export function transposeTonic(tonic: string, semitones: number): string {
  const pc = pitchClass(tonic) ?? 0;
  return TONICS[(((pc + semitones) % 12) + 12) % 12]!;
}
