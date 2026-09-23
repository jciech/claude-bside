// The performer engine behind the Engine contract (src/client/engine/types.ts). One 50 ms loop
// (worker timers) drives everything: section-start events, the unlock start, the SyncedScheduler,
// channel/master curve planning, risers, the personal mix and meters. Schedule state is replaced
// atomically; a change that touches cycles already handed to superdough applies from the next bar.
import { getSuperdoughAudioController, superdough } from '@strudel/webaudio';
import { EMPTY_MIXER, type MixerState, type SectionProgram } from '../../shared/program.ts';
import { cpsAtCycle, cpsAtMs, cycleAtMs, msAtCycle, type Timeline } from '../../shared/timeline.ts';
import { influenceCycle, SCHEDULER_LOOKAHEAD_S } from '../../shared/schedule.ts';
import type { Catalog } from '../../shared/catalog.ts';
import type { Telemetry } from '../../shared/protocol.ts';
import { audioContext, bindStrudelTime, initAudioGraph, resumeInGesture } from './boot.ts';
import { ChannelBank } from './channels.ts';
import { instanceKnobsAt, instanceLevelAt } from './envelope.ts';
import { MASTER_DELAY_SEC, MasterChain } from './master.ts';
import { loudness, MeterSmoother, silentMeters } from './meters.ts';
import { Performer, toVisualEvent, type PlannedHap } from './performer.ts';
import { Preloader, resolveAsset } from './preload.ts';
import { RiserVoice } from './riser.ts';
import { SyncedScheduler, splitAtSegments } from './scheduler.ts';
import { affectedFrom, buildScore, sectionAt, timelineDiffFrom, type Score } from './score.ts';
import { loadCatalog, registerSounds } from './sounds.ts';
import { backgroundTimers, type Timers } from './timers.ts';
import type { Engine, EngineEvents, EngineOptions, EngineSnapshot, EngineState, Meters, PartError, VisualEvent } from './types.ts';

const LOOP_MS = 50;
/** Channel and master curves are planned this far past the scheduler's lookahead. */
const PLAN_MARGIN_S = 0.15;
/** Output starts at a bar at least this far ahead (seconds), so the fade-in can be scheduled. */
const START_LEAD_S = SCHEDULER_LOOKAHEAD_S + 0.1;
/** unlock() waits at most this many bars for the current section's sounds. */
const MAX_WAIT_BARS = 2;
const PREPARE_TIMEOUT_MS = 20_000;
/** Sections that ended this long ago are forgotten (memory over long sessions). */
const FORGET_AFTER_BARS = 16;
/** Wavetables are warmed by a silent hap on an orbit that is never connected. */
const WARM_ORBIT = 99;
const WARM_AHEAD_SEC = 30;
const MAX_ERRORS = 64;

type Listeners = { [E in keyof EngineEvents]: Set<EngineEvents[E]> };
type ScoreEntry = { score: Score; from: number };

/** Test/diagnostic view of an engine's internals (browser harness only). */
export interface EngineInternals {
  channel(orbit: number): { gain: number; lowpass: number; highpass: number; mute: number } | null;
  /** Linear RMS per orbit channel right now. */
  levels(): Map<number, number>;
  onOutput(listener: (hap: PlannedHap, audioTime: number, durationSec: number) => void): () => void;
  isMuted(instance: string): boolean;
  audioTimeAtCycle(cycle: number): number | null;
  /** Cycle of the audio being rendered right now (what an analyser sees). */
  renderedCycle(): number | null;
  score(): Score;
}

const internals = new WeakMap<Engine, EngineInternals>();

export function engineInternals(engine: Engine): EngineInternals | undefined {
  return internals.get(engine);
}

export function createEngine(options: EngineOptions): Engine {
  return new PerformerEngine(options);
}

class PerformerEngine implements Engine {
  state: EngineState = 'idle';
  private readonly options: EngineOptions;
  private readonly timers: Timers = backgroundTimers();
  private readonly listeners: Listeners = {
    state: new Set(),
    hap: new Set(),
    partError: new Set(),
    sectionStart: new Set(),
    preload: new Set(),
    health: new Set(),
    needsGesture: new Set(),
  };
  private readonly resyncListeners = new Set<() => void>();
  private readonly outputListeners = new Set<(hap: PlannedHap, audioTime: number, durationSec: number) => void>();
  private readonly performer: Performer;

