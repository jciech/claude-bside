import { describe, expect, it } from 'vitest';
import { RenderClock, SLEW_MAX_SEC, SLEW_TAU_MS } from '../../src/client/render/clock.ts';

describe('RenderClock', () => {
  it('extrapolates cycles from an epoch-time sample', () => {
    const clock = new RenderClock();
    expect(clock.ready).toBe(false);
    clock.update({ epochMs: 10_000, cycle: 64, cps: 0.5 }, 10_000);
    expect(clock.ready).toBe(true);
    expect(clock.cycleAt(10_000)).toBe(64);
    expect(clock.cycleAt(12_000)).toBeCloseTo(65);
    expect(clock.cps()).toBe(0.5);
  });

  it('uses the sender\'s epoch time, so a sample that arrives late is still exact', () => {
    const clock = new RenderClock();
    // Sent at 10 000 ms, received 40 ms later on a thread with a different performance.now() origin.
    clock.update({ epochMs: 10_000, cycle: 64, cps: 0.5 }, 10_040);
    expect(clock.cycleAt(10_040)).toBeCloseTo(64.02);
  });

  it('slews small corrections so the platter never jumps or turns backwards', () => {
    const clock = new RenderClock();
    clock.update({ epochMs: 0, cycle: 0, cps: 0.5 }, 0);
    // At 1000 ms the extrapolation says 0.5; the truth is 0.49 (20 ms behind).
    clock.update({ epochMs: 1000, cycle: 0.49, cps: 0.5 }, 1000);
    expect(clock.cycleAt(1000)).toBeCloseTo(0.5, 9);
    expect(clock.cycleAt(1000 + 5 * SLEW_TAU_MS)).toBeCloseTo(0.49 + (5 * SLEW_TAU_MS) / 2000, 3);
    let prev = clock.cycleAt(1000);
    for (let t = 1001; t < 2500; t += 7) {
      const c = clock.cycleAt(t);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
  });

  it('keeps moving forward even for the largest slewed correction at the slowest tempo', () => {
    const cps = 0.25;
    const clock = new RenderClock();
    clock.update({ epochMs: 0, cycle: 10, cps }, 0);
    clock.update({ epochMs: 500, cycle: 10 + 0.5 * cps - SLEW_MAX_SEC * cps * 0.999, cps }, 500);
    let prev = clock.cycleAt(500);
    for (let t = 501; t < 1500; t += 3) {
      const c = clock.cycleAt(t);
      expect(c).toBeGreaterThan(prev);
      prev = c;
    }
  });

  it('snaps large corrections (timeline changes, clock steps)', () => {
    const clock = new RenderClock();
    clock.update({ epochMs: 0, cycle: 0, cps: 0.5 }, 0);
    clock.update({ epochMs: 1000, cycle: 8, cps: 0.5 }, 1000);
    expect(clock.cycleAt(1000)).toBe(8);
  });

  it('follows a tempo change from the new sample on', () => {
    const clock = new RenderClock();
    clock.update({ epochMs: 0, cycle: 0, cps: 0.5 }, 0);
    clock.update({ epochMs: 2000, cycle: 1, cps: 0.55 }, 2000);
    expect(clock.cycleAt(4000)).toBeCloseTo(2.1);
    expect(clock.cps()).toBe(0.55);
  });

  it('ignores malformed samples', () => {
    const clock = new RenderClock();
    clock.update({ epochMs: 0, cycle: 3, cps: 0.5 }, 0);
    clock.update({ epochMs: Number.NaN, cycle: 9, cps: 0.5 }, 10);
    clock.update({ epochMs: 10, cycle: 9, cps: 0 }, 10);
    expect(clock.cycleAt(2000)).toBeCloseTo(4);
  });
});
