// Pure numeric helpers for hap analysis: metre, pitch, periodicity and the descriptor formulas
// (steering-design §3.5, weights from the validator prototype's energyOf).
import type { Register } from '../shared/analysis.ts';

export const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
export const round = (x: number, digits = 3): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const midiName = (midi: number): string => {
  const m = Math.round(midi);
  return `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
};
export const pitchClass = (midi: number): number => ((Math.round(midi) % 12) + 12) % 12;

export function registerOf(medianMidi: number): Register {
  if (medianMidi < 36) return 'sub';
  if (medianMidi < 48) return 'bass';
  if (medianMidi < 60) return 'low-mid';
  if (medianMidi < 72) return 'mid';
  if (medianMidi < 84) return 'high';
  return 'very-high';
}

/** 16th-note step (0..15) nearest to a position inside the bar (0..1). */
export const stepOf = (pos: number): number => Math.round(pos * 16) % 16;

/** Longuet-Higgins/Lee style syncopation of one bar's onset steps (0..1). */
const METRIC_WEIGHT = [5, 1, 2, 1, 3, 1, 2, 1, 4, 1, 2, 1, 3, 1, 2, 1];
export function syncopation(steps: number[]): number {
  const s = [...new Set(steps)].sort((a, b) => a - b);
  if (s.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const a = s[i]!;
    const b = i + 1 < s.length ? s[i + 1]! : s[0]! + 16;
    let strongest = 0;
    for (let j = a + 1; j < b; j++) strongest = Math.max(strongest, METRIC_WEIGHT[j % 16]!);
    if (strongest > METRIC_WEIGHT[a]!) total += strongest - METRIC_WEIGHT[a]!;
  }
  return clamp01(total / (s.length * 4));
}

/** Histogram normalised so the busiest step is 1. */
export function normalise(hist: number[]): number[] {
  const max = Math.max(0, ...hist);
  return hist.map((x) => (max ? round(x / max) : 0));
}

/** Smallest p ≤ n/2 with signature[i] = signature[i + p] for every bar, or null. */
export function periodOf(signatures: string[]): number | null {
  const n = signatures.length;
  for (let p = 1; p <= Math.floor(n / 2); p++) {
    let ok = true;
    for (let i = 0; i + p < n && ok; i++) ok = signatures[i] === signatures[i + p];
    if (ok) return p;
  }
  return null;
}

export const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
export const lcm = (a: number, b: number): number => (a * b) / gcd(a, b);

/** Onset density → 0..1 (log scale; 32 onsets per bar ≈ 1). */
export const densityScore = (onsetsPerBar: number): number => clamp01(Math.log2(1 + onsetsPerBar) / Math.log2(33));
/** Gain-sum prior when measured levels are unavailable. */
export const gainLoudness = (gainPerBar: number): number => clamp01(Math.log2(1 + gainPerBar) / 5);
/** Estimated RMS dBFS → 0..1, the same mapping client telemetry uses. */
export const dbLoudness = (rmsDb: number): number => clamp01((rmsDb + 40) / 30);
export const tempoScore = (bpm: number): number => clamp01((bpm - 60) / 120);

export function intensityOf(f: { density: number; loudness: number; brightness: number; lowEnd: number; percussive: number; bpm: number }): number {
  return clamp01(
    0.35 * f.density + 0.2 * f.loudness + 0.15 * f.brightness + 0.1 * f.lowEnd + 0.1 * f.percussive + 0.1 * tempoScore(f.bpm),
  );
}

/** Share of distinct pitch-class pairs in a bar that clash (semitone or tritone); needs ≥ 3 classes. */
export function clusterScore(pcs: Iterable<number>): number | null {
  const set = [...new Set(pcs)];
  if (set.length < 3) return null;
  let pairs = 0;
  let clash = 0;
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      const d = Math.abs(set[i]! - set[j]!) % 12;
      const ic = Math.min(d, 12 - d);
      pairs++;
      if (ic === 1 || ic === 6) clash++;
    }
  }
  return clash / pairs;
}

/** Short stable hash (FNV-1a) for fingerprints. */
export function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The repeating harmony of a section: per-bar pitch-class sets reduced to their shortest cycle and
 * rotated to a canonical start, so the same progression hashes the same wherever it starts.
 */
export function chordCycleHash(bars: number[][]): string | null {
  const sets = bars.map((pcs) => [...new Set(pcs)].sort((a, b) => a - b).join('.'));
  if (!sets.some((s) => s !== '')) return null;
  const cycle = sets.slice(0, periodOf(sets) ?? sets.length);
  let best = cycle.join('|');
  for (let i = 1; i < cycle.length; i++) {
    const rotated = [...cycle.slice(i), ...cycle.slice(0, i)].join('|');
    if (rotated < best) best = rotated;
  }
  return hash(best);
}
