import { describe, expect, it } from 'vitest';
import { bpmToCps } from '../../src/shared/music.ts';
import { createTimeline, cycleAtMs, msAtCycle, withTempoAt } from '../../src/shared/timeline.ts';
import { createRoomClock, serverNow } from '../../src/server/room/clock.ts';
import { FakeTime } from './fake-time.ts';

const BAR_MS_120 = 2000;

/** By default the clock starts a quarter bar into bar 0. */
function setup(opts: { startCycle?: number; offsetMs?: number } = {}) {
  const time = new FakeTime();
  const timeline = createTimeline(time.now - (opts.offsetMs ?? 500), bpmToCps(120), opts.startCycle ?? 0);
  const clock = createRoomClock({ timeline, now: time.clock, timers: time.timers });
  const bars: { bar: number; cycle: number }[] = [];
  clock.onBar((bar) => bars.push({ bar, cycle: clock.cycle() }));
  return { time, clock, bars };
}

describe('serverNow', () => {
  it('is performance.timeOrigin + performance.now() (close to wall time, monotonic)', () => {
    const a = serverNow();
    const b = serverNow();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(a - Date.now())).toBeLessThan(5000);
  });
});

describe('RoomClock', () => {
  it('reports cycle and bpm from the timeline', () => {
    const { time, clock } = setup({ startCycle: 10, offsetMs: 0 });
    expect(clock.cycle()).toBe(10);
    expect(clock.bpm()).toBeCloseTo(120);
    time.advance(3000);
    expect(clock.cycle()).toBeCloseTo(11.5);
  });

  it('announces every integer cycle exactly at its boundary', () => {
    const { time, clock, bars } = setup();
    clock.start();
    time.advance(4 * BAR_MS_120);
    expect(bars.map((b) => b.bar)).toEqual([1, 2, 3, 4]);
    for (const b of bars) expect(b.cycle).toBeCloseTo(b.bar, 6);
  });

  it('announces the bar starting right at start()', () => {
    const { time, clock, bars } = setup({ startCycle: 7, offsetMs: 0 });
    clock.start();
    time.advance(1);
    expect(bars.map((b) => b.bar)).toEqual([7]);
  });

  it('does not accumulate timer lateness (drift correction)', () => {
    const { time, clock, bars } = setup();
    time.jitterMs = 37; // every timer fires 37 ms late
    clock.start();
    time.advance(100 * BAR_MS_120 - 400);
    expect(bars.map((b) => b.bar)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    // Each announcement is 37 ms late at most — never 100 × 37 ms.
    for (const b of bars) expect(b.cycle - b.bar).toBeLessThan(0.02);
  });

  it('re-arms when a timer fires early instead of announcing too soon', () => {
    const { time, clock, bars } = setup();
    time.jitterMs = -300; // only the first timer wakes up 300 ms early
    clock.start();
    time.jitterMs = 0;
    time.advance(BAR_MS_120 - 500 - 1);
    expect(bars).toEqual([]);
    time.advance(400);
    expect(bars.map((b) => b.bar)).toEqual([1]);
    expect(bars[0]!.cycle).toBeGreaterThanOrEqual(1);
  });

  it('follows a tempo change published ahead of time', () => {
    const { time, clock, bars } = setup();
    clock.start();
    // From bar 2, 60 BPM (4 s bars).
    clock.setTimeline(withTempoAt(clock.timeline(), 2, bpmToCps(60)));
    time.advance(2 * BAR_MS_120 + 4000 * 2 - 500 + 1);
    expect(bars.map((b) => b.bar)).toEqual([1, 2, 3, 4]);
    const tl = clock.timeline();
    for (const b of bars) expect(b.cycle).toBeCloseTo(cycleAtMs(tl, msAtCycle(tl, b.bar)), 6);
    expect(clock.bpm()).toBeCloseTo(60);
  });

  it('carries on from the new position after a timeline jump, never repeating a bar', () => {
    const { time, clock, bars } = setup();
    clock.start();
    time.advance(BAR_MS_120); // bar 1 announced
    const jumped = createTimeline(time.now - 500, bpmToCps(120), 5000);
    clock.setTimeline(jumped);
    time.advance(BAR_MS_120);
    expect(bars.map((b) => b.bar)).toEqual([1, 5001]);
    // A backwards jump never re-announces bars already announced.
    clock.setTimeline(createTimeline(time.now, bpmToCps(120), 4990));
    time.advance(5 * BAR_MS_120);
    expect(bars.map((b) => b.bar)).toEqual([1, 5001]);
  });

  it('catches up after a stall, announcing at most 16 missed bars', () => {
    const { time, clock, bars } = setup();
    time.jitterMs = 50 * BAR_MS_120; // the event loop was blocked for 50 bars
    clock.start();
    time.advance(52 * BAR_MS_120);
    // The first timer fired at cycle 51: bars 1–35 are skipped, 36–51 announced in order.
    expect(bars.map((b) => b.bar)).toEqual(Array.from({ length: 16 }, (_, i) => 36 + i));
  });

  it('isolates listener errors, supports unsubscribe and stop', () => {
    const time = new FakeTime();
    const errors: unknown[] = [];
    const clock = createRoomClock({
      timeline: createTimeline(time.now - 500, bpmToCps(120)),
      now: time.clock,
      timers: time.timers,
      log: { debug() {}, info() {}, warn() {}, error: (_m, d) => errors.push(d) },
    });
    const seen: number[] = [];
    clock.onBar(() => {
      throw new Error('boom');
    });
    const off = clock.onBar((bar) => seen.push(bar));
    clock.start();
    clock.start(); // idempotent
    time.advance(2 * BAR_MS_120 + 1);
    expect(seen).toEqual([1, 2]);
    expect(errors.length).toBe(2);
    off();
    time.advance(BAR_MS_120);
    expect(seen).toEqual([1, 2]);
    clock.stop();
    expect(time.pending).toBe(0);
  });

  it('a listener may stop the clock from inside the callback', () => {
    const { time, clock, bars } = setup();
    clock.onBar((bar) => bar === 2 && clock.stop());
    clock.start();
    time.advance(10 * BAR_MS_120);
    expect(bars.map((b) => b.bar)).toEqual([1, 2]);
    expect(time.pending).toBe(0);
  });
});
