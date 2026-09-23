// Renders part instances into superdough-ready haps (src/client/engine/types.ts, normative header):
// compile (re-validated) → sanitizeModelValue (innermost) → .seed(originCycle).late(originCycle) →
// score-time mapping → window (re-onset at entries, truncation at cuts) → engine keys → guard.
// Knobs are signals of the hap's own time, so every client computes the same values.
import * as core from '@strudel/core';
import type { Knob } from '../../shared/plan.ts';
import type { MixerState } from '../../shared/program.ts';
import { ROLE_FAMILY, type PartRole } from '../../shared/music.ts';
import { MAX_HAPS_PER_TICK, MAX_PART_HAPS_PER_TICK, MAX_PART_ONSETS_PLAYED_PER_BAR, queryBudget, sanitizeModelValue } from '../../shared/limits.ts';
import { scoreBarAt, vampLoopBars } from '../../shared/schedule.ts';
import type { TelemetryErrorCode } from '../../shared/protocol.ts';
import { compilePart } from '../../strudel/compile.ts';
import { isQueryBudgetExceeded, withQueryBudget } from '../../strudel/guard.ts';
import { validatePart } from '../../strudel/validate.ts';
import { instanceGainAt } from './envelope.ts';
import { applyBrightness, clamp, knobAt, macrosAt } from './knobs.ts';
import type { InstanceSpec, Score } from './score.ts';
import type { PartError, VisualEvent } from './types.ts';
import { cutForRun, runs } from './window.ts';

/** A hap ready for superdough, in absolute play cycles. */
export interface PlannedHap {
  inst: InstanceSpec;
  value: Record<string, unknown>;
  onset: number;
  duration: number;
  locations: { start: number; end: number }[];
}

/** Query time budget per part (EMA of ms per tick) before it is muted. */
export const PART_QUERY_BUDGET_MS = 4;
/** Kept first when a tick overflows; dropped from the end. */
export const ROLE_PRIORITY: readonly PartRole[] = ['kick', 'bass', 'snare', 'breaks', 'hats', 'lead', 'vox', 'chords', 'arp', 'perc', 'pad', 'texture'];
const EMA_ALPHA = 0.1;
/** One slow query (GC pause, cold JIT) moves the average by at most this much. */
const MAX_SAMPLE_MS = 3 * PART_QUERY_BUDGET_MS;
/** Queries a part gets before its time budget applies (first queries run cold code). */
const WARMUP_QUERIES = 20;
const MIN_RELEASE_SEC = 0.05;
const EPS = 1e-9;
/**
 * Query bounds live on a dyadic grid (≈ 15 µs at 120 BPM): Strudel's Fraction(float) runs a slow
 * Farey approximation that snaps floats to nearby rationals, which can turn a sliver of a tick into a
 * zero-width query (answered with the onset *at* that point — a double trigger). Grid values are
 * exact floats and convert to exact fractions, and adjacent ticks share their bound exactly.
 */
const GRID = 65536;
export const quantize = (x: number): number => Math.round(x * GRID) / GRID;
const fraction = (x: number) => core.Fraction(`${Math.round(x * GRID)}/${GRID}`);

interface Binding {
  inst: InstanceSpec;
  /** Play cycle minus query cycle for the run being queried. */
  shift: number;
}

interface Compiled {
  pattern: any;
  binding: Binding;
}

interface Guard {
  muted: boolean;
  emaMs: number;
  queries: number;
  bar: number;
  barOnsets: number;
}

export interface PlanOptions {
  cps: number;
  /** Output start after unlock/skip: straddling notes of every instance re-trigger here. */
  resumeAt?: number | null;
  /** Apply the per-tick guard and caps (audio ticks only). */
  guard?: boolean;
  /** Stop after this many haps per instance (visual and preload queries). */
  limitPerInstance?: number;
}

export interface PerformerDeps {
  mixer(): MixerState;
  onError(error: PartError): void;
  perfNow?(): number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

export class Performer {
  private readonly deps: PerformerDeps;
  private readonly compiled = new Map<string, Compiled | null>();
  private readonly guards = new Map<string, Guard>();
  private readonly reported = new Set<string>();
  private readonly perfNow: () => number;
  private droppedHaps = 0;

