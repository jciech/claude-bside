// Results of checking and analysing Strudel code. Produced by src/strudel/analyze.ts (in the server's
// checker workers), consumed by the conductor, the composer turn context, the external CLI and the UI.
import type { Descriptors, PartRole } from './music.ts';

export type Severity = 'error' | 'warning';

/** One problem, phrased so an LLM (or a human) can fix it without seeing our code. */
export interface Issue {
  severity: Severity;
  /** Machine-readable rule id, e.g. "unknown-method", "unknown-sound", "limit", "key-fit". */
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
    /** Share of pitched onsets inside the declared scale (null when no scale given). */
    keyFit: number | null;
  };
  /** Longuet-Higgins/Lee weighted syncopation on a 16-step grid, 0..1. */
  syncopation: number;
  /** 16-step onset histogram over the analysed window (for groove novelty + visuals). */
  grid16: number[];
  loudness: { meanGain: number; peakOverlapGain: number; score: number };
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
  descriptors: Descriptors;
  onsetsPerBar: number;
  peakOverlapGain: number;
  audibleParts: number;
  period: number | null;
}

export interface SectionAnalysis {
  parts: PartAnalysis[];
  mix: MixAnalysis;
}

/** Result of checking one piece of code (one part). */
export interface CodeCheck {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  analysis: PartAnalysis | null;
  timings: { validateMs: number; evaluateMs: number; analyzeMs: number };
}

/** Result of checking a whole plan (schema + code + musical/novelty/dramaturgy rules). */
export interface PlanCheck {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** Per planned section, in order; null for a section that failed before analysis. */
  sections: (SectionAnalysis | null)[];
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
