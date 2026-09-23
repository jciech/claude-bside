import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VisualEvent } from '../../src/client/engine/types.ts';
import { Lathe } from '../../src/client/render/lathe.ts';
import type { MovementInfo } from '../../src/shared/program.ts';
import { FakeCanvas } from './fake-canvas.ts';

// A hidden tab (or "Pause visuals") never draws, but the engine keeps sending every hap so the
// record is complete on resume: what the Lathe keeps for that must stay bounded.

const movement = (id: string, startCycle: number): MovementInfo => ({
  id,
  side: 1,
  name: 'Side',
  bpm: 120,
  scale: 'C:minor',
  groove: 'four-on-floor',
  arcShape: 'plateau',
  blurb: '',
  startCycle,
  plannedBars: 4096,
  tracks: [],
});

const FAMILIES = ['kick', 'snare', 'hat', 'bass'] as const;

function bar(b: number, perBar: number): VisualEvent[] {
  return Array.from({ length: perBar }, (_, i): VisualEvent => {
    const family = FAMILIES[i % FAMILIES.length]!;
    return {
      sectionId: 's1',
      partId: family,
      instance: `s1:${family}`,
      role: family === 'hat' ? 'hats' : family,
      family,
      cycle: b + i / perBar,
      duration: 1 / perBar,
      midi: family === 'bass' ? 36 + (i % 12) : null,
      gain: 0.7,
      pan: 0,
      sound: family,
      locations: [],
    };
  });
}

type Kept = { seen: Map<string, number>; history: unknown[] };
const kept = (lathe: Lathe) => lathe as unknown as Kept;

beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterEach(() => vi.unstubAllGlobals());

describe('the Lathe while paused', () => {
  it('keeps its dedupe keys and its history bounded however long the tab stays hidden', () => {
    const lathe = new Lathe(new FakeCanvas(400, 400) as unknown as OffscreenCanvas, 400, 400, 1, 'lite');
    lathe.setSide(movement('m0', 0), [], 0);
    lathe.draw(0, 0.5, 1000);
    // 64 haps a bar for 1200 bars (40 minutes at 120 bpm), each bar's arriving as it plays out.
    let peakSeen = 0;
    let peakHistory = 0;
    for (let b = 0; b < 1200; b++) {
      lathe.addEvents(bar(b, 64), b + 1, true);
      peakSeen = Math.max(peakSeen, kept(lathe).seen.size);
      peakHistory = Math.max(peakHistory, kept(lathe).history.length);
    }
    expect(peakSeen).toBeLessThan(8192);
    expect(peakHistory).toBeLessThanOrEqual(30_000);
  });

  it('still imprints everything it was sent once resumed', () => {
    const lathe = new Lathe(new FakeCanvas(400, 400) as unknown as OffscreenCanvas, 400, 400, 1, 'lite');
    lathe.setSide(movement('m0', 0), [], 0);
    lathe.draw(0, 0.5, 1000);
    for (let b = 0; b < 100; b++) lathe.addEvents(bar(b, 64), b + 1, true);
    // A resend of the last bars (the feed's backfill on a new side) is not imprinted twice.
    for (let b = 96; b < 100; b++) lathe.addEvents(bar(b, 64), 101, true);
    lathe.draw(101, 0.5, 2000);
    expect(kept(lathe).history).toHaveLength(100 * 64);
  });
});
