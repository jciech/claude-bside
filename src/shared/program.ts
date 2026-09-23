// What listeners receive: compiled, validated sections scheduled on the room timeline.
// The performer (src/client/engine) renders these deterministically, so every client plays the
// same events at the same bar. Part `code` is exactly what is displayed AND evaluated.
// All `*Cycle` fields are absolute bars on the room timeline; all `*Bar` fields are score bars
// relative to the section (see src/shared/schedule.ts for play vs score time).
import type { Automation, Knob } from './plan.ts';
import type { ArcShape, Groove, PartRole, SectionLength, SectionRole, Span, TransitionType } from './music.ts';
import type { PartDigest } from './analysis.ts';
import type { Jump } from './schedule.ts';

export interface ProgramPart {
  id: string;
  role: PartRole;
  /** Validated Strudel expression; displayed verbatim in the code view and evaluated verbatim. */
  code: string;
  /**
   * Conductor-assigned orbit 1..24 for this part instance (own reverb/delay bus and engine channel).
   * A continuing part keeps its orbit; a rewritten same-id part gets a different one so the two can
   * crossfade. The engine never reassigns.
   */
  orbit: number;
  /** Fader 0..1 before automation, macros and trims. */
  level: number;
  /** Score bars. enterBar < 0 is a pickup over the previous section's end. */
  enterBar: number;
  exitBar: number | null;
  /** Complete knob declarations (inherited ones included). */
  knobs: Knob[];
  automation: Automation[];
  /** Resolved sidechain: engine sets duckorbit/duckdepth/duckattack on this part's haps. */
  duck: { orbits: number[]; depth: number; releaseSec: number } | null;
  /**
   * Absolute cycle this code's pattern time is anchored to: the performer applies
   * `.seed(originCycle).late(originCycle)`. Fresh parts: the section's startCycle. Continuing parts:
   * chosen by the conductor so the pattern carries on exactly where the previous instance left off.
   */
  originCycle: number;
  /**
   * True when this instance continues the same-id part of the previous section (carried code, no
   * restart): the performer treats both as one uninterrupted instance — no re-onset, no transition,
   * no truncation at the boundary, and play time (not score time) drives its pattern.
   */
  continues: boolean;
  /** Code identical to the previous section's same-id part (continuing or restarted). */
  carried: boolean;
  chromatic: boolean;
  /** Human label of the main sound, e.g. "TR-909 kick", "Vibraphone (VCSL)". */
  instrument: string;
  digest: PartDigest | null;
}

export interface SectionProgram {
  /** `${epoch}-${seq}`, e.g. "k3f9-0042". Never reused across restarts. */
  id: string;
  /** Incremented whenever the conductor re-issues this section (reschedule, jumps). */
  rev: number;
  /** Session-wide index. */
  index: number;
  /** 1-based track number within its movement ("Side B · Track 3"). */
  track: number;
  movementId: string;
  name: string;
  role: SectionRole;
  /** Absolute cycle of score bar 0. Integer, on the phrase grid. */
  startCycle: number;
  /** Composed length. */
  bars: SectionLength;
  /** Stay/Move-on edits of score time (see schedule.ts). */
  jumps: Jump[];
  /** Past its score (no successor yet), the section loops its last `loopBars` — if allowed. */
  vamp: { allowed: boolean; loopBars: 4 | 8 };
  /** Still revocable by a crowd replan until its lock point (UI shows cues as "planned"). */
  provisional: boolean;
  tempo: { fromBpm: number; toBpm: number; rampBars: number; rampAt: 'start' | 'end' };
  scale: string;
  chords: string | null;
  transitionIn: { type: TransitionType; bars: number };
  targets: { intensity: Span; brightness: Span; density: Span; tension: Span };
  /** Measured at accept time from hap analysis: first 4 bars → last 4 bars. */
  measured: { intensity: Span; brightness: Span; density: Span; tension: Span };
  parts: ProgramPart[];
  publicNote: string;
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
  /** Planned length in bars (drives the spiral's pitch); may be exceeded. */
  plannedBars: number;
  /** Tracks already played on this side (for late joiners' spiral). */
  tracks: { id: string; name: string; role: SectionRole; startCycle: number; bars: number }[];
}

/** One keyframe of the fast-lane mixer. Values ramp linearly over rampBars from atCycle. */
export interface MixerKeyframe {
  /** Integer bar where the ramp starts (≥ now + MIN_CHANGE_LEAD when emitted). */
  atCycle: number;
  rampBars: number;
  /** Room pull mapped to macros, each -1..1. */
  macros: { brightness: number; intensity: number };
  /** Balance/safety trims in dB keyed by part id (applies to the part instance sounding then). */
  trimsDb: Record<string, number>;
}

/**
 * The performer computes every mixer value as a pure function of cycle: before next.atCycle the
 * values are prev's (or next's if prev is null); across the ramp they interpolate; after, next's.
 */
export interface MixerState {
  rev: number;
  prev: MixerKeyframe | null;
  next: MixerKeyframe;
  /** Temporary safety trim after a "harsh" consensus. */
  safety: { masterDb: number; highShelfDb: number; fromCycle: number; untilCycle: number } | null;
}

export const NEUTRAL_KEYFRAME: MixerKeyframe = {
  atCycle: 0,
  rampBars: 1,
  macros: { brightness: 0, intensity: 0 },
  trimsDb: {},
};

export const EMPTY_MIXER: MixerState = { rev: 0, prev: null, next: NEUTRAL_KEYFRAME, safety: null };