  private epoch: string | null = null;
  private rev = -1;
  private timeline: Timeline | null = null;
  private mixer: MixerState = EMPTY_MIXER;
  private readonly sectionsById = new Map<string, SectionProgram>();
  /** When each section was first seen (performance.now()), and as a cycle once the clock is synced. */
  private readonly arrivedAtPerf = new Map<string, number>();
  private readonly arrivals = new Map<string, number>();
  private clockReady = false;
  private scores: ScoreEntry[] = [{ score: buildScore([], new Map()), from: Number.NEGATIVE_INFINITY }];

  private catalog: Catalog | null = null;
  private soundsReady = false;
  private preparing: Promise<void> | null = null;
  private preloader: Preloader | null = null;
  private readonly preloaded = new Map<string, Promise<void>>();
  private readonly sectionReady = new Set<string>();
  private readonly preloadFailed: string[] = [];

  private scheduler: SyncedScheduler | null = null;
  private channels: ChannelBank | null = null;
  private master: MasterChain | null = null;
  private riser: RiserVoice | null = null;
  /** The unlock in progress; suspend() or an interruption abandons it (see cancelStart). */
  private unlocking: { done: Promise<void> } | null = null;
  private pendingStart: { deadline: number; resolve: () => void } | null = null;
  /** Our own suspend() in progress: the context's state change is not an interruption. */
  private suspending: unknown = null;

  private readonly localMutes = new Set<string>();
  private volume = 1;
  private readonly errors: PartError[] = [];
  private lastAnnounced: number | null = null;
  private recent: { event: VisualEvent; end: number }[] = [];
  private activeCache: { at: number; value: Map<string, { start: number; end: number }[]> } | null = null;
  private readonly meterSmoother = new MeterSmoother();
  private lastHealthAt = 0;
  private lastSampleAt = 0;

