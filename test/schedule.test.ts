import { describe, expect, it } from 'vitest';
import {
  influenceCycle,
  lockMs,
  nextPhraseLine,
  plannedPlayBars,
  preRollBars,
  scoreBarAt,
  scoreSegments,
  sectionExtents,
  MIN_CHANGE_LEAD_S,
} from '../src/shared/schedule.ts';
import { buildTimeline, createTimeline, cpsAtCycle, msAtCycle, withTempoAt, withTempoRamp } from '../src/shared/timeline.ts';
import { bpmToCps, cpsToBpm } from '../src/shared/music.ts';
import { sanitizePlainText, sanitizeRequestText, isPublicText, requestMergeKey } from '../src/shared/text.ts';
import { fingerprintDistance, type SectionFingerprint } from '../src/shared/analysis.ts';

const base = { bars: 16, jumps: [] as { atBar: number; toBar: number }[], vamp: { allowed: true, loopBars: 8 } };

describe('score time', () => {
  it('is identity inside the score', () => {
    expect(scoreBarAt(base, 0)).toBe(0);
    expect(scoreBarAt(base, 15.5)).toBe(15.5);
  });
  it('loops the last phrase past the end (vamp)', () => {
    expect(scoreBarAt(base, 16)).toBe(8);
    expect(scoreBarAt(base, 23)).toBe(15);
    expect(scoreBarAt(base, 24)).toBe(8);
  });
  it('Stay repeats the penultimate phrase so the ending gesture survives', () => {
    const s = { ...base, bars: 32, jumps: [{ atBar: 24, toBar: 16 }] };
    expect(plannedPlayBars(s)).toBe(40);
    expect(scoreBarAt(s, 23)).toBe(23);
    expect(scoreBarAt(s, 24)).toBe(16);
    expect(scoreBarAt(s, 39)).toBe(31);
  });
  it('Move on skips to the final phrase', () => {
    const s = { ...base, bars: 32, jumps: [{ atBar: 8, toBar: 24 }] };
    expect(plannedPlayBars(s)).toBe(16);
    expect(scoreBarAt(s, 7)).toBe(7);
    expect(scoreBarAt(s, 8)).toBe(24);
    expect(scoreBarAt(s, 15)).toBe(31);
  });
  it('splits play spans into linear score segments', () => {
    const s = { ...base, bars: 32, jumps: [{ atBar: 8, toBar: 24 }] };
    expect(scoreSegments(s, 6, 10)).toEqual([
      { playFrom: 6, playTo: 8, scoreFrom: 6 },
      { playFrom: 8, playTo: 10, scoreFrom: 24 },
    ]);
    expect(scoreSegments(base, 15, 25)).toEqual([
      { playFrom: 15, playTo: 16, scoreFrom: 15 },
      { playFrom: 16, playTo: 24, scoreFrom: 8 },
      { playFrom: 24, playTo: 25, scoreFrom: 8 },
    ]);
  });
  it('maps pickups (negative play bars) to themselves', () => {
    expect(scoreBarAt(base, -2)).toBe(-2);
  });
});

describe('pre-roll, lock and extents', () => {
  const tl = createTimeline(0, bpmToCps(120));
  type T = 'cut' | 'crossfade' | 'riser' | 'breath' | 'filter';
  const section = (over: { transitionIn?: { type: T; bars: number }; parts?: { enterBar: number }[] } = {}) => ({
    startCycle: 64,
    transitionIn: { type: 'cut' as T, bars: 0 },
    parts: [{ enterBar: 0 }],
    ...over,
  });
  it('counts riser/breath/filter bars and pickups as pre-roll', () => {
    expect(preRollBars(section())).toBe(0);
    expect(preRollBars(section({ transitionIn: { type: 'riser', bars: 8 } }))).toBe(8);
    expect(preRollBars(section({ parts: [{ enterBar: -4 }, { enterBar: 0 }] }))).toBe(4);
    expect(influenceCycle(section({ transitionIn: { type: 'breath', bars: 2 } }))).toBe(62);
  });
  it('locks at least MIN_CHANGE_LEAD and 2 bars before the influence cycle', () => {
    const s = section({ transitionIn: { type: 'riser', bars: 8 } });
    expect(msAtCycle(tl, 56) - lockMs(tl, s)).toBe(Math.max(MIN_CHANGE_LEAD_S * 1000, 4000));
  });
  it('orders extents; the last section is open-ended', () => {
    const ex = sectionExtents([{ startCycle: 32 }, { startCycle: 0 }]);
    expect(ex.map((e) => [e.section.startCycle, e.endCycle])).toEqual([
      [0, 32],
      [32, Number.POSITIVE_INFINITY],
    ]);
  });
  it('snaps to phrase lines', () => {
    expect(nextPhraseLine(13)).toBe(16);
    expect(nextPhraseLine(16)).toBe(16);
    expect(nextPhraseLine(13, 2)).toBe(14);
  });
});