  constructor(deps: PerformerDeps) {
    this.deps = deps;
    this.perfNow = deps.perfNow ?? (() => performance.now());
  }

  /**
   * Compiles every instance up front (reporting eval errors) and forgets instances that are gone.
   * Several scores stay live while a late change still plays the old one until the next bar.
   */
  prepare(scores: readonly Score[]): void {
    const instances = scores.flatMap((s) => s.instances);
    for (const inst of instances) this.compile(inst);
    const live = new Set(instances.map((i) => this.cacheKey(i)));
    for (const key of this.compiled.keys()) if (!live.has(key)) this.compiled.delete(key);
    const keys = new Set(instances.map((i) => i.key));
    for (const key of this.guards.keys()) if (!keys.has(key)) this.guards.delete(key);
    for (const key of this.reported) if (!keys.has(key.slice(0, key.lastIndexOf('|')))) this.reported.delete(key);
  }

  /** Haps dropped by the per-tick cap since the last call. */
  takeDropped(): number {
    const n = this.droppedHaps;
    this.droppedHaps = 0;
    return n;
  }

  isMuted(key: string): boolean {
    return this.guards.get(key)?.muted ?? false;
  }

  /** Haps with onsets in [from, to) (play cycles, one tempo segment at `cps`). */
  plan(score: Score, rawFrom: number, rawTo: number, opts: PlanOptions): PlannedHap[] {
    const out: PlannedHap[] = [];
    const from = quantize(rawFrom);
    const to = quantize(rawTo);
    if (!(to > from)) return out;
    const resumeAt = opts.resumeAt === null || opts.resumeAt === undefined ? null : quantize(opts.resumeAt);
    for (const inst of score.instances) {
      if (inst.start >= to || inst.end <= from) continue;
      const guard = this.guardOf(inst.key);
      if (guard.muted) continue;
      const compiled = this.compile(inst);
      if (!compiled) continue;
      const t0 = this.perfNow();
      let haps: PlannedHap[];
      try {
        haps = this.query(inst, compiled, from, to, { ...opts, resumeAt });
      } catch (e) {
        if (isQueryBudgetExceeded(e)) this.mute(inst, 'density', `The part was muted: ${e.message} (query budget).`);
        else this.mute(inst, 'query', `The part stopped: its pattern threw while playing (${String((e as Error)?.message ?? e)}).`);
        continue;
      }
      if (opts.guard) {
        if (++guard.queries > WARMUP_QUERIES) guard.emaMs += EMA_ALPHA * (Math.min(MAX_SAMPLE_MS, this.perfNow() - t0) - guard.emaMs);
        if (haps.length > MAX_PART_HAPS_PER_TICK) {
          this.mute(inst, 'density', `The part was muted: ${haps.length} events in one scheduler tick (limit ${MAX_PART_HAPS_PER_TICK}).`);
          continue;
        }
        haps = this.countBars(inst, guard, haps);
        if (guard.emaMs > PART_QUERY_BUDGET_MS) {
          this.mute(inst, 'density', `The part was muted: querying it took ${guard.emaMs.toFixed(1)} ms per tick (budget ${PART_QUERY_BUDGET_MS} ms).`);
        }
      }
      for (const h of haps) out.push(h);
    }
    out.sort((a, b) => a.onset - b.onset);
    return opts.guard ? this.capTick(out) : out;
  }

  /** Visual events in [from, to) without side effects on the audio guard. */
  events(score: Score, from: number, to: number, cps: number): VisualEvent[] {
    const mixer = this.deps.mixer();
    return this.plan(score, from, to, { cps, limitPerInstance: MAX_PART_HAPS_PER_TICK * 16 }).map((h) => toVisualEvent(h, mixer));
  }

  /** Hap values an instance produces over [from, to), for preloading its sounds. */
  values(inst: InstanceSpec, from: number, to: number, cps: number, limit: number): Record<string, unknown>[] {
    const compiled = this.compile(inst);
    if (!compiled || this.isMuted(inst.key)) return [];
    const out: Record<string, unknown>[] = [];
    for (let a = quantize(from); a < to && out.length < limit; a += 1) {
      try {
        for (const h of this.query(inst, compiled, a, quantize(Math.min(to, a + 1)), { cps, limitPerInstance: limit - out.length })) out.push(h.value);
      } catch (e) {
        if (isQueryBudgetExceeded(e)) this.mute(inst, 'density', `The part was muted: ${e.message} (query budget).`);
        break;
      }
    }
    return out;
  }

