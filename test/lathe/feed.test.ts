import { describe, expect, it } from 'vitest';
import type { EngineEvents, EngineState, Meters, VisualEvent } from '../../src/client/engine/types.ts';
import type { SectionProgram } from '../../src/shared/program.ts';
import type { SectionRole } from '../../src/shared/music.ts';
import { EngineFeed, FEED, type FeedEngine, type FeedTimers, type LabelState } from '../../src/client/render/feed.ts';
import type { ToRenderer } from '../../src/client/render/protocol.ts';

function kick(cycle: number, sectionId = 's1'): VisualEvent {
  return {
    sectionId,
    partId: 'kick',
    instance: `${sectionId}:kick`,
    role: 'kick',
    family: 'kick',
    cycle,
    duration: 0.25,
    midi: null,
    gain: 0.9,
    pan: 0.5,
    sound: 'sbd',
    locations: [{ start: 3, end: 6 }],
  };
}

function section(id: string, role: SectionRole, startCycle: number, bars = 16): SectionProgram {
  return { id, role, startCycle, bars } as SectionProgram;
}

/** An engine on a fake clock: four kicks per bar everywhere, sections as given. */
class FakeEngine implements FeedEngine {
  state: EngineState = 'ready';
  cycle = 10;
  tempo = 0.5;
  silent = false;
  list: SectionProgram[] = [];
  queries: [number, number][] = [];
  meterCalls = 0;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  now(): number {
    return this.cycle;
  }
  cps(): number {
    return this.tempo;
  }
  query(from: number, to: number): VisualEvent[] {
    this.queries.push([from, to]);
    if (this.silent || !(to > from)) return [];
    const out: VisualEvent[] = [];
    for (let c = Math.ceil(from * 4) / 4; c < to; c += 0.25) out.push(kick(c));
    return out;
  }
  sections(): SectionProgram[] {
    return [...this.list];
  }
  sectionAt(cycle: number): SectionProgram | null {
    const started = this.list.filter((s) => s.startCycle <= cycle);
    return started[started.length - 1] ?? null;
  }
  meters(): Meters {
    this.meterCalls++;
    return { master: { rmsDb: -20, peakDb: -6 }, parts: { 's1:kick': 0.7 } };
  }
  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): () => void {
    const set = this.listeners.get(event) ?? new Set();
    this.listeners.set(event, set);
    const l = listener as (...args: unknown[]) => void;
    set.add(l);
    return () => set.delete(l);
  }
  emit<E extends keyof EngineEvents>(event: E, ...args: Parameters<EngineEvents[E]>): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

class ManualTimers implements FeedTimers {
  timeouts: { fn: () => void; id: number }[] = [];
  private next = 1;
  setInterval(): unknown {
    return 0;
  }
  clearInterval(): void {}
  setTimeout(fn: () => void): unknown {
    const id = this.next++;
    this.timeouts.push({ fn, id });
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timeouts = this.timeouts.filter((t) => t.id !== id);
  }
  runAll(): void {
    while (this.timeouts.length) this.timeouts.shift()!.fn();
  }
}

function setup(configure?: (e: FakeEngine) => void) {
  const engine = new FakeEngine();
  configure?.(engine);
  const sent: ToRenderer[] = [];
  const labels: LabelState[] = [];
  let epoch = 1_000_000;
  const timers = new ManualTimers();
  const feed = new EngineFeed({ engine, send: (m) => sent.push(m), epochNow: () => epoch, onLabel: (s) => labels.push(s), timers });
  /** Advances the fake clock by `ms` in feed ticks. */
  const advance = (ms: number) => {
    const steps = Math.round(ms / FEED.tickMs);
    for (let i = 0; i < steps; i++) {
      epoch += FEED.tickMs;
      engine.cycle += (FEED.tickMs / 1000) * engine.tempo;
      feed.tick();
    }
  };
  const of = <T extends ToRenderer['type']>(type: T) => sent.filter((m): m is Extract<ToRenderer, { type: T }> => m.type === type);
  return { engine, feed, sent, labels, timers, advance, of, epoch: () => epoch };
}

