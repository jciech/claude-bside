// Engine → renderer messages. Runs on the main thread inside the host and keeps its work small:
// triggered haps batched per scheduler tick, clock samples only when extrapolation would drift,
// meters at ≤ 30 Hz, lookahead queries at most 4 per bar, moments derived from section roles, and a
// one-off backfill of the side's recent past so a late joiner's record isn't blank. It also times
// the DOM label (drop inversion, "— listening —") for the UI.
import type { Engine, VisualEvent } from '../engine/types.ts';
import type { MovementInfo, SectionProgram } from '../../shared/program.ts';
import type { ClockSample, LabelState, ToRenderer } from './protocol.ts';
import { FlashLimiter } from './flash.ts';
import { BUILD_LOOKAHEAD_BARS, DROP_INVERT_BARS, LOOKAHEAD_BARS, sectionMoments, type MomentKind } from './moments.ts';

export type { LabelState } from './protocol.ts';

export type FeedEngine = Pick<Engine, 'state' | 'now' | 'cps' | 'query' | 'sections' | 'sectionAt' | 'meters' | 'on'>;

export interface FeedTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface FeedOptions {
  engine: FeedEngine;
  send: (message: ToRenderer) => void;
  epochNow: () => number;
  onLabel: (state: LabelState) => void;
  timers?: FeedTimers;
}

export const FEED = {
  tickMs: 33,
  /** A clock sample is resent when the renderer's extrapolation would be off by more than this. */
  clockToleranceSec: 0.004,
  /** Ghost queries reach a little past the drawn window so ghosts don't pop in at its edge. */
  lookaheadMarginBars: 0.1,
  /** Section starts are announced this far ahead, so gestures land exactly on the downbeat. */
  announceAheadBars: 1.5,
  /** A section start that passed less than this long ago still gets its gestures. */
  lateStartBars: 0.5,
  /** Haps within this many bars mean the engine is performing (else the feed plays from queries). */
  liveHapBars: 1,
  backfillBars: 64,
  backfillChunkBars: 4,
  /** rmsDb → 0..1 for the stylus glow. */
  meterFloorDb: -50,
  meterRangeDb: 40,
  energyTauMs: 1500,
} as const;

const DEFAULT_TIMERS: FeedTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/** The renderer only needs where and what an event is, not its code locations. */
function forRenderer(e: VisualEvent): VisualEvent {
  return { ...e, locations: [] };
}

export class EngineFeed {
  private readonly engine: FeedEngine;
  private readonly send: (message: ToRenderer) => void;
  private readonly epochNow: () => number;
  private readonly onLabel: (state: LabelState) => void;
  private readonly timers: FeedTimers;
  private interval: unknown = null;
  private unsubscribers: (() => void)[] = [];
  private paused = false;

  private batch: VisualEvent[] = [];
  private lastSample: ClockSample | null = null;
  private lastQuarter: number | null = null;
  /** Upper bound of events already forwarded from lookahead queries while no haps flowed. */
  private forwardedTo = Number.NEGATIVE_INFINITY;
  private lastHapCycle = Number.NEGATIVE_INFINITY;
  /** Section id → startCycle, for sections whose moments were sent. */
  private readonly announced = new Map<string, number>();
  private pendingDrops: number[] = [];
  private readonly limiter = new FlashLimiter();
  private dropAt: number | null = null;
  private silent = false;
  private label: LabelState = { inverted: false, listening: false };
  private levelsIdle = false;
  private energy = 0;
  private lastLevelsAt = 0;
  private backfillSide: string | null = null;
  private backfillTimer: unknown = null;