  /** The span an instance's sounds must be ready for: its extent up to the score's end plus one vamp loop. */
  static preloadSpan(inst: InstanceSpec): [number, number] {
    const s = inst.section;
    const to = Math.min(inst.end, s.startCycle + s.bars + vampLoopBars(s));
    return [inst.start, Math.max(inst.start, to)];
  }

  private cacheKey(inst: InstanceSpec): string {
    return `${inst.key}\u0000${inst.part.code}`;
  }

  private guardOf(key: string): Guard {
    let g = this.guards.get(key);
    if (!g) {
      g = { muted: false, emaMs: 0, queries: 0, bar: Number.NaN, barOnsets: 0 };
      this.guards.set(key, g);
    }
    return g;
  }

  private compile(inst: InstanceSpec): Compiled | null {
    const id = this.cacheKey(inst);
    const cached = this.compiled.get(id);
    if (cached !== undefined) {
      if (cached) cached.binding.inst = inst;
      return cached;
    }
    let result: Compiled | null = null;
    const knobs = new Map(inst.part.knobs.map((k) => [k.name, k]));
    const check = validatePart(inst.part.code, { knobs: [...knobs.keys()] });
    if (!check.ok) {
      this.reportOnce(inst, 'eval', `The part failed validation: ${check.errors[0]?.message ?? 'invalid code'}`);
    } else {
      try {
        const binding: Binding = { inst, shift: 0 };
        const { pattern } = compilePart(inst.part.code, {
          knob: (name) => {
            const knob = knobs.get(name)!;
            return core.signal((t: unknown) => this.knobValue(binding, knob, Number(t)));
          },
        });
        const origin = inst.part.originCycle;
        const sanitized = pattern.withValue((v: unknown) => (isRecord(v) ? sanitizeModelValue(v) : v));
        result = { pattern: sanitized.seed(origin).late(origin), binding };
      } catch (e) {
        this.reportOnce(inst, 'eval', `The part failed to compile: ${String((e as Error)?.message ?? e)}`);
      }
    }
    this.compiled.set(id, result);
    return result;
  }

  private knobValue(binding: Binding, knob: Knob, t: number): number {
    const inst = binding.inst;
    const s = inst.section;
    const query = inst.part.originCycle + t;
    const play = query + binding.shift;
    const bar = inst.continuing ? scoreBarAt(s, play - s.startCycle) : query - s.startCycle;
    return knobAt(inst.part, knob, bar, macrosAt(this.deps.mixer(), play));
  }