describe('clock samples', () => {
  it('sends one on start, none while extrapolation holds, and at least once per bar', () => {
    const t = setup();
    t.feed.start();
    expect(t.of('clock')).toHaveLength(1);
    expect(t.of('clock')[0]!.sample).toEqual({ epochMs: 1_000_000, cycle: 10, cps: 0.5 });
    t.advance(1500);
    expect(t.of('clock')).toHaveLength(1);
    t.advance(600);
    expect(t.of('clock')).toHaveLength(2);
  });

  it('resends on a tempo change and on a clock step', () => {
    const t = setup();
    t.feed.start();
    t.advance(200);
    t.engine.tempo = 0.55;
    t.advance(33);
    expect(t.of('clock').at(-1)!.sample.cps).toBe(0.55);
    const n = t.of('clock').length;
    t.engine.cycle += 0.05;
    t.advance(33);
    expect(t.of('clock')).toHaveLength(n + 1);
  });
});

describe('events', () => {
  it('batches all haps of one scheduler tick into one message, without code locations', async () => {
    const t = setup();
    t.feed.start();
    const before = t.of('events').length;
    for (const c of [11, 11.25, 11.5]) t.engine.emit('hap', kick(c), 0.2);
    await Promise.resolve();
    const batches = t.of('events').slice(before);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events.map((e) => e.cycle)).toEqual([11, 11.25, 11.5]);
    expect(batches[0]!.events.every((e) => e.locations.length === 0)).toBe(true);
  });
});

describe('lookahead', () => {
  it('queries at most 4 times per bar over [now, now + 1.1)', () => {
    const t = setup();
    t.feed.start();
    t.advance(8000);
    const looks = t.of('lookahead');
    expect(looks.length).toBeGreaterThanOrEqual(16);
    expect(looks.length).toBeLessThanOrEqual(17);
    const first = looks[0]!;
    expect(first.toCycle - first.fromCycle).toBeCloseTo(1.1);
    expect(t.engine.queries.length).toBe(looks.length);
  });

  it('extends the pre-echo to 2 bars during a build', () => {
    const t = setup((e) => (e.list = [section('b', 'build', 8, 8)]));
    t.feed.start();
    const look = t.of('lookahead')[0]!;
    expect(look.toCycle - look.fromCycle).toBeCloseTo(2.1);
  });

  it('plays the record from queries while no haps flow (landing), with no gaps or repeats', () => {
    const t = setup();
    t.feed.start();
    t.advance(6000);
    const cycles = t.of('events').flatMap((m) => m.events.map((e) => e.cycle));
    expect(new Set(cycles).size).toBe(cycles.length);
    const sorted = [...cycles].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(0.25);
    expect(sorted[0]).toBe(10);
    expect(sorted.at(-1)!).toBeGreaterThan(t.engine.cycle + 0.9);
  });

  it('stops forwarding queried events once the engine performs', async () => {
    const t = setup();
    t.feed.start();
    t.advance(500);
    const before = t.of('events').length;
    for (let i = 0; i < 20; i++) {
      t.engine.emit('hap', kick(t.engine.cycle + 0.1), 0.2);
      await Promise.resolve();
      t.advance(100);
    }
    const forwarded = t.of('events').slice(before).filter((m) => m.events.length > 1);
    expect(forwarded).toHaveLength(0);
  });
});

describe('moments', () => {
  it('announces a drop section ahead of its downbeat, once', () => {
    const t = setup((e) => {
      e.cycle = 37;
      e.list = [section('g', 'groove', 24), section('d', 'drop', 40)];
    });
    t.feed.start();
    t.advance(2000);
    expect(t.of('moment')).toHaveLength(0);
    t.advance(2000);
    expect(t.of('moment').map((m) => [m.kind, m.cycle])).toEqual([
      ['section', 40],
      ['drop', 40],
    ]);
    t.engine.emit('sectionStart', 'd');
    t.advance(4000);
    expect(t.of('moment')).toHaveLength(2);
  });

  it('sets the mode, without replaying the downbeat, when joining mid-build', () => {
    const t = setup((e) => {
      e.cycle = 36;
      e.list = [section('b', 'build', 32, 8)];
    });
    t.feed.start();
    expect(t.of('moment').map((m) => [m.kind, m.cycle])).toEqual([['build', 32]]);
  });

  it('inverts the DOM label for the bar after a drop', () => {
    const t = setup((e) => {
      e.cycle = 39.5;
      e.list = [section('d', 'drop', 40)];
    });
    t.feed.start();
    expect(t.labels).toHaveLength(0);
    t.advance(1100);
    expect(t.labels.at(-1)).toEqual({ inverted: true, listening: false });
    t.advance(2000);
    expect(t.labels.at(-1)).toEqual({ inverted: false, listening: false });
  });

  it('reports silence once, and the label listens until music returns', () => {
    const t = setup((e) => (e.silent = true));
    t.feed.start();
    t.advance(3000);
    expect(t.of('moment').filter((m) => m.kind === 'silence')).toHaveLength(1);
    expect(t.labels.at(-1)).toEqual({ inverted: false, listening: true });
    t.engine.silent = false;
    t.advance(600);
    expect(t.labels.at(-1)).toEqual({ inverted: false, listening: false });
  });
});

