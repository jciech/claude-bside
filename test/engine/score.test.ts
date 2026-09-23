import { describe, expect, it } from 'vitest';
import { affectedFrom, sectionAt, timelineDiffFrom } from '../../src/client/engine/score.ts';
import { createTimeline, pruneTimeline, withTempoAt, withTempoRamp } from '../../src/shared/timeline.ts';
import { sectionA, sectionB } from './fixtures.ts';

describe('affectedFrom (what a schedule change touches)', () => {
  it('counts a new or revoked section from its influence cycle (pre-roll included)', () => {
    expect(affectedFrom(undefined, sectionB)).toBe(15); // the fill pickup starts a bar early
    expect(affectedFrom(sectionB, undefined)).toBe(15);
    expect(affectedFrom(undefined, undefined)).toBe(Infinity);
  });

  it('ignores a re-issue that changes nothing audible (rev bump, provisional flag, notes)', () => {
    expect(affectedFrom(sectionB, { ...sectionB, rev: 2, provisional: false, publicNote: 'changed', name: 'New name' })).toBe(Infinity);
  });

  it('counts a Stay/Move-on jump only from the bar where score time changes', () => {
    const stay = { ...sectionB, rev: 2, jumps: [{ atBar: 24, toBar: 16 }] };
    expect(affectedFrom(sectionB, stay)).toBe(16 + 24);
    const moveOn = { ...sectionB, rev: 2, jumps: [{ atBar: 16, toBar: 24 }] };
    expect(affectedFrom(sectionB, moveOn)).toBe(16 + 16);
  });

  it('counts anything else about the section from its influence cycle', () => {
    const recoded = { ...sectionB, rev: 2, parts: sectionB.parts.map((p, i) => (i === 3 ? { ...p, level: 0.2 } : p)) };
    expect(affectedFrom(sectionB, recoded)).toBe(15);
    expect(affectedFrom(sectionB, { ...sectionB, rev: 2, transitionIn: { type: 'cut' as const, bars: 0 } })).toBe(15);
  });
});

describe('timelineDiffFrom', () => {
  const base = createTimeline(1_000_000, 0.5, 0);

  it('is Infinity for the same mapping, even when old segments were pruned', () => {
    const tl = withTempoAt(base, 32, 0.55);
    expect(timelineDiffFrom(tl, tl)).toBe(Infinity);
    expect(timelineDiffFrom(tl, pruneTimeline(tl, 1_000_000 + 70_000))).toBe(Infinity);
  });

  it('finds the first cycle where tempo changes', () => {
    expect(timelineDiffFrom(base, withTempoAt(base, 48, 0.6))).toBe(48);
    expect(timelineDiffFrom(withTempoAt(base, 48, 0.6), withTempoRamp(base, 40, 4, 0.6))).toBe(41);
  });
});

describe('sectionAt', () => {
  it('returns the section whose bar 0 is at or before the cycle', () => {
    expect(sectionAt([sectionA, sectionB], -1)).toBeNull();
    expect(sectionAt([sectionA, sectionB], 15.9)?.id).toBe('fx01-0001');
    expect(sectionAt([sectionA, sectionB], 16)?.id).toBe('fx01-0002');
  });
});