  constructor(options: EngineOptions) {
    this.options = options;
    this.performer = new Performer({ mixer: () => this.mixer, onError: (e) => this.partError(e) });
    bindStrudelTime(() => this.now());
    this.timers.setInterval(() => this.loop(), LOOP_MS);
    // Curves planned ahead used the old offset; re-plan them from now.
    options.clock.onStep(() => {
      this.channels?.restart();
      this.master?.restart();
    });
    void options.clock.ready.then(() => {
      this.clockReady = true;
      this.resolveArrivals();
      if (this.timeline) this.replaceScore();
    });
    internals.set(this, {
      channel: (orbit) => this.channels?.inspect(orbit) ?? null,
      levels: () => this.channels?.levels() ?? new Map(),
      onOutput: (l) => {
        this.outputListeners.add(l);
        return () => this.outputListeners.delete(l);
      },
      isMuted: (key) => this.performer.isMuted(key),
      audioTimeAtCycle: (c) => this.scheduler?.audioTimeAtCycle(c) ?? null,
      renderedCycle: () => (this.scheduler?.running ? this.scheduler.cycleAtAudioTime(audioContext().currentTime) : null),
      score: () => this.currentScore(),
    });
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────────────────────────

  prepare(): Promise<void> {
    this.preparing ??= (async () => {
      if (this.state === 'idle' || this.state === 'error') this.setState('preparing');
      const base = new URL(this.options.catalogUrl, globalThis.location?.href ?? 'http://localhost/');
      this.catalog = await loadCatalog(base.href);
      const failedMaps = await registerSounds(this.catalog, (path) => new URL(path, base).href);
      for (const id of failedMaps) this.notePreloadFailed(`map:${id}`);
      this.soundsReady = true;
      this.preloader = new Preloader({
        ac: () => audioContext(),
        warm: (value) => this.warm(value),
      });
      await initAudioGraph();
      this.ensureAudio();
      this.schedulePreload();
      await this.currentSectionReady(PREPARE_TIMEOUT_MS);
      if (this.state === 'preparing') this.setState('ready');
    })().catch((e: unknown) => {
      this.preparing = null;
      this.setState('error');
      throw e;
    });
    return this.preparing;
  }

  unlock(): Promise<void> {
    // Synchronous first: Safari only honours resume() inside the gesture's synchronous part.
    const resumed = resumeInGesture();
    if (this.suspending !== null) {
      this.timers.clearTimeout(this.suspending);
      this.suspending = null;
    }
    if (this.state === 'running' && this.scheduler?.running && audioContext().state === 'running') return Promise.resolve();
    if (this.unlocking) return this.unlocking.done;
    const attempt = { done: Promise.resolve() };
    this.unlocking = attempt;
    attempt.done = (async () => {
      this.setState('unlocking');
      try {
        await resumed;
        await this.options.clock.ready;
        await this.prepare();
        this.ensureAudio();
        if (this.unlocking !== attempt) return;
        if (audioContext().state !== 'running') {
          this.interrupted();
          return;
        }
        await new Promise<void>((resolve) => {
          this.pendingStart = { deadline: this.now() + MAX_WAIT_BARS, resolve };
        });
      } catch (e) {
        this.setState('error');
        throw e;
      } finally {
        if (this.unlocking === attempt) this.unlocking = null;
      }
    })();
    return attempt.done;
  }

  suspend(): void {
    this.cancelStart();
    if (!this.master || !this.scheduler) {
      if (this.state === 'unlocking') this.setState('suspended');
      return;
    }
    this.master.fadeOut(0.15);
    this.scheduler.stop();
    this.riser?.stopAll();
    const id = this.timers.setTimeout(() => {
      void audioContext()
        .suspend()
        .finally(() => {
          if (this.suspending === id) this.suspending = null;
        });
    }, 200);
    this.suspending = id;
    this.setState('suspended');
  }

  // ─── schedule ─────────────────────────────────────────────────────────────────────────────────

  applySnapshot(snapshot: EngineSnapshot): void {
    const newEpoch = this.epoch !== null && snapshot.epoch !== this.epoch;
    const before = new Map(this.sectionsById);
    if (newEpoch) this.retireEpoch(snapshot.timeline);
    const oldTimeline = this.timeline;
    this.epoch = snapshot.epoch;
    this.rev = snapshot.rev;
    this.timeline = snapshot.timeline;
    this.mixer = snapshot.mixer;
    this.sectionsById.clear();
    for (const s of snapshot.sections) this.sectionsById.set(s.id, s);
    // The server only sends from the section before the current one: older ones we hold are history
    // it pruned, not a change. They go when forgetOldSections says so.
    const first = snapshot.sections.length ? Math.min(...snapshot.sections.map((s) => s.startCycle)) : Number.NEGATIVE_INFINITY;
    if (!newEpoch) for (const [id, s] of before) if (s.startCycle < first) this.sectionsById.set(id, s);
    this.noteArrivals(snapshot.sections);
    if (newEpoch || !oldTimeline) {
      this.replaceScore();
      return;
    }
    const changes = this.diff(before);
    this.rebuild(Math.min(changes.from, timelineDiffFrom(oldTimeline, snapshot.timeline)), changes.ids);
  }

  applySchedule(update: { epoch: string; rev: number; timeline: Timeline; upserts: SectionProgram[]; revokes: string[] }): void {
    if (update.epoch !== this.epoch) {
      this.requestResync();
      return;
    }
    if (update.rev <= this.rev) return;
    const gap = update.rev > this.rev + 1;
    const before = new Map(this.sectionsById);
    const oldTimeline = this.timeline!;
    this.rev = update.rev;
    this.timeline = update.timeline;
    for (const s of update.upserts) this.sectionsById.set(s.id, s);
    for (const id of update.revokes) this.sectionsById.delete(id);
    this.noteArrivals(update.upserts);
    const changes = this.diff(before);
    this.rebuild(Math.min(changes.from, timelineDiffFrom(oldTimeline, update.timeline)), changes.ids);
    if (gap) this.requestResync();
  }

  onResyncNeeded(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  setMixer(mixer: MixerState): void {
    if (mixer.rev < this.mixer.rev) return;
    this.mixer = mixer;
  }

  // ─── time and queries ────────────────────────────────────────────────────────────────────────

  now(): number {
    return this.timeline ? cycleAtMs(this.timeline, this.options.clock.serverNow()) : 0;
  }

  cps(): number {
    return this.timeline ? cpsAtMs(this.timeline, this.options.clock.serverNow()) : 0.5;
  }

  query(fromCycle: number, toCycle: number): VisualEvent[] {
    if (!this.timeline || !(toCycle > fromCycle)) return [];
    const out: VisualEvent[] = [];
    for (const [a, b, cps] of splitAtSegments(this.timeline, fromCycle, toCycle)) {
      for (const [score, x, y] of this.scorePieces(a, b)) out.push(...this.performer.events(score, x, y, cps));
    }
    return out.sort((p, q) => p.cycle - q.cycle);
  }

  activeLocations(): Map<string, { start: number; end: number }[]> {
    const now = this.now();
    if (this.activeCache && Math.abs(this.activeCache.at - now) < 0.02) return this.activeCache.value;
    const events = this.scheduler?.running ? this.recent.map((r) => r.event) : this.query(now - 4, now + 1e-6);
    const value = new Map<string, { start: number; end: number }[]>();
    for (const e of events) {
      if (e.cycle > now || e.cycle + e.duration <= now || !e.locations.length) continue;
      const list = value.get(e.instance) ?? [];
      for (const loc of e.locations) if (!list.some((l) => l.start === loc.start && l.end === loc.end)) list.push(loc);
      value.set(e.instance, list);
    }
    this.activeCache = { at: now, value };
    return value;
  }

  sectionAt(cycle: number): SectionProgram | null {
    return sectionAt(this.scoreAt(cycle).sections, cycle);
  }

  sections(): SectionProgram[] {
    return [...this.currentScore().sections];
  }

  preloadProgress(): { loaded: number; total: number } {
    return this.preloader?.progress() ?? { loaded: 0, total: 0 };
  }

  meters(): Meters {
    const { master, channels } = this;
    if (!master || !channels || !this.scheduler?.running) return silentMeters();
    return this.meterSmoother.read(audioContext().currentTime, () => {
      const now = this.now();
      const score = this.scoreAt(now);
      const parts: Record<string, number> = {};
      for (const [orbit, rms] of channels.levels()) {
        const owner = ChannelBank.ownerAt(score, orbit, now);
        if (owner) parts[owner.key] = loudness(rms);
      }
      return { master: master.meters(), parts };
    });
  }

  knobValues(instance: string, cycle: number): Record<string, number> {
    const inst = this.scoreAt(cycle).byKey.get(instance);
    return inst ? instanceKnobsAt(inst, cycle, this.mixer) : {};
  }

  levelAt(instance: string, cycle: number): number {
    const inst = this.scoreAt(cycle).byKey.get(instance);
    return inst ? instanceLevelAt(inst, cycle) : 0;
  }

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.master?.setVolume(this.volume);
  }

  setLocalMute(partId: string, muted: boolean): void {
    if (muted) this.localMutes.add(partId);
    else this.localMutes.delete(partId);
    this.channels?.setMuted(this.localMutes);
  }

  telemetry(): Telemetry {
    const stats = this.master?.takeStats() ?? { rmsDb: -120, peakDb: -120, centroidHz: 0, clipPct: 0 };
    const now = this.now();
    const errors = this.errors.splice(0).map((e) => ({ sectionId: e.sectionId.slice(0, 24), partId: e.partId.slice(0, 16), code: e.code }));
    if (stats.clipPct >= 1) errors.unshift({ sectionId: (this.sectionAt(now)?.id ?? '').slice(0, 24), partId: '', code: 'clip' });
    const clampTo = (x: number, lo: number, hi: number) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);
    return {
      cycle: Number.isFinite(now) ? now : 0,
      rmsDb: clampTo(stats.rmsDb, -120, 12),
      peakDb: clampTo(stats.peakDb, -120, 12),
      centroidHz: clampTo(stats.centroidHz, 0, 24000),
      clipPct: clampTo(stats.clipPct, 0, 100),
      errors: dedupe(errors).slice(0, 8),
      preloadFailed: this.preloadFailed.slice(0, 8).map((s) => s.slice(0, 64)),
    };
  }

