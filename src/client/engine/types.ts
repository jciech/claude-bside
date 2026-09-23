// The performer engine's public surface. The UI (Svelte) and the renderer consume only this.
// The engine owns Strudel: boot, sound registration, the synced scheduler, section scheduling,
// part wrapping (section time, fader, clamp, orbit, guard), the master chain and telemetry.
import type { Timeline } from '../../shared/timeline.ts';
import type { MixerState, SectionProgram } from '../../shared/program.ts';
import type { PartRole, VoiceFamily } from '../../shared/music.ts';
import type { Telemetry } from '../../shared/protocol.ts';

/** One musical event, for visuals. Produced both when triggered (audio) and by lookahead queries. */
export interface VisualEvent {
  sectionId: string;
  partId: string;
  role: PartRole;
  family: VoiceFamily;
  /** Onset, absolute fractional cycle. */
  cycle: number;
  /** Length in cycles. */
  duration: number;
  /** MIDI note if pitched, else null. */
  midi: number | null;
  /** Effective level 0..1 after fader/automation (what the listener hears, roughly). */
  gain: number;
  pan: number;
  sound: string;
  /** Character ranges in the part's code that produced this event (for live highlighting). */
  locations: { start: number; end: number }[];
}

export type EngineState = 'idle' | 'preparing' | 'ready' | 'unlocking' | 'running' | 'suspended' | 'error';

export interface PartError {
  sectionId: string;
  partId: string;
  message: string;
}

export interface Meters {
  master: { rmsDb: number; peakDb: number };
  /** Per part id, 0..1 smoothed loudness (for legend chips, blooms). */
  parts: Record<string, number>;
}

export interface EngineEvents {
  state: (state: EngineState) => void;
  /** Fired when an event is scheduled to sound (ahead of time); `audioDelaySec` until audible. */
  hap: (event: VisualEvent, audioDelaySec: number) => void;
  partError: (error: PartError) => void;
  /** A scheduled section just reached its bar 0. */
  sectionStart: (sectionId: string) => void;
}

export interface Engine {
  readonly state: EngineState;
  /**
   * Loads the Strudel scope and registers sounds (catalog maps in fixed order). Needs no
   * AudioContext; call at page load. Idempotent.
   */
  prepare(): Promise<void>;
  /**
   * Must be called synchronously from a user gesture (click/keydown/touchend) before any await:
   * resumes the AudioContext, initialises worklets, inserts the master chain, starts the scheduler.
   */
  unlock(): Promise<void>;
  /** Stops audio output (keeps state; visuals may continue silently). */
  suspend(): void;

  /** Server clock accessor (from clock sync). The engine never talks to the socket itself. */
  setServerClock(serverNow: () => number): void;
  setTimeline(timeline: Timeline): void;
  /** Adds or replaces a committed section (by id). Sections may arrive in any order. */
  upsertSection(section: SectionProgram): void;
  revokeSection(sectionId: string): void;
  setMixer(mixer: MixerState): void;

  /** Current audible cycle (fractional). Valid before unlock too (silent visual mode). */
  now(): number;
  cps(): number;
  /** Events in [fromCycle, toCycle) without triggering audio (pre-echo, landing page, code preview). */
  query(fromCycle: number, toCycle: number): VisualEvent[];
  /** Currently sounding code ranges per part (for the code view highlighter). */
  activeLocations(): Map<string, { start: number; end: number }[]>;
  /** The section sounding at `cycle` (or null). */
  sectionAt(cycle: number): SectionProgram | null;
  meters(): Meters;
  /** User volume 0..1 (listener-local, not shared). */
  setVolume(volume: number): void;
  /** Snapshot for server telemetry (every 4 bars from sampled clients). */
  telemetry(): Telemetry;
  /** Master analyser for visuals (null before unlock). */
  analyser(): AnalyserNode | null;

  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): () => void;
}