  private query(inst: InstanceSpec, compiled: Compiled, from: number, to: number, opts: PlanOptions): PlannedHap[] {
    const out: PlannedHap[] = [];
    const mixer = this.deps.mixer();
    const limit = opts.limitPerInstance ?? Number.POSITIVE_INFINITY;
    const controls = { _cps: opts.cps, cyclist: 'synced' };
    for (const run of runs(inst, from, to, opts.resumeAt ?? null)) {
      if (!(run.to > run.from)) continue;
      const cut = cutForRun(inst, run, to);
      const qFrom = run.from - run.shift;
      compiled.binding.inst = inst;
      compiled.binding.shift = run.shift;
      const span = new core.TimeSpan(fraction(qFrom), fraction(run.to - run.shift));
      const haps = withQueryBudget(queryBudget(run.to - run.from), () => compiled.pattern.query(new core.State(span, controls)));
      for (const hap of haps) {
        if (!hap.whole) continue;
        const wholeBegin = hap.whole.begin.valueOf();
        const partBegin = hap.part.begin.valueOf();
        const length = hap.duration.valueOf();
        let onset: number;
        let duration: number;
        if (hap.hasOnset()) {
          onset = wholeBegin + run.shift;
          duration = length;
        } else if (run.entry && Math.abs(partBegin - qFrom) < EPS && wholeBegin < partBegin) {
          onset = run.from;
          duration = wholeBegin + length - partBegin;
        } else continue;
        if (!(duration > EPS)) continue;
        if (!isRecord(hap.value)) {
          this.reportOnce(inst, 'query', 'The part produced events without sound controls (e.g. a bare string); they are skipped.');
          continue;
        }
        const value: Record<string, unknown> = { ...hap.value };
        if (onset + duration > cut + EPS) {
          duration = cut - onset;
          if (duration <= EPS) continue;
          value.release ??= MIN_RELEASE_SEC;
        }
        applyEngineKeys(value, inst, macrosAt(mixer, onset).brightness);
        out.push({ inst, value, onset, duration, locations: hap.context?.locations ?? [] });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Counts onsets per bar (identical on every client) and mutes a part that exceeds the backstop. */
  private countBars(inst: InstanceSpec, guard: Guard, haps: PlannedHap[]): PlannedHap[] {
    haps.sort((a, b) => a.onset - b.onset);
    for (let i = 0; i < haps.length; i++) {
      const bar = Math.floor(haps[i]!.onset + EPS);
      if (bar !== guard.bar) {
        guard.bar = bar;
        guard.barOnsets = 0;
      }
      if (++guard.barOnsets > MAX_PART_ONSETS_PLAYED_PER_BAR) {
        this.mute(inst, 'density', `The part was muted: more than ${MAX_PART_ONSETS_PLAYED_PER_BAR} events in bar ${bar}.`);
        return haps.slice(0, i);
      }
    }
    return haps;
  }

  /** At most MAX_HAPS_PER_TICK haps per tick, dropping the lowest-priority roles first. */
  private capTick(haps: PlannedHap[]): PlannedHap[] {
    if (haps.length <= MAX_HAPS_PER_TICK) return haps;
    const rank = (h: PlannedHap) => ROLE_PRIORITY.indexOf(h.inst.part.role);
    const byRank = [...haps].sort((a, b) => rank(a) - rank(b) || a.onset - b.onset);
    const keep = new Set(byRank.slice(0, MAX_HAPS_PER_TICK));
    this.droppedHaps += haps.length - keep.size;
    return haps.filter((h) => keep.has(h));
  }

  private mute(inst: InstanceSpec, code: TelemetryErrorCode, message: string): void {
    this.guardOf(inst.key).muted = true;
    this.reportOnce(inst, code, message);
  }

  /** Emits a part error once per instance and code. */
  reportOnce(inst: InstanceSpec, code: TelemetryErrorCode, message: string): void {
    const key = `${inst.key}|${code}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.deps.onError({ sectionId: inst.section.id, partId: inst.part.id, code, message });
  }
}

/** Engine-owned keys: routing, sidechain, per-orbit cut groups, and the brightness macro. */
export function applyEngineKeys(value: Record<string, unknown>, inst: InstanceSpec, brightness: number): void {
  const orbit = inst.part.orbit;
  value.orbit = orbit;
  const duck = inst.part.duck;
  if (duck && duck.orbits.length) {
    value.duckorbit = duck.orbits.length === 1 ? duck.orbits[0] : [...duck.orbits];
    value.duckdepth = duck.depth;
    value.duckattack = duck.releaseSec;
  }
  if (typeof value.cut === 'number') value.cut = orbit * 100 + value.cut;
  applyBrightness(value, brightness);
}

function midiOf(value: Record<string, unknown>): number | null {
  try {
    if (typeof value.freq === 'number') return core.freqToMidi(value.freq);
    if (typeof value.note === 'number') return value.note;
    if (typeof value.note === 'string') return core.noteToMidi(value.note);
  } catch {
    return null;
  }
  return null;
}

export function toVisualEvent(h: PlannedHap, mixer: MixerState): VisualEvent {
  const v = h.value;
  const s = typeof v.s === 'string' ? v.s : 'triangle';
  const sound = (typeof v.bank === 'string' ? `${v.bank}_${s}` : s).toLowerCase();
  const level = num(v.gain, 0.8) * num(v.velocity, 1) * num(v.postgain, 1) * instanceGainAt(h.inst, h.onset, mixer);
  return {
    sectionId: h.inst.section.id,
    partId: h.inst.part.id,
    instance: h.inst.key,
    role: h.inst.part.role,
    family: ROLE_FAMILY[h.inst.part.role],
    cycle: h.onset,
    duration: h.duration,
    midi: midiOf(v),
    gain: clamp(level, 0, 1),
    pan: clamp(num(v.pan, 0.5), 0, 1),
    sound,
    locations: h.locations,
  };
}