  constructor(options: FeedOptions) {
    this.engine = options.engine;
    this.send = options.send;
    this.epochNow = options.epochNow;
    this.onLabel = options.onLabel;
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  start(): void {
    this.unsubscribers.push(
      this.engine.on('hap', (event) => this.onHap(event)),
      this.engine.on('sectionStart', (id) => this.onSectionStart(id)),
    );
    this.interval = this.timers.setInterval(() => this.tick(), FEED.tickMs);
    this.tick();
  }

  stop(): void {
    if (this.interval !== null) this.timers.clearInterval(this.interval);
    this.interval = null;
    for (const off of this.unsubscribers.splice(0)) off();
    this.cancelBackfill();
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (!paused) {
      this.lastSample = null;
      this.lastQuarter = null;
      this.tick();
    }
  }

  /** A (new) side: backfill its recent past from the engine once. A side that hasn't started has no past. */
  setSide(movement: MovementInfo | null): void {
    if (!movement || movement.id === this.backfillSide || movement.startCycle > this.engine.now()) return;
    this.backfillSide = movement.id;
    this.cancelBackfill();
    const now = this.engine.now();
    // Up to half a bar ahead: haps emitted before the host subscribed are covered too (the renderer dedupes).
    this.backfillChunk(Math.max(movement.startCycle, now - FEED.backfillBars), now + 0.5);
  }

  tick(): void {
    const cycle = this.engine.now();
    const cps = this.engine.cps();
    if (!Number.isFinite(cycle) || !(cps > 0)) return;
    const nowMs = this.epochNow();
    this.syncClock(nowMs, cycle, cps);
    this.updateLabel(cycle, nowMs);
    if (this.paused) return;
    this.sendLevels(nowMs);
    const quarter = Math.floor(cycle * 4);
    if (quarter !== this.lastQuarter) {
      this.lastQuarter = quarter;
      this.lookahead(cycle);
      this.announceUpcoming(cycle);
    }
  }

  private onHap(event: VisualEvent): void {
    this.lastHapCycle = Math.max(this.lastHapCycle, event.cycle);
    if (this.batch.length === 0) queueMicrotask(() => this.flush());
    this.batch.push(forRenderer(event));
  }

  /** The engine emits every hap of a scheduler tick synchronously: one message per tick. */
  private flush(): void {
    if (!this.batch.length) return;
    const events = this.batch;
    this.batch = [];
    this.send({ type: 'events', events });
  }

  private onSectionStart(id: string): void {
    const section = this.engine.sections().find((s) => s.id === id);
    if (section) this.announce(section, this.engine.now());
  }

  private syncClock(nowMs: number, cycle: number, cps: number): void {
    const last = this.lastSample;
    if (last) {
      const elapsed = (nowMs - last.epochMs) / 1000;
      const predicted = last.cycle + elapsed * last.cps;
      const fresh = elapsed * cps < 1 && cps === last.cps && Math.abs(predicted - cycle) <= FEED.clockToleranceSec * cps;
      if (fresh) return;
    }
    this.lastSample = { epochMs: nowMs, cycle, cps };
    this.send({ type: 'clock', sample: this.lastSample });
  }

  private sendLevels(nowMs: number): void {
    if (this.engine.state !== 'running') {
      if (!this.levelsIdle) this.send({ type: 'levels', master: 0, parts: {}, energy: 0 });
      this.levelsIdle = true;
      this.energy = 0;
      return;
    }
    this.levelsIdle = false;
    const meters = this.engine.meters();
    const master = Math.min(1, Math.max(0, (meters.master.rmsDb - FEED.meterFloorDb) / FEED.meterRangeDb));
    const dt = this.lastLevelsAt ? nowMs - this.lastLevelsAt : FEED.tickMs;
    this.lastLevelsAt = nowMs;
    this.energy += (master - this.energy) * (1 - Math.exp(-dt / FEED.energyTauMs));
    this.send({ type: 'levels', master, parts: meters.parts, energy: this.energy });
  }

  private lookahead(cycle: number): void {
    const bars = this.engine.sectionAt(cycle)?.role === 'build' ? BUILD_LOOKAHEAD_BARS : LOOKAHEAD_BARS;
    const toCycle = cycle + bars + FEED.lookaheadMarginBars;
    const events = this.engine.query(cycle, toCycle).map(forRenderer);
    this.send({ type: 'lookahead', fromCycle: cycle, toCycle, events });
    const live = this.lastHapCycle >= cycle - FEED.liveHapBars;
    if (!live) {
      // Silent mode (landing, suspended audio): the record keeps cutting what the room plays.
      const from = Math.max(this.forwardedTo, this.lastHapCycle + 1e-9);
      const due = events.filter((e) => e.cycle >= from);
      if (due.length) this.send({ type: 'events', events: due });
      this.forwardedTo = toCycle;
    }
    const silent = events.length === 0 && !live;
    if (silent && !this.silent) this.send({ type: 'moment', kind: 'silence', cycle });
    this.silent = silent;
  }

  private announceUpcoming(cycle: number): void {
    const current = this.engine.sectionAt(cycle);
    for (const s of this.engine.sections()) {
      if (s.startCycle <= cycle + FEED.announceAheadBars) this.announce(s, cycle, current);
    }
    for (const [id, start] of this.announced) if (start < cycle - FEED.backfillBars) this.announced.delete(id);
  }

  private announce(s: SectionProgram, cycle: number, current: SectionProgram | null = s): void {
    if (this.announced.has(s.id)) return;
    this.announced.set(s.id, s.startCycle);
    if (s.startCycle >= cycle - FEED.lateStartBars) {
      for (const kind of sectionMoments(s.role)) this.moment(kind, s.startCycle);
    } else if (s.id === current?.id && (s.role === 'build' || s.role === 'breakdown')) {
      // Joined mid-section: set the mode without replaying the downbeat's gestures.
      this.moment(s.role, s.startCycle);
    }
  }

  private moment(kind: MomentKind, cycle: number): void {
    if (kind === 'drop') this.pendingDrops = [...this.pendingDrops, cycle].sort((a, b) => a - b);
    this.send({ type: 'moment', kind, cycle });
  }

  private updateLabel(cycle: number, nowMs: number): void {
    while (this.pendingDrops.length && this.pendingDrops[0]! <= cycle) {
      const at = this.pendingDrops.shift()!;
      if (cycle - at < DROP_INVERT_BARS && this.limiter.allowDrop(nowMs)) this.dropAt = at;
    }
    const inverted = this.dropAt !== null && cycle >= this.dropAt && cycle < this.dropAt + DROP_INVERT_BARS;
    if (inverted === this.label.inverted && this.silent === this.label.listening) return;
    this.label = { inverted, listening: this.silent };
    this.onLabel(this.label);
  }

  /** Chunked so a long backfill never becomes a long task on the audio scheduler's thread. */
  private backfillChunk(from: number, to: number): void {
    this.backfillTimer = null;
    const end = Math.min(to, from + FEED.backfillChunkBars);
    const events = this.engine.query(from, end).map(forRenderer);
    if (events.length) this.send({ type: 'events', events });
    if (end < to) this.backfillTimer = this.timers.setTimeout(() => this.backfillChunk(end, to), 16);
  }

  private cancelBackfill(): void {
    if (this.backfillTimer !== null) this.timers.clearTimeout(this.backfillTimer);
    this.backfillTimer = null;
  }
}