describe('meters, backfill, pause', () => {
  it('sends levels only while the engine is running (zeros once otherwise)', () => {
    const t = setup();
    t.feed.start();
    t.advance(300);
    expect(t.of('levels')).toHaveLength(1);
    expect(t.engine.meterCalls).toBe(0);
    t.engine.state = 'running';
    t.advance(330);
    const levels = t.of('levels');
    expect(levels.length).toBeGreaterThanOrEqual(10);
    expect(levels.at(-1)!.master).toBeCloseTo(0.75);
    expect(levels.at(-1)!.parts).toEqual({ 's1:kick': 0.7 });
    expect(levels.at(-1)!.energy).toBeGreaterThan(0);
  });

  it('backfills a side\'s recent past once, in chunks', () => {
    const t = setup((e) => (e.cycle = 100));
    t.feed.start();
    const before = t.of('events').length;
    t.feed.setSide({ id: 'm1', startCycle: 90 } as never);
    t.timers.runAll();
    t.feed.setSide({ id: 'm1', startCycle: 90 } as never);
    t.timers.runAll();
    const backfill = t.of('events').slice(before);
    expect(backfill).toHaveLength(3);
    const cycles = backfill.flatMap((m) => m.events.map((e) => e.cycle));
    expect(cycles[0]).toBe(90);
    expect(Math.max(...cycles)).toBeCloseTo(100.25);
  });

  it('keeps backfilling the current side when the next one is committed ahead of time', () => {
    const t = setup((e) => (e.cycle = 100));
    t.feed.start();
    t.feed.setSide({ id: 'm1', startCycle: 80 } as never);
    t.feed.setSide({ id: 'm2', startCycle: 112 } as never);
    t.timers.runAll();
    const cycles = t.of('events').flatMap((m) => m.events.map((e) => e.cycle));
    expect(Math.min(...cycles)).toBe(80);
    expect(cycles.filter((c) => c >= 80 && c < 100)).toHaveLength(80);
  });

  it('limits the backfill to the last 64 bars of a long side', () => {
    const t = setup((e) => (e.cycle = 500));
    t.feed.start();
    t.feed.setSide({ id: 'm1', startCycle: 0 } as never);
    t.timers.runAll();
    const backfilled = t.engine.queries.filter(([a, b]) => b - a <= FEED.backfillChunkBars + 1e-9 && a < 500);
    expect(backfilled[0]![0]).toBe(436);
  });

  it('does no querying or metering while paused, but keeps the clock', () => {
    const t = setup((e) => (e.state = 'running'));
    t.feed.start();
    t.feed.setPaused(true);
    const queries = t.engine.queries.length;
    const meters = t.engine.meterCalls;
    t.advance(5000);
    expect(t.engine.queries.length).toBe(queries);
    expect(t.engine.meterCalls).toBe(meters);
    expect(t.of('clock').length).toBeGreaterThanOrEqual(3);
    t.feed.setPaused(false);
    expect(t.engine.queries.length).toBe(queries + 1);
  });

  it('unsubscribes on stop', async () => {
    const t = setup();
    t.feed.start();
    t.feed.stop();
    const before = t.sent.length;
    t.engine.emit('hap', kick(11), 0.1);
    await Promise.resolve();
    expect(t.sent).toHaveLength(before);
  });
});
