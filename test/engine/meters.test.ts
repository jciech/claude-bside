import { describe, expect, it } from 'vitest';
import { loudness, METER_TAU_SEC, MeterSmoother } from '../../src/client/engine/meters.ts';
import type { Meters } from '../../src/client/engine/types.ts';

const master = { rmsDb: -20, peakDb: -6 };

/** A part that is silent at t = 0 and at full level right after. */
const step = (t: number): Meters => ({ master, parts: { 's:kick': t > 0 ? 1 : 0 } });

/** The part's reading at each poll time (integer ms, so equal times are equal floats). */
function poll(timesMs: number[]): Map<number, number> {
  const meters = new MeterSmoother();
  const out = new Map<number, number>();
  for (const ms of [...timesMs].sort((a, b) => a - b)) {
    const t = ms / 1000;
    out.set(ms, meters.read(t, () => step(t)).parts['s:kick']!);
  }
  return out;
}

const every = (stepMs: number, untilMs: number, offsetMs = 0): number[] =>
  Array.from({ length: Math.floor((untilMs - offsetMs) / stepMs) + 1 }, (_, i) => offsetMs + i * stepMs);

describe('meters', () => {
  it('smooths over time: polling twice as often, or from a second poller, leaves the curve unchanged', () => {
    const feed = every(32, 480); // the Lathe feed, ≈ 30 Hz
    const alone = poll(feed);
    const doubled = poll(every(16, 480));
    const withLegend = poll([...feed, ...every(64, 480, 8)]); // plus the UI pulse, ≈ 15 Hz, in between
    for (const ms of feed) {
      const expected = 1 - Math.exp(-ms / 1000 / METER_TAU_SEC);
      expect(alone.get(ms)).toBeCloseTo(expected, 9);
      expect(doubled.get(ms)).toBeCloseTo(expected, 9);
      expect(withLegend.get(ms)).toBeCloseTo(expected, 9);
    }
  });

  it('answers repeat calls at the same audio time from the cached reading', () => {
    const meters = new MeterSmoother();
    let samples = 0;
    const sample = () => {
      samples++;
      return step(1);
    };
    meters.read(0.5, sample);
    const a = meters.read(0.6, sample);
    const b = meters.read(0.6, sample);
    expect(b).toBe(a);
    expect(samples).toBe(2);
  });

  it('drops instances that stopped sounding and brings new ones up from silence', () => {
    const meters = new MeterSmoother();
    meters.read(0, () => ({ master, parts: { 'a:x': 1 } }));
    const next = meters.read(0.05, () => ({ master, parts: { 'b:y': 1 } }));
    expect(Object.keys(next.parts)).toEqual(['b:y']);
    expect(next.parts['b:y']).toBeCloseTo(1 - Math.exp(-0.05 / METER_TAU_SEC), 9);
    expect(next.master).toEqual(master);
  });

  it('maps channel RMS to 0..1 over the top 60 dB', () => {
    expect(loudness(0)).toBe(0);
    expect(loudness(1)).toBe(1);
    expect(loudness(10 ** (-30 / 20))).toBeCloseTo(0.5);
  });
});
