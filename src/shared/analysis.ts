// Results of checking and analysing Strudel code. Produced by src/strudel/analyze.ts (in the server's
// checker workers), consumed by the conductor, the composer turn context, the external CLI and the UI.
import type { Descriptors, PartRole, Span } from './music.ts';

export type Severity = 'error' | 'warning';

/** One problem, phrased so an LLM (or a human) can fix it without seeing our code. */
export interface Issue {
  severity: Severity;
  /**
   * Machine-readable rule id. The ids emitted today, by stage:
   * - validator: "syntax", "quotes", "mini", "unknown-method", "unknown-function", "unknown-identifier",
   *   "unknown-key", "denied", "density", "size", "number", "knob", "knob-undeclared", "unused"
   * - evaluation: "syntax", "mini", "denied", "not-pattern", "runtime", "timeout"
   * - checker: "knob-unused", "knob-range", "timeout", "busy", "resource", "internal"
   * - analyser: "scale", "silent", "density", "limit", "value", "key-fit", "constant-fx", "unknown-sound",
   *   "denied", "sound-range", "sample-index", "n-without-scale", "arith-on-control", "runtime", "strudel"
   * - conductor: "schema", "carry", "knob-undeclared", "request", "fork", "text", "tempo", "targets",
   *   "register", "plan-length", "cooldown", "similarity", "crate", "palette", "stasis", "dramaturgy",
   *   "reprise", "lead-time", "stale-context", "request-closed", "timeout", "internal"
   */
  rule: string;
  message: string;
  /** Where in the plan, e.g. "sections[0].parts[2].code" or a part id. */
  path?: string;
  /** 1-based position inside the part's code, when the issue points at code. */
  line?: number;
  column?: number;
  excerpt?: string;
  /** Concrete fix suggestion (did-you-mean, correct spelling, idiom). */
  hint?: string;
}

export type Register = 'sub' | 'bass' | 'low-mid' | 'mid' | 'high' | 'very-high';

export interface SoundUse {
  /** Resolved sound id as superdough sees it (bank applied, lower-cased), e.g. "rolandtr909_bd". */
  id: string;
  kind: 'synth' | 'sample' | 'soundfont' | 'wavetable';
  /** Catalog family, e.g. "drum-machine/kick", "gm/keys", "vcsl/mallet". */
  family: string;
  known: boolean;
  onsets: number;
  /** Share of the part's loudness contributed by this sound (0..1). */
  share: number;
}

export interface PartAnalysis {
  id: string;
  role: PartRole | null;
  onsetsPerBar: number;
  densityPerBar: { min: number; mean: number; max: number };
  sounds: SoundUse[];
  pitch: null | {
    minMidi: number;
    maxMidi: number;
    medianMidi: number;
    distinct: number;
    register: Register;
    /** Share of pitched onsets inside the scale active at their bar (null when no scale given). */
    keyFit: number | null;
  };
  /** Longuet-Higgins/Lee weighted syncopation on a 16-step grid, 0..1. */
  syncopation: number;
  /** 16-step onset histogram over the analysed window (normalised to max 1). */
  grid16: number[];
  loudness: { meanGain: number; peakOverlapGain: number; score: number; estRmsDb: number | null };
  brightness: number;
  lowEndShare: number;
  percussiveShare: number;
  /** True when the pattern's events depend on the random seed. */
  random: boolean;
  /** Smallest repeating period in bars, or null if longer than the window / random. */
  period: number | null;
  energy: number;
  silent: boolean;
  /** Numeric effect params seen (max per key) — for the digest. */
  fx: Record<string, number>;
}

export interface MixAnalysis {
  /** Whole-window values. */
  descriptors: Descriptors;
  /** Start (first 4 bars) → end (last 4 bars), so builds can be verified to build. */
  spans: { intensity: Span; brightness: Span; density: Span; tension: Span };
  onsetsPerBar: number;
  maxOnsetsPerBar: number;
  peakOverlapGain: number;
  audibleParts: number;
  period: number | null;
}

/** Compact per-part summary used in turn contexts and the UI (keeps token counts low). */
export interface PartDigest {
  id: string;
  role: PartRole;
  instrument: string;
  evPerBar: number;
  register: Register | null;
  sync: number;
  bright: number;
  loud: number;
  period: number | 'random' | null;
  keyFit: number | null;
}

/** Result of checking one piece of code (one part). */
export interface CodeCheck {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  analysis: PartAnalysis | null;
  timings: { validateMs: number; evaluateMs: number; analyzeMs: number };
}

export interface PartCheck extends CodeCheck {
  id: string;
  digest: PartDigest | null;
  /** Human label of the dominant sound (catalog label), e.g. "TR-909 kick". */
  instrument: string;
}

/** Features used for similarity/novelty. One definition, shared by the checker and the ledger. */
export interface SectionFingerprint {
  descriptors: Descriptors;
  /** Sound id → loudness share across the section (sums to ~1). */
  soundShares: Record<string, number>;
  kickGrid16: number[];
  backbeatGrid16: number[];
  scale: string;
  bpm: number;
  chordHash: string | null;
}

export interface SectionCheck {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  parts: PartCheck[];
  mix: MixAnalysis | null;
  fingerprint: SectionFingerprint | null;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 && nb === 0) return 1;
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/**
 * Distance 0 (identical) … 1 (unrelated). Weights: sounds 0.35 (weighted Jaccard of loudness
 * shares), descriptors 0.25 (mean |Δ| of intensity/brightness/density), kick grid 0.15, backbeat
 * grid 0.10, harmony/tempo 0.15 (scale 0.08, chords 0.04, bpm 0.03 per 12 BPM).
 */
export function fingerprintDistance(a: SectionFingerprint, b: SectionFingerprint): number {
  const ids = new Set([...Object.keys(a.soundShares), ...Object.keys(b.soundShares)]);
  let inter = 0;
  let union = 0;
  for (const id of ids) {
    const x = a.soundShares[id] ?? 0;
    const y = b.soundShares[id] ?? 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  }
  const sounds = union === 0 ? 0 : 1 - inter / union;
  const d = a.descriptors;
  const e = b.descriptors;
  const desc = (Math.abs(d.intensity - e.intensity) + Math.abs(d.brightness - e.brightness) + Math.abs(d.density - e.density)) / 3;
  const kick = 1 - cosine(a.kickGrid16, b.kickGrid16);
  const back = 1 - cosine(a.backbeatGrid16, b.backbeatGrid16);
  const scale = a.scale === b.scale ? 0 : 1;
  const chords = a.chordHash && b.chordHash ? (a.chordHash === b.chordHash ? 0 : 1) : 0.5;
  const bpm = Math.min(1, Math.abs(a.bpm - b.bpm) / 12);
  return Math.min(1, 0.35 * sounds + 0.25 * desc + 0.15 * kick + 0.1 * back + 0.08 * scale + 0.04 * chords + 0.03 * bpm);
}
