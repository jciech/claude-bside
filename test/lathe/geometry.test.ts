import { describe, expect, it } from 'vitest';
import {
  grooveRadius,
  landSlots,
  landsUpTo,
  laneOffset,
  layoutRecord,
  polar,
  recordAngle,
  sheenHue,
  sheenIntensity,
  sideLetter,
  sideSpec,
  spiralBars,
  TAU,
} from '../../src/client/render/geometry.ts';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('record layout', () => {
  const side = sideSpec(64, 128, [64, 80, 96, 104], 70);
  const L = layoutRecord(1000, 800, side);

  it('follows the design proportions', () => {
    close(L.R, 0.93 * 400);
    close(L.labelR, 0.3 * L.R);
    close(L.outerR, 0.955 * L.R);
    close(L.innerR, 1.12 * L.labelR);
    expect(L.cx).toBe(500);
    expect(L.cy).toBe(400);
    close(L.landW, 0.012 * L.R);
  });

  it('fills exactly the playing surface: planned bars plus reserved lands end at the dead wax', () => {
    close(L.outerR - side.bars * L.pitch - side.landSlots * L.landW, L.innerR, 1e-6);
  });

  it('ignores the side start as a land and sorts/dedupes track starts', () => {
    expect(sideSpec(0, 64, [32, 0, 16, 16], 0).lands).toEqual([16, 32]);
  });
});

describe('spiral', () => {
  const side = sideSpec(0, 100, [16, 40], 0);
  const L = layoutRecord(800, 800, side);

  it('starts at the first groove and moves inward one pitch per bar', () => {
    close(grooveRadius(L, side, 0), L.outerR);
    close(grooveRadius(L, side, 1) - grooveRadius(L, side, 2), L.pitch);
    close(grooveRadius(L, side, 10.5), L.outerR - 10.5 * L.pitch);
  });

  it('steps inward by one land at each track start (a gap of pitch + land between tracks)', () => {
    const before = grooveRadius(L, side, 16 - 1e-9);
    const after = grooveRadius(L, side, 16);
    close(before - after, L.landW, 1e-6);
    close(grooveRadius(L, side, 15) - grooveRadius(L, side, 16), L.pitch + L.landW, 1e-9);
    close(grooveRadius(L, side, 41), L.outerR - 41 * L.pitch - 2 * L.landW);
  });

  it('stays on the record before the side starts and past its end', () => {
    expect(grooveRadius(L, side, -5)).toBe(L.outerR);
    expect(grooveRadius(L, side, 10_000)).toBe(L.innerR);
  });

  it('counts lands with a binary search', () => {
    const lands = [4, 8, 8.5, 20];
    expect([0, 4, 5, 8.5, 19, 20, 99].map((c) => landsUpTo(lands, c))).toEqual([0, 1, 1, 3, 3, 4, 4]);
    expect(landsUpTo([], 3)).toBe(0);
  });
});

describe('angles', () => {
  it('lays cycles counter-clockwise from 12 o\'clock, one revolution per bar', () => {
    const top = polar(10, recordAngle(0));
    close(top.x, 0);
    close(top.y, -10);
    // A quarter bar later the groove is at 9 o'clock in record space.
    const quarter = polar(10, recordAngle(0.25));
    close(quarter.x, -10);
    close(quarter.y, 0, 1e-9);
  });

  it('puts "now" under the stylus and the future on the left while the platter turns clockwise', () => {
    // The frame rotates the record by 2π·now (clockwise on a y-down canvas).
    const onScreen = (cycle: number, now: number) => polar(10, recordAngle(cycle) + TAU * now);
    const needle = onScreen(12.3, 12.3);
    close(needle.x, 0, 1e-9);
    close(needle.y, -10, 1e-9);
    // A quarter bar ahead approaches from 9 o'clock; a quarter bar ago has turned away to 3 o'clock.
    const ahead = onScreen(12.55, 12.3);
    close(ahead.x, -10, 1e-9);
    close(ahead.y, 0, 1e-9);
    const behind = onScreen(12.05, 12.3);
    close(behind.x, 10, 1e-9);
    close(behind.y, 0, 1e-9);
  });
});

describe('side length', () => {
  it('keeps the planned length until the needle gets near its end', () => {
    expect(spiralBars(128, 0, 0)).toBe(128);
    expect(spiralBars(128, 0, 120)).toBe(128);
  });

  it('grows in 32-bar steps once overrun, so the geometry changes rarely', () => {
    expect(spiralBars(128, 0, 121)).toBe(160);
    expect(spiralBars(128, 0, 152)).toBe(160);
    expect(spiralBars(128, 0, 153)).toBe(192);
    expect(spiralBars(128, 1000, 1100)).toBe(128);
  });

  it('reserves room for lands that are not committed yet', () => {
    expect(landSlots(128, 2)).toBe(5);
    expect(landSlots(256, 3)).toBe(11);
    expect(landSlots(48, 1)).toBe(4);
    expect(landSlots(64, 9)).toBe(9);
  });

  it('never lets lands take more than a fifth of the playing surface', () => {
    const side = sideSpec(0, 64, Array.from({ length: 40 }, (_, i) => 1 + i), 0);
    const L = layoutRecord(800, 800, side);
    expect(side.landSlots * L.landW).toBeLessThanOrEqual(0.2 * (L.outerR - L.innerR) + 1e-9);
    expect(L.pitch).toBeGreaterThan(0);
  });
});

describe('lanes', () => {
  it('orders pitched voices by register within ±0.46 and places the rest by family', () => {
    expect(laneOffset('bass', 38)).toBeCloseTo(-0.46);
    expect(laneOffset('lead', 74)).toBeCloseTo(0.35);
    expect(laneOffset('keys', 60)).toBe(0);
    expect(laneOffset('pad', null)).toBe(-0.05);
    expect(laneOffset('kick', 36)).toBe(-0.42);
    expect(laneOffset('hat', null)).toBe(0.42);
    expect(laneOffset('snare', null)).toBe(0.18);
    expect(laneOffset('fx', 90)).toBe(0.35);
    expect(laneOffset('lead', Number.NaN)).toBe(0.28);
  });
});

describe('sheen and labels', () => {
  it('moves the sheen hue from violet (dark) to gold (bright) through magenta', () => {
    expect(sheenHue(-1)).toBe(265);
    expect(sheenHue(1)).toBe(40);
    expect(sheenHue(0)).toBeCloseTo(332.5);
    expect(sheenHue(5)).toBe(40);
  });

  it('raises sheen intensity from 0.07 (calm) to 0.14 (intense)', () => {
    expect(sheenIntensity(-1)).toBeCloseTo(0.07);
    expect(sheenIntensity(1)).toBeCloseTo(0.14);
    expect(sheenIntensity(0)).toBeCloseTo(0.105);
  });

  it('names sides A, B, … Z, AA', () => {
    expect([1, 2, 26, 27, 28, 0].map(sideLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'A']);
  });
});