describe('derived tempo map', () => {
  const tl = createTimeline(0, bpmToCps(120));
  const bpmsAt = (t: ReturnType<typeof createTimeline>, cycles: number[]) => cycles.map((c) => Math.round(cpsToBpm(cpsAtCycle(t, c)) * 10) / 10);

  it('keeps later sections\' tempo changes when an earlier one moves (review regression)', () => {
    const sections = [
      { startCycle: 24, bars: 16, toCps: bpmToCps(124), rampBars: 4, rampAt: 'start' as const },
      { startCycle: 48, bars: 16, toCps: bpmToCps(128), rampBars: 0, rampAt: 'start' as const },
    ];
    const built = buildTimeline(tl, 8, sections);
    expect(bpmsAt(built, [10, 24.5, 28, 47, 48])).toEqual([120, 120, 124, 124, 128]);
  });
  it('never ramps from a stale revoked segment (review regression)', () => {
    const stale = withTempoAt(tl, 32, bpmToCps(124));
    const built = buildTimeline(stale, 8, [{ startCycle: 32, bars: 16, toCps: bpmToCps(118), rampBars: 4, rampAt: 'start' }]);
    expect(bpmsAt(built, [31, 32.5, 33.5, 36])).toEqual([120, 120, 119.5, 118]);
  });
  it('ramps into the end of a section when rampAt is end', () => {
    const built = buildTimeline(tl, 0, [{ startCycle: 16, bars: 16, toCps: bpmToCps(100), rampBars: 4, rampAt: 'end' }]);
    expect(bpmsAt(built, [20, 28.5, 32])).toEqual([120, 120, 100]);
  });
  it('leaves segments at or before the lock cycle untouched', () => {
    const played = withTempoRamp(tl, 4, 4, bpmToCps(130));
    const built = buildTimeline(played, 6, [
      { startCycle: 4, bars: 16, toCps: bpmToCps(130), rampBars: 4, rampAt: 'start' },
      { startCycle: 32, bars: 16, toCps: bpmToCps(110), rampBars: 0, rampAt: 'start' },
    ]);
    // the ramp in progress resumes exactly as originally scheduled
    expect(bpmsAt(built, [7])).toEqual(bpmsAt(played, [7]));
    expect(built.segments.filter((s) => s.startCycle <= 6)).toEqual(played.segments.filter((s) => s.startCycle <= 6));
    expect(bpmsAt(built, [8, 32])).toEqual([130, 110]);
    // phase stays continuous
    expect(msAtCycle(built, 8)).toBeCloseTo(msAtCycle(played, 8), 6);
  });
});

describe('plain text', () => {
  it('strips control, bidi and angle brackets', () => {
    expect(sanitizePlainText('hi\u0007 <b>there</b>‮  ok', 140)).toBe('hi bthere/b ok');
  });
  it('removes urls from requests', () => {
    expect(sanitizeRequestText('more bass at https://evil.example/x please')).toBe('more bass at please');
  });
  it('flags urls and markup in public text', () => {
    expect(isPublicText('Down into the harbour')).toBe(true);
    expect(isPublicText('see www.example.com')).toBe(false);
    expect(isPublicText('[click](x)')).toBe(false);
    expect(isPublicText('<img>')).toBe(false);
  });
  it('merges equivalent requests', () => {
    expect(requestMergeKey('More jazz pls!')).toBe(requestMergeKey('jazz'));
  });
});

describe('fingerprint distance', () => {
  const fp = (over: Partial<SectionFingerprint> = {}): SectionFingerprint => ({
    descriptors: { intensity: 0.5, brightness: 0.5, density: 0.5, tension: 0.3 },
    soundShares: { rolandtr909_bd: 0.5, gm_epiano1: 0.5 },
    kickGrid16: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    backbeatGrid16: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
    scale: 'D:dorian',
    bpm: 120,
    chordHash: 'a',
    ...over,
  });
  it('is 0 for identical sections and grows with change', () => {
    expect(fingerprintDistance(fp(), fp())).toBe(0);
    const swapSound = fingerprintDistance(fp(), fp({ soundShares: { rolandtr909_bd: 0.5, vibraphone: 0.5 } }));
    const newWorld = fingerprintDistance(
      fp(),
      fp({ soundShares: { tabla: 1 }, scale: 'E:phrygian', bpm: 90, chordHash: 'b', kickGrid16: new Array(16).fill(0) }),
    );
    expect(swapSound).toBeGreaterThan(0.1);
    expect(newWorld).toBeGreaterThan(swapSound);
    expect(newWorld).toBeLessThanOrEqual(1);
  });
});
