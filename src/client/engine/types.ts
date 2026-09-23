// The performer engine's public surface. The UI (Svelte) and the renderer consume only this.
// The engine owns Strudel: boot, sound registration, preload, the synced scheduler, section
// rendering, the master chain and telemetry. It never talks to the socket itself.
//
// ── Normative rendering semantics (see also src/shared/schedule.ts) ─────────────────────────────
// Part instance = (sectionId, partId). Its pattern is compiled from `code` (re-validated with the
// shared allowlist), then: sanitizeModelValue (innermost) → .seed(originCycle).late(originCycle) →
// score-time mapping (non-continuing parts: play bars → score bars via scoreSegments) → window →
// engine keys (orbit, duck, namespaced `cut` = orbit*100 + cut) → guard.
//  • Window: a part sounds while the section's score bar ∈ [enterBar, exitBar ?? ∞) and the section
//    is sounding (startCycle ≤ cycle < next section's influence/transition end). Haps without
//    `whole` are dropped. Onsets inside the window trigger. A note straddling the window start
//    re-triggers at the start with its remaining length (not for continuing instances). Notes are
//    truncated at the window end (duration clamp, `release ??= 0.05`) and the instance's channel
//    releases over 1 beat (percussive roles) or 1 bar (others).
//  • Continuing instances (ProgramPart.continues) are one uninterrupted instance with the previous
//    section's same-id part: no truncation or re-onset at the boundary, no transition, play time.
//  • Level: each instance has an engine-owned channel (BiquadFilter → GainNode) between its orbit
//    output and the master bus (never orbit.output.gain — superdough's duck owns it). Level ×
//    automation × transition envelope × intensity macro × trims are scheduled on the channel as
//    AudioParam ramps at the audio time of each cycle — sample-accurate and identical on every
//    client. Per-hap values stay the model's own. Knob values are bound as
//    signal(t => knobAt(part, name, scoreBar(t))) so every client computes the same numbers. The
//    signal is sampled at each hap's onset in the time frame where knob() is applied, so time
//    transforms written after it stretch its automation too: in `.lpf(knob("cut")).slow(2)` the
//    lane plays at half speed (the hap at score bar 8 gets bar 4's value).
//  • Brightness macro (per hap at its onset cycle): cutoff × 2^(1.0·mb), hcutoff × 2^(0.5·mb),
//    room/delay sends × (1 − 0.3·mb); plus the master tilt EQ. Intensity macro on channels:
//    percussive roles ±3 dB, pad/texture ∓2 dB.
//  • Transitions: crossfade/cut/breath/filter act on channels; riser is engine-native (noise →
//    high-pass sweep 200→8000 Hz → gain ≈ −18 dBFS) into the master bus before the limiter. A
//    transition window that began before the section arrived is skipped, never joined part-way.
//  • Vamp: past its score a section loops its last phrase (vamp.loopBars) if vamp.allowed.
//  • Guard: every query of a part runs within the query budget (queryBudget(span) in
//    src/shared/limits.ts, enforced from inside Strudel by src/strudel/guard.ts): a query that would
//    need more pattern queries or haps stops as soon as it passes the limit, before it can freeze the
//    tab, and the part is muted with code 'density'. A part whose query throws otherwise ('query'),
//    yields > MAX_PART_HAPS_PER_TICK haps in a tick, whose query time EMA exceeds 4 ms, or that has
//    more than MAX_PART_ONSETS_PLAYED_PER_BAR (2 × MAX_PART_ONSETS_PER_BAR) onsets within one bar is
//    muted until the section ends and emits partError. The tick and time rules depend on the
//    client's timing; the per-bar count is the deterministic backstop (the bar's first
//    MAX_PART_ONSETS_PLAYED_PER_BAR onsets play, then the part is muted). At most MAX_HAPS_PER_TICK
//    haps per tick overall (drop in reverse role priority: texture first, kick last).
//  • Scheduler: queries are split at tempo-segment boundaries (controls {_cps, cyclist:'synced'});
//    durations use msAtCycle; superdough's async errors are caught per hap → partError.
//  • Master: orbit sum → safety/tilt EQ → master trim → limiter (DynamicsCompressor) → soft clip →
//    user volume → destination; analyser tapped after the clipper.
import type { Timeline } from '../../shared/timeline.ts';
import type { MixerState, SectionProgram } from '../../shared/program.ts';
import type { PartRole, VoiceFamily } from '../../shared/music.ts';
import type { Telemetry, TelemetryErrorCode } from '../../shared/protocol.ts';

/** One musical event, for visuals. Produced both when triggered (audio) and by lookahead queries. */
export interface VisualEvent {
  sectionId: string;
  partId: string;
  /** `${sectionId}:${partId}` — unique while two sections overlap (crossfades). */
  instance: string;
  role: PartRole;
  family: VoiceFamily;
  /** Onset, absolute fractional cycle (play time). */
  cycle: number;
  /** Length in cycles. */
  duration: number;
  /** MIDI note if pitched, else null. */
  midi: number | null;
  /** Effective level 0..1 including channel level (what the listener hears, roughly). */
  gain: number;
  pan: number;
  sound: string;
  /** Character ranges in the part's code that produced this event (for live highlighting). */
  locations: { start: number; end: number }[];
}

export type EngineState =
  | 'idle'
  | 'preparing'
  | 'ready' // sounds for the current section decoded; waiting for a gesture
  | 'unlocking'
  | 'running'
  | 'suspended' // interrupted by the OS / page hidden; needs unlock() again
  | 'error';

export interface PartError {
  sectionId: string;
  /** '' for the section-level codes: 'late-schedule', and 'clip' (reported only in telemetry()). */
  partId: string;
  code: TelemetryErrorCode;
  message: string;
}