  analyser(): AnalyserNode | null {
    return this.state === 'running' ? (this.master?.analyser ?? null) : null;
  }

  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): () => void {
    const set = this.listeners[event] as Set<EngineEvents[E]>;
    set.add(listener);
    return () => set.delete(listener);
  }

  // ─── internals ────────────────────────────────────────────────────────────────────────────────

  private emit<E extends keyof EngineEvents>(event: E, ...args: Parameters<EngineEvents[E]>): void {
    for (const l of this.listeners[event]) {
      try {
        (l as (...a: Parameters<EngineEvents[E]>) => void)(...args);
      } catch (e) {
        console.error(`[engine] ${event} listener failed`, e);
      }
    }
  }

  private setState(state: EngineState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  private partError(error: PartError): void {
    this.errors.push(error);
    if (this.errors.length > MAX_ERRORS) this.errors.shift();
    this.emit('partError', error);
  }

  private notePreloadFailed(label: string): void {
    if (!this.preloadFailed.includes(label)) this.preloadFailed.push(label);
    if (this.preloadFailed.length > 32) this.preloadFailed.shift();
  }

  private requestResync(): void {
    for (const l of this.resyncListeners) l();
  }

  private currentScore(): Score {
    return this.scores[this.scores.length - 1]!.score;
  }

  private scoreAt(cycle: number): Score {
    let found = this.scores[0]!.score;
    for (const e of this.scores) if (e.from <= cycle) found = e.score;
    return found;
  }

  /** [from, to) split where a pending late change switches scores. */
  private scorePieces(from: number, to: number): [Score, number, number][] {
    const out: [Score, number, number][] = [];
    this.scores.forEach((e, i) => {
      const a = Math.max(from, e.from);
      const b = Math.min(to, this.scores[i + 1]?.from ?? Number.POSITIVE_INFINITY);
      if (b > a) out.push([e.score, a, b]);
    });
    return out;
  }

  private noteArrivals(sections: readonly SectionProgram[]): void {
    const t = performance.now();
    for (const s of sections) if (!this.arrivedAtPerf.has(s.id)) this.arrivedAtPerf.set(s.id, t);
    this.resolveArrivals();
  }

  /** Arrival cycles need the synced clock; before it is ready no transition window is skipped. */
  private resolveArrivals(): void {
    if (!this.clockReady || !this.timeline) return;
    for (const [id, t] of this.arrivedAtPerf) {
      if (!this.arrivals.has(id)) this.arrivals.set(id, cycleAtMs(this.timeline, t + this.options.clock.offsetMs()));
    }
  }

  /** The sections that changed since `before`, and the earliest cycle whose rendering that changes. */
  private diff(before: ReadonlyMap<string, SectionProgram>): { from: number; ids: string[] } {
    let from = Number.POSITIVE_INFINITY;
    const ids: string[] = [];
    for (const [id, s] of this.sectionsById) {
      const old = before.get(id);
      if (old && old.rev === s.rev) continue;
      ids.push(id);
      from = Math.min(from, affectedFrom(old, s));
    }
    for (const [id, old] of before) {
      if (this.sectionsById.has(id)) continue;
      ids.push(id);
      from = Math.min(from, affectedFrom(old, undefined));
    }
    return { from, ids };
  }

  private replaceScore(): void {
    const score = buildScore([...this.sectionsById.values()], this.arrivals);
    this.scores = [{ score, from: Number.NEGATIVE_INFINITY }];
    this.afterScoreChange();
  }

  /** Swaps in a rebuilt score; a change reaching cycles already handed over applies from the next bar. */
  private rebuild(affected: number, changedIds: readonly string[]): void {
    const score = buildScore([...this.sectionsById.values()], this.arrivals);
    const handed = this.scheduler?.running ? this.scheduler.lastEnd : null;
    const pending = this.scores.length > 1 ? this.scores[this.scores.length - 1]!.from : null;
    let from = Number.NEGATIVE_INFINITY;
    if (handed !== null && affected < handed) {
      from = Math.floor(handed) + 1;
      for (const id of changedIds) this.partError({ sectionId: id, partId: '', code: 'late-schedule', message: `A schedule change arrived after its cycles were already playing; it applies from bar ${from}.` });
    } else if (pending !== null) {
      from = pending;
    }
    if (from === Number.NEGATIVE_INFINITY) this.scores = [{ score, from }];
    else this.scores = [...this.scores.filter((e) => e.from <= (handed ?? Number.NEGATIVE_INFINITY)), { score, from }];
    this.channels?.replanFrom(Math.max(from, handed ?? this.now()));
    this.afterScoreChange();
  }

  private afterScoreChange(): void {
    this.performer.prepare(this.scores.map((e) => e.score));
    this.activeCache = null;
    if (this.channels) for (const inst of this.currentScore().instances) this.ensureOrbits(inst.part);
    this.schedulePreload();
  }

  private retireEpoch(next: Timeline): void {
    this.riser?.stopAll();
    this.arrivals.clear();
    this.arrivedAtPerf.clear();
    this.lastAnnounced = null;
    if (!this.scheduler?.running || !this.channels || !this.timeline) return;
    const ac = audioContext();
    const t0 = ac.currentTime + 0.05;
    const t1 = t0 + 1 / cpsAtCycle(this.timeline, this.now());
    const resume = cycleAtMs(next, this.scheduler.serverMsAtAudioTime(t1));
    this.channels.retire(t0, t1, resume);
    this.master?.retire(resume);
    this.scheduler.start(resume);
  }

  private ensureAudio(): void {
    if (this.master) return;
    const ac = audioContext();
    this.master = new MasterChain(ac);
    this.master.setVolume(this.volume);
    const controller = getSuperdoughAudioController();
    // Anything superdough routes on its own still passes the master chain.
    controller.output.destinationGain.disconnect();
    controller.output.destinationGain.connect(this.master.input);
    controller.getOrbit(WARM_ORBIT, [0, 1]).output.disconnect();
    this.channels = new ChannelBank(ac, this.master.input);
    this.channels.setMuted(this.localMutes);
    this.riser = new RiserVoice(ac, this.master.input);
    this.scheduler = new SyncedScheduler({
      audio: {
        currentTime: () => ac.currentTime,
        outputTimestamp: () => (typeof ac.getOutputTimestamp === 'function' ? (ac.getOutputTimestamp() as { contextTime: number; performanceTime: number }) : null),
        latencySec: () => (ac.baseLatency || 0) + (ac.outputLatency || 0),
      },
      serverNow: () => this.options.clock.serverNow(),
      perfNow: () => performance.now(),
      timeline: () => this.timeline!,
      plan: (from, to, cps, resumeAt) => {
        const out: PlannedHap[] = [];
        for (const [score, a, b] of this.scorePieces(from, to)) {
          out.push(...this.performer.plan(score, a, b, { cps, resumeAt: resumeAt !== null && resumeAt >= a && resumeAt < b ? resumeAt : null, guard: true }));
        }
        return out;
      },
      output: (hap, at, durationSec, cps) => this.output(hap, at, durationSec, cps),
      outputDelaySec: MASTER_DELAY_SEC,
    });
    for (const inst of this.currentScore().instances) this.ensureOrbits(inst.part);
    ac.onstatechange = () => this.onAudioState(ac.state);
  }

  private ensureOrbits(part: { orbit: number; duck: { orbits: number[] } | null }): void {
    this.channels!.ensure(part.orbit);
    for (const o of part.duck?.orbits ?? []) this.channels!.ensure(o);
  }

  private onAudioState(state: AudioContextState | 'interrupted'): void {
    if (state === 'running' || this.suspending !== null) return;
    if (this.state === 'running' || this.state === 'unlocking') this.interrupted();
  }

  /** The context stopped under us (OS interruption): stop output and ask for a gesture. */
  private interrupted(): void {
    // Context time froze: haps already handed over would play late on resume.
    this.master?.silence();
    this.riser?.stopAll();
    this.scheduler?.stop();
    this.cancelStart();
    this.setState('suspended');
    this.emit('needsGesture');
  }

  /** Abandons an unlock in progress: its promise settles and the next unlock() starts a new attempt. */
  private cancelStart(): void {
    const pending = this.pendingStart;
    this.pendingStart = null;
    this.unlocking = null;
    pending?.resolve();
  }

  private output(hap: PlannedHap, at: number, durationSec: number, cps: number): void {
    this.ensureOrbits(hap.inst.part);
    const inst = hap.inst;
    // superdough rewrites its argument (`s` gets the bank prefix, `duration` is added).
    superdough({ ...hap.value }, at, durationSec, cps, hap.onset).catch((e: unknown) => {
      const message = String((e as Error)?.message ?? e);
      this.performer.reportOnce(inst, /not found|not loaded|is it loaded/i.test(message) ? 'sound-missing' : 'query', `superdough: ${message}`);
    });
    for (const l of this.outputListeners) l(hap, at, durationSec);
    const event = toVisualEvent(hap, this.mixer);
    this.recent.push({ event, end: hap.onset + hap.duration });
    this.emit('hap', event, (msAtCycle(this.timeline!, hap.onset) - this.options.clock.serverNow()) / 1000);
  }

  /** Decodes a wavetable into superdough's caches by triggering a silent note far enough ahead to outlast the load. */
  private warm(value: Record<string, unknown>): Promise<void> {
    const ac = audioContext();
    const silent: Record<string, unknown> = { ...value, gain: 0, orbit: WARM_ORBIT };
    delete silent.duckorbit;
    return Promise.resolve(superdough(silent, ac.currentTime + WARM_AHEAD_SEC, 0.05, 0.5, 0)).then(() => undefined);
  }

  private schedulePreload(): void {
    if (!this.soundsReady || !this.preloader || !this.timeline) return;
    const now = this.now();
    const score = this.currentScore();
    for (const section of score.sections) {
      const key = `${section.id}@${section.rev}`;
      if (this.preloaded.has(key)) continue;
      const instances = score.instances.filter((i) => i.section.id === section.id);
      if (instances.length && instances.every((i) => i.end < now)) continue;
      this.preloaded.set(key, this.preloadSection(section, instances));
    }
  }

  private async preloadSection(section: SectionProgram, instances: Score['instances']): Promise<void> {
    const failed = new Set<string>();
    const jobs: Promise<void>[] = [];
    const cps = cpsAtCycle(this.timeline!, section.startCycle);
    const base = this.catalog?.soundfontBase ?? '';
    for (const inst of instances) {
      await new Promise((r) => this.timers.setTimeout(() => r(null), 0));
      const [from, to] = Performer.preloadSpan(inst);
      const seen = new Set<string>();
      for (const value of this.performer.values(inst, from, to, cps, 4096)) {
        const r = resolveAsset(value, base);
        if (r.kind === 'missing') {
          if (!seen.has(r.sound)) this.performer.reportOnce(inst, 'sound-missing', `Unknown sound "${r.sound}".`);
          seen.add(r.sound);
          continue;
        }
        if (r.kind !== 'asset' || seen.has(r.asset.key)) continue;
        seen.add(r.asset.key);
        const asset = r.asset;
        jobs.push(
          this.preloader!.load(asset).then((ok) => {
            if (ok) return;
            failed.add(asset.label);
            this.notePreloadFailed(asset.label);
            this.performer.reportOnce(inst, 'preload', `Could not load ${asset.label}.`);
          }),
        );
      }
    }
    await Promise.all(jobs);
    this.sectionReady.add(section.id);
    this.emit('preload', section.id, { ready: true, failed: [...failed] });
  }

  private async currentSectionReady(timeoutMs: number): Promise<void> {
    const wait = new Promise<void>((resolve) => this.timers.setTimeout(resolve, timeoutMs));
    const target = this.relevantSection();
    const job = target ? this.preloaded.get(`${target.id}@${target.rev}`) : undefined;
    await Promise.race([job ?? Promise.resolve(), wait]);
  }

  /** The section sounding now, or the first upcoming one. */
  private relevantSection(): SectionProgram | null {
    const now = this.now();
    const sections = this.currentScore().sections;
    return sectionAt(sections, now) ?? sections.find((s) => influenceCycle(s) >= now) ?? null;
  }

  private loop(): void {
    try {
      if (!this.timeline) return;
      const now = this.now();
      this.announceSections(now);
      if (this.pendingStart) this.maybeStart(now);
      const scheduler = this.scheduler;
      if (scheduler?.running && this.channels && this.master && this.riser) {
        scheduler.tick();
        const ac = audioContext();
        const nowCycle = scheduler.cycleAtAudioTime(ac.currentTime);
        const horizon = scheduler.cycleAtAudioTime(ac.currentTime + SCHEDULER_LOOKAHEAD_S + PLAN_MARGIN_S);
        const ctx = { scoreAt: (c: number) => this.scoreAt(c), mixer: () => this.mixer, audioTimeAt: (c: number) => scheduler.audioTimeAtCycle(c) };
        this.channels.plan(nowCycle, horizon, ctx);
        this.master.plan(nowCycle, horizon, this.mixer, ctx.audioTimeAt);
        this.planRisers(nowCycle, horizon);
        const handed = scheduler.lastEnd ?? now;
        while (this.scores.length > 1 && handed >= this.scores[1]!.from && nowCycle >= this.scores[1]!.from) {
          this.scores.shift();
          this.scores[0]!.from = Number.NEGATIVE_INFINITY;
        }
        this.recent = this.recent.filter((r) => r.end > now - 1);
        this.sampleMeters();
      }
      this.forgetOldSections(now);
    } catch (e) {
      console.error('[engine] loop failed', e);
    }
  }

  private maybeStart(now: number): void {
    const pending = this.pendingStart!;
    const scheduler = this.scheduler;
    if (!scheduler || !this.master || !this.channels || !this.timeline) return;
    const at = Math.ceil(now + START_LEAD_S * this.cps());
    const section = this.sectionAt(at) ?? this.relevantSection();
    if (section && !this.sectionReady.has(section.id) && now < pending.deadline) return;
    this.pendingStart = null;
    scheduler.start(at);
    this.channels.restart();
    this.master.restart();
    this.master.fadeIn(scheduler.audioTimeAtCycle(at), scheduler.audioTimeAtCycle(at + 1));
    this.setState('running');
    pending.resolve();
  }

  private planRisers(nowCycle: number, horizon: number): void {
    const score = this.scoreAt(horizon);
    for (const r of score.risers) {
      if (r.from > horizon || r.to <= nowCycle || this.riser!.has(r.sectionId)) continue;
      const startCycle = Math.max(r.from, nowCycle + 0.01);
      const progress = (startCycle - r.from) / Math.max(1e-6, r.to - r.from);
      this.riser!.schedule(r.sectionId, this.scheduler!.audioTimeAtCycle(startCycle), this.scheduler!.audioTimeAtCycle(r.to), progress);
    }
  }

  private announceSections(now: number): void {
    // Before the clock is synced, now() is not a meaningful cycle.
    const last = this.clockReady ? this.lastAnnounced : null;
    this.lastAnnounced = this.clockReady ? now : null;
    if (last === null || now <= last) return;
    for (const s of this.currentScore().sections) if (s.startCycle > last && s.startCycle <= now) this.emit('sectionStart', s.id);
  }

  private sampleMeters(): void {
    const t = performance.now();
    if (t - this.lastSampleAt >= 250) {
      this.lastSampleAt = t;
      this.master!.sample();
    }
    if (t - this.lastHealthAt >= 1000) {
      this.lastHealthAt = t;
      const h = this.scheduler!.takeHealth();
      h.droppedHaps += this.performer.takeDropped();
      this.emit('health', h);
    }
  }

  private forgetOldSections(now: number): void {
    const sections = this.currentScore().sections;
    if (this.scores.length > 1) return;
    const stale = sections.filter((s, i) => {
      const after = sections[i + 2];
      return after !== undefined && after.startCycle + FORGET_AFTER_BARS < now;
    });
    if (!stale.length) return;
    for (const s of stale) {
      this.sectionsById.delete(s.id);
      this.arrivals.delete(s.id);
      this.arrivedAtPerf.delete(s.id);
      this.sectionReady.delete(s.id);
      this.preloaded.delete(`${s.id}@${s.rev}`);
    }
    this.replaceScore();
  }
}

function dedupe<T extends { sectionId: string; partId: string; code: string }>(errors: T[]): T[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const k = `${e.sectionId}|${e.partId}|${e.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
