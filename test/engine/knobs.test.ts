import { describe, expect, it } from 'vitest';
import { applyBrightness, intensityDb, knobAt, laneValue, levelAt, macrosAt, safetyAt, trimDbAt } from '../../src/client/engine/knobs.ts';
import { laneValue as conductorLaneValue } from '../../src/server/conductor/knobs.ts';
import type { Automation, Knob } from '../../src/shared/plan.ts';
import type { MixerState } from '../../src/shared/program.ts';

const lane = (fromBar: number, toBar: number, from: number, to: number, curve: 'linear' | 'exp' = 'linear', target = 'level'): Automation => ({
  target,
  fromBar,
  toBar,
  from,
  to,
  curve,
});

describe('automation lanes', () => {
  const lanes = [lane(8, 16, 400, 1200, 'exp', 'knob:cut'), lane(20, 24, 1200, 300, 'linear', 'knob:cut')];

  it('holds the base before the first lane, interpolates inside, holds the end after', () => {
    expect(laneValue(lanes, 0, 800)).toBe(800);
    expect(laneValue(lanes, 8, 800)).toBeCloseTo(400);
    expect(laneValue(lanes, 12, 800)).toBeCloseTo(Math.sqrt(400 * 1200)); // geometric midpoint
    expect(laneValue(lanes, 16, 800)).toBe(1200);
    expect(laneValue(lanes, 18, 800)).toBe(1200);
    expect(laneValue(lanes, 22, 800)).toBeCloseTo(750);
    expect(laneValue(lanes, 40, 800)).toBe(300);
  });

  it('matches the conductor for every bar (server context and client agree)', () => {
    const cases: Automation[][] = [lanes, [lane(0, 4, 0, 0.5)], [lane(-2, 0, 0, 1, 'exp')], [lane(4, 4, 0.2, 0.9)], []];
    for (const c of cases) for (let bar = -4; bar <= 40; bar += 0.25) expect(laneValue(c, bar, 0.7)).toBe(conductorLaneValue(c, bar, 0.7));
  });

  it('level lanes replace the fader', () => {
    const part = { level: 0.5, automation: [lane(0, 4, 0, 0.5)] };
    expect(levelAt(part, 0)).toBe(0);
    expect(levelAt(part, 2)).toBeCloseTo(0.25);
    expect(levelAt(part, 10)).toBe(0.5);
  });
});

describe('knobAt', () => {
  const knob: Knob = { name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' };
  const part = { automation: [lane(8, 16, 400, 1200, 'exp', 'knob:cut')] };

  it('adds up to half the range at a full macro and clamps', () => {
    expect(knobAt(part, knob, 0, { brightness: 0, intensity: 0 })).toBe(800);
    expect(knobAt(part, knob, 0, { brightness: 0.5, intensity: 0 })).toBeCloseTo(800 + 0.5 * 1050);
    expect(knobAt(part, knob, 0, { brightness: 1, intensity: 0 })).toBe(1850);
    expect(knobAt(part, knob, 16, { brightness: 1, intensity: 0 })).toBe(2250);
    expect(knobAt(part, knob, 16, { brightness: -1, intensity: 0 })).toBe(300);
    expect(knobAt(part, { ...knob, follows: '-intensity' }, 0, { brightness: 1, intensity: 0.2 })).toBeCloseTo(800 - 0.2 * 1050);
  });

  it('holds the default where no lane covers the bar (for carried parts, the value the predecessor ended on)', () => {
    expect(knobAt({ automation: [] }, { ...knob, default: 1200 }, 3, { brightness: 0, intensity: 0 })).toBe(1200);
    expect(knobAt(part, { ...knob, default: 1200 }, 4, { brightness: 0, intensity: 0 })).toBe(1200);
  });
});

describe('mixer interpolation (pure function of cycle)', () => {
  const state: MixerState = {
    rev: 3,
    prev: { atCycle: 10, rampBars: 1, macros: { brightness: 0.2, intensity: -0.4 }, trimsDb: { bass: -2 } },
    next: { atCycle: 20, rampBars: 2, macros: { brightness: 1, intensity: 0.4 }, trimsDb: { bass: 1, pad: -3 } },
    safety: { masterDb: -3, highShelfDb: -3, fromCycle: 30, untilCycle: 46 },
  };

  it("holds prev's values before next.atCycle, ramps, then holds next's", () => {
    expect(macrosAt(state, 5)).toEqual({ brightness: 0.2, intensity: -0.4 });
    expect(macrosAt(state, 20)).toEqual({ brightness: 0.2, intensity: -0.4 });
    expect(macrosAt(state, 21).brightness).toBeCloseTo(0.6);
    expect(macrosAt(state, 21).intensity).toBeCloseTo(0);
    expect(macrosAt(state, 22)).toEqual({ brightness: 1, intensity: 0.4 });
    expect(macrosAt(state, 99)).toEqual({ brightness: 1, intensity: 0.4 });
  });

  it("uses next's values throughout when there is no previous keyframe", () => {
    expect(macrosAt({ ...state, prev: null }, 0)).toEqual({ brightness: 1, intensity: 0.4 });
  });

  it('interpolates trims in dB, missing ids at 0 dB', () => {
    expect(trimDbAt(state, 'bass', 0)).toBe(-2);
    expect(trimDbAt(state, 'bass', 21)).toBeCloseTo(-0.5);
    expect(trimDbAt(state, 'pad', 21)).toBeCloseTo(-1.5);
    expect(trimDbAt(state, 'kick', 21)).toBe(0);
  });

  it('ramps the safety trim in after fromCycle and out before untilCycle', () => {
    expect(safetyAt(state, 29)).toEqual({ masterDb: 0, highShelfDb: 0 });
    expect(safetyAt(state, 30.5).masterDb).toBeCloseTo(-1.5);
    expect(safetyAt(state, 38).masterDb).toBeCloseTo(-3);
    expect(safetyAt(state, 45.5).masterDb).toBeCloseTo(-1.5);
    expect(safetyAt(state, 46)).toEqual({ masterDb: 0, highShelfDb: 0 });
  });
});

describe('macros on values', () => {
  it('scales filters and sends with brightness and clamps', () => {
    const v: Record<string, unknown> = { cutoff: 1000, hcutoff: 400, room: 0.8, delay: 0.5, s: 'x' };
    applyBrightness(v, 1);
    expect(v).toEqual({ cutoff: 2000, hcutoff: 400 * Math.SQRT2, room: 0.8 * 0.7, delay: 0.35, s: 'x' });
    const w: Record<string, unknown> = { cutoff: 15000, room: 0.9 };
    applyBrightness(w, -1);
    expect(w.cutoff).toBe(7500);
    expect(w.room).toBe(1);
  });

  it('intensity moves percussion up and pads down', () => {
    expect(intensityDb('kick', 1)).toBe(3);
    expect(intensityDb('pad', 1)).toBe(-2);
    expect(intensityDb('texture', -0.5)).toBe(1);
    expect(intensityDb('lead', 1)).toBe(0);
  });
});
