// The SyncedScheduler (ARCHITECTURE §4): Strudel's Cyclist cannot follow an external clock, so
// cycles here are a pure function of the synced server clock and the room timeline. Every tick (the
// engine's 50 ms loop) it asks the performer for [lastEnd, cycleAt(now + lookahead)), split at tempo
// segments, and hands each hap to superdough at the audio time of its cycle. Verified prototype:
// two pages ±7.5 ms.
//
// AudioContext time maps to server time through getOutputTimestamp() (stale readings discarded,
// EMA-smoothed, snapping on jumps > 50 ms), which folds the output latency in.
import { SCHEDULER_LOOKAHEAD_S } from '../../shared/schedule.ts';
import { cpsAtCycle, cycleAtMs, msAtCycle, type Timeline } from '../../shared/timeline.ts';
import type { PlannedHap } from './performer.ts';

export interface OutputTimestamp {
  contextTime: number;
  performanceTime: number;
}

export interface SchedulerAudio {
  currentTime(): number;
  outputTimestamp(): OutputTimestamp | null;
  /** baseLatency + outputLatency, for when no fresh output timestamp exists. */
  latencySec(): number;
}

export interface SchedulerDeps {
  audio: SchedulerAudio;
  serverNow(): number;
  perfNow(): number;
  timeline(): Timeline;
  /** Haps with onsets in [from, to), all inside one tempo segment of `cps`. */
  plan(from: number, to: number, cps: number, resumeAt: number | null): PlannedHap[];
  output(hap: PlannedHap, audioTime: number, durationSec: number, cps: number): void;
  lookaheadSec?: number;
  /** Delay of the processing after the hand-over point (the master chain's look-ahead). */
  outputDelaySec?: number;
}

export interface SchedulerHealth {
  skips: number;
  lateMs: number;
  droppedHaps: number;
}

/** Haps are handed over at least this far ahead of the audio clock; anything later is skipped. */
const MIN_LEAD_SEC = 0.01;
/** Backward clock steps larger than this are re-anchored instead of held (seconds of music). */
const MAX_HOLD_SEC = 4;
const STALE_TIMESTAMP_MS = 100;
const SNAP_MS = 50;
const EMA = 0.05;

export class SyncedScheduler {
  private readonly deps: SchedulerDeps;
  private readonly lookahead: number;
  private readonly delayMs: number;
  private active = false;
  private perfOffsetMs: number | null = null;
  private serverMinusPerf = 0;
  private startAt: number | null = null;
  private health: SchedulerHealth = { skips: 0, lateMs: 0, droppedHaps: 0 };
  /** End of the span already queried and handed to superdough (cycles), null before the first tick. */
  lastEnd: number | null = null;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.lookahead = deps.lookaheadSec ?? SCHEDULER_LOOKAHEAD_S;
    this.delayMs = (deps.outputDelaySec ?? 0) * 1000;
  }

  get running(): boolean {
    return this.active;
  }

  /**
   * Output starts at `atCycle` on the following ticks; sustained notes in progress there start with
   * their remaining length. Also the resume path: the audio mapping is re-measured from scratch.
   */
  start(atCycle: number): void {
    this.active = true;
    this.startAt = atCycle;
    this.lastEnd = null;
    this.perfOffsetMs = null;
  }

  stop(): void {
    this.active = false;
    this.lastEnd = null;
  }

  takeHealth(): SchedulerHealth {
    const h = this.health;
    this.health = { skips: 0, lateMs: 0, droppedHaps: 0 };
    return h;
  }

  /** Server-clock ms at which audio scheduled at context time `t` reaches the speakers. */
  serverMsAtAudioTime(t: number): number {
    if (this.perfOffsetMs === null) this.updateMapping();
    return t * 1000 + this.perfOffsetMs! + this.serverMinusPerf + this.delayMs;
  }

  audioTimeAtServerMs(ms: number): number {
    if (this.perfOffsetMs === null) this.updateMapping();
    return (ms - this.delayMs - this.serverMinusPerf - this.perfOffsetMs!) / 1000;
  }

  audioTimeAtCycle(cycle: number): number {
    return this.audioTimeAtServerMs(msAtCycle(this.deps.timeline(), cycle));
  }

  cycleAtAudioTime(t: number): number {
    return cycleAtMs(this.deps.timeline(), this.serverMsAtAudioTime(t));
  }

  /** Refreshes the context-time → performance-time → server-time mapping. */
  updateMapping(): void {
    const { audio } = this.deps;
    const perfNow = this.deps.perfNow();
    this.serverMinusPerf = this.deps.serverNow() - perfNow;
    const ts = audio.outputTimestamp();
    const fresh = ts !== null && ts.performanceTime > 0 && Math.abs(perfNow - ts.performanceTime) < STALE_TIMESTAMP_MS;
    const raw = fresh ? ts.performanceTime - ts.contextTime * 1000 : perfNow - audio.currentTime() * 1000 + audio.latencySec() * 1000;
    if (this.perfOffsetMs === null || Math.abs(raw - this.perfOffsetMs) > SNAP_MS) this.perfOffsetMs = raw;
    else this.perfOffsetMs += EMA * (raw - this.perfOffsetMs);
  }

  tick(): void {
    if (!this.active) return;
    const { deps } = this;
    this.updateMapping();
    const t = deps.audio.currentTime();
    const tl = deps.timeline();
    const earliest = this.cycleAtAudioTime(t + MIN_LEAD_SEC);
    const end = this.cycleAtAudioTime(t + this.lookahead);
    let begin: number;
    let resumeAt: number | null = null;
    if (this.lastEnd === null) {
      if (this.startAt === null || end <= this.startAt) return;
      begin = Math.max(this.startAt, earliest);
      resumeAt = begin;
    } else {
      begin = this.lastEnd;
      if (begin < earliest) {
        // Stalled tab or a forward clock step: skip what can no longer be played on time.
        this.health.skips++;
        begin = earliest;
        resumeAt = begin;
      } else if (begin - end > MAX_HOLD_SEC * cpsAtCycle(tl, end)) {
        this.health.skips++;
        begin = earliest;
        resumeAt = begin;
      }
    }
    // After a backward step the horizon is behind what was already handed over: hold.
    if (end <= begin) return;
    for (const [a, b, cps] of splitAtSegments(tl, begin, end)) {
      for (const hap of deps.plan(a, b, cps, resumeAt !== null && resumeAt >= a && resumeAt < b ? resumeAt : null)) {
        const at = this.audioTimeAtCycle(hap.onset);
        if (at < t + MIN_LEAD_SEC / 2) {
          this.health.droppedHaps++;
          this.health.lateMs = Math.max(this.health.lateMs, (t - at) * 1000);
          continue;
        }
        const durationSec = (msAtCycle(tl, hap.onset + hap.duration) - msAtCycle(tl, hap.onset)) / 1000;
        deps.output(hap, at, durationSec, cps);
      }
    }
    this.lastEnd = end;
  }
}

/** [from, to) split at tempo-segment boundaries, each piece with its segment's cps. */
export function splitAtSegments(tl: Timeline, from: number, to: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const segs = tl.segments;
  for (let i = 0; i < segs.length; i++) {
    const segStart = i === 0 ? Number.NEGATIVE_INFINITY : segs[i]!.startCycle;
    const segEnd = i + 1 < segs.length ? segs[i + 1]!.startCycle : Number.POSITIVE_INFINITY;
    const a = Math.max(from, segStart);
    const b = Math.min(to, segEnd);
    if (b > a) out.push([a, b, segs[i]!.cps]);
  }
  return out;
}
