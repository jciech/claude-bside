// What listeners receive: compiled, validated sections scheduled on the room timeline.
// The performer (src/client/engine) renders these deterministically, so every client plays the
// same events at the same bar. Part `code` is exactly what is displayed AND evaluated.
import type { Automation, Knob } from './plan.ts';
import type {
  ArcShape,
  Descriptors,
  Groove,
  PartRole,
  SectionLength,
  SectionRole,
  Span,
  TransitionType,
} from './music.ts';
import type { PartDigest } from './analysis.ts';

export interface ProgramPart {
  id: string;
  role: PartRole;
  /** Validated Strudel expression; displayed verbatim in the code view and evaluated verbatim. */
  code: string;
  /** Engine-assigned orbit (own reverb/delay bus per part); model code may not set orbits. */
  orbit: number;
  /** Fader 0..1 before automation. */
  level: number;
  /** Section-relative bars. */
  enterBar: number;
  exitBar: number | null;
  knobs: Knob[];
  automation: Automation[];
  /** Resolved duck target orbit (the performer applies duckorbit/duckdepth itself). */
  duck: { orbit: number; depth: number } | null;
  /** Human label of the main sound, e.g. "TR-909 kick", "Vibraphone (VCSL)". */
  instrument: string;
  /** True when the code is unchanged from the previous section (carried). */
  carried: boolean;
  /** Short measured digest for the UI legend/tooltips. */
  digest: PartDigest | null;
}

export interface SectionProgram {
  /** e.g. "s-0042". Monotonic within a session. */
  id: string;
  index: number;
  movementId: string;
  name: string;
  role: SectionRole;
  /** Absolute cycle (bar) where bar 0 of this section lands. Integer. */
  startCycle: number;
  bars: SectionLength;
  bpm: number;
  scale: string;
  chords: string | null;
  transitionIn: { type: TransitionType; bars: number };
  targets: { intensity: Span; brightness: Span; density: Span; tension: Span };
  /** Measured at accept time from hap analysis. */
  measured: Descriptors;
  parts: ProgramPart[];
  publicNote: string;
  /** Which composer produced it: shown subtly in the UI ("Claude", "autopilot", "guest"). */
  author: 'claude' | 'external' | 'scripted';
}

/** A movement = one "side" of the record (see docs/DESIGN.md). */
export interface MovementInfo {
  id: string;
  /** 1-based side number within the session: Side A, B, C… */
  side: number;
  name: string;
  bpm: number;
  scale: string;
  groove: Groove;
  arcShape: ArcShape;
  blurb: string;
  startCycle: number;
  /** Planned length in bars (for the spiral's pitch); may be exceeded. */
  plannedBars: number;
}

/** The fast lane: continuous, deterministic mixer moves the performer ramps over ~4 bars. */
export interface MixerState {
  /** Room pull mapped to macros, each -1..1. */
  macros: { brightness: number; intensity: number };
  /** Per-part trims in dB (conductor safety/balance), keyed by part id. */
  trimsDb: Record<string, number>;
  /** Temporary safety trim after a "harsh" consensus: master dB and high-shelf dB until cycle. */
  safety: { masterDb: number; highShelfDb: number; untilCycle: number } | null;
}

export const EMPTY_MIXER: MixerState = {
  macros: { brightness: 0, intensity: 0 },
  trimsDb: {},
  safety: null,
};