export interface Meters {
  master: { rmsDb: number; peakDb: number };
  /** Per instance key, 0..1 smoothed loudness (legend chips, blooms). */
  parts: Record<string, number>;
}

export interface EngineEvents {
  state: (state: EngineState) => void;
  /** Fired when an event is scheduled to sound (ahead of time); `audioDelaySec` until audible. */
  hap: (event: VisualEvent, audioDelaySec: number) => void;
  partError: (error: PartError) => void;
  /** A scheduled section just reached its bar 0 (audibly). */
  sectionStart: (sectionId: string) => void;
  preload: (sectionId: string, status: { ready: boolean; failed: string[] }) => void;
  /** Scheduler health for tier downgrades and telemetry. */
  health: (h: { skips: number; lateMs: number; droppedHaps: number }) => void;
  /** Audio was interrupted (iOS lock, call, tab freeze): show a "tap to resume" affordance. */
  needsGesture: () => void;
}

/** NTP-style server clock (src/client/engine/clock-sync.ts). */
export interface ClockSync {
  /** Server clock estimate in ms; only meaningful once `ready` resolved. */
  serverNow(): number;
  offsetMs(): number;
  rttMs(): number;
  jitterMs(): number;
  /** Resolves after ≥ 5 good samples (RTT ≤ 500 ms) over the websocket transport. */
  ready: Promise<void>;
  /**
   * Corrections ≤ 50 ms are slewed at ≤ 5 ms/s; larger ones are steps reported here so the scheduler
   * can skip (forward) or hold output without re-querying (backward).
   */
  onStep(listener: (deltaMs: number) => void): () => void;
  /** Immediate re-burst (reconnect, visibilitychange, pageshow, online, sleep detected). */
  resync(): void;
  stop(): void;
}

export interface EngineOptions {
  /** Where to fetch the catalog (CATALOG_URL). */
  catalogUrl: string;
  clock: ClockSync;
}

export interface EngineSnapshot {
  epoch: string;
  rev: number;
  timeline: Timeline;
  sections: SectionProgram[];
  mixer: MixerState;
}

export interface Engine {
  readonly state: EngineState;
  /**
   * Loads the Strudel scope, registers the catalog's sounds in fixed order, creates the AudioContext
   * suspended (allowed before a gesture) and decodes the current and next sections' samples and
   * soundfont presets. Idempotent. State becomes 'ready' when the current section's sounds are in.
   */
  prepare(): Promise<void>;
  /**
   * Call synchronously from a user gesture (click/keydown/touchend) before any await: resumes the
   * AudioContext, loads worklets, inserts the master chain and starts output at the next bar whose
   * sounds are ready (≤ 2 bars), fading in over one bar. Sustained notes already in progress start
   * with their remaining length. Idempotent: also the resume path after 'suspended'.
   */
  unlock(): Promise<void>;
  /** Stops audio output (keeps state; visuals may continue silently). */
  suspend(): void;

  /** Replaces all schedule state atomically (welcome, resync, new epoch — old material fades over a bar). */
  applySnapshot(snapshot: EngineSnapshot): void;
  /**
   * Applies an atomic schedule update. Ignores rev ≤ current; on a rev gap calls `onResyncNeeded`.
   * Unchanged (id, rev) sections keep their compiled patterns. A change touching cycles already
   * handed to superdough applies from the next bar and is reported as 'late-schedule'.
   */
  applySchedule(update: { epoch: string; rev: number; timeline: Timeline; upserts: SectionProgram[]; revokes: string[] }): void;
  onResyncNeeded(listener: () => void): () => void;
  setMixer(mixer: MixerState): void;

  /** Current audible cycle (fractional). Valid before unlock too (silent visual mode). */
  now(): number;
  cps(): number;
  /** Events in [fromCycle, toCycle) without triggering audio (pre-echo, landing page, code preview). */
  query(fromCycle: number, toCycle: number): VisualEvent[];
  /** Currently sounding code ranges per instance key (for the code view highlighter). */
  activeLocations(): Map<string, { start: number; end: number }[]>;
  /** The section sounding at `cycle` (or null). */
  sectionAt(cycle: number): SectionProgram | null;
  sections(): SectionProgram[];
  preloadProgress(): { loaded: number; total: number };
  /**
   * Levels right now. Part levels are smoothed over audio time, not per call (an EMA whose
   * coefficient comes from the audio time elapsed since the previous reading, τ = METER_TAU_SEC in
   * meters.ts): any number of pollers at any rate see the same curve, and calls at the same audio
   * time return the cached reading. Silent while output is stopped.
   */
  meters(): Meters;
  /**
   * The knob values an instance (`${sectionId}:${partId}`) plays with at `cycle`: automation lanes,
   * carried values and the room's follow offsets, clamped to each knob's range. {} when the engine
   * does not know the instance.
   */
  knobValues(instance: string, cycle: number): Record<string, number>;
  /**
   * An instance's fader at `cycle`: its level lane at that score bar (before transitions, macros and
   * trims). 0 when the engine does not know the instance.
   */
  levelAt(instance: string, cycle: number): number;
  /** Listener-local volume 0..1 (not shared). */
  setVolume(volume: number): void;
  /** Listener-local personal mix: mute a part id (all its instances). Never affects others. */
  setLocalMute(partId: string, muted: boolean): void;
  /** Snapshot for server telemetry (every 4 bars from sampled clients). */
  telemetry(): Telemetry;
  /** Master analyser for visuals (null before unlock). */
  analyser(): AnalyserNode | null;

  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): () => void;
}

// Factories (implemented in engine.ts / clock-sync.ts):
//   createEngine(options: EngineOptions): Engine
//   startClockSync(probe: () => Promise<number>): ClockSync
//     (the room connection passes () => socket.timeout(2000).emitWithAck('clock'))
