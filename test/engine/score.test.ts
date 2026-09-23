import { describe, expect, it } from 'vitest';
import { instanceKnobsAt } from '../../src/client/engine/envelope.ts';
import { affectedFrom, buildScore, sectionAt, timelineDiffFrom } from '../../src/client/engine/score.ts';
import { withCarriedKnobs } from '../../src/server/conductor/compile.ts';
import { EMPTY_MIXER, type SectionProgram } from '../../src/shared/program.ts';
import { createTimeline, pruneTimeline, withTempoAt, withTempoRamp } from '../../src/shared/timeline.ts';
import { part, section, sectionA, sectionB } from './fixtures.ts';

describe('carried knob values', () => {
  // s0 opens the pad's cut 400 → 4000; s1 and s2 carry it without lanes (as the conductor compiles them).
  const cut = { name: 'cut', default: 400, min: 300, max: 4000, follows: 'none' as const };
  const pad = (over: Parameters<typeof part>[0]) => part({ role: 'pad', code: 'note("c3").s("sine").lpf(knob("cut"))', orbit: 1, knobs: [cut], ...over });
  const s0 = section({ id: 's0', startCycle: 0, parts: [pad({ id: 'pad', automation: [{ target: 'knob:cut', fromBar: 0, toBar: 16, from: 400, to: 4000, curve: 'linear' }] })] });
  const carried = (prev: SectionProgram, id: string, bars: 16 | 32) =>
    withCarriedKnobs(section({ id, startCycle: prev.startCycle + prev.bars, bars, parts: [pad({ id: 'pad', carried: true, continues: true })] }), prev);
  const s1 = carried(s0, 's1', 16);
  const s2 = carried(s1, 's2', 32);
  const cutAt = (sections: SectionProgram[], cycle: number) => instanceKnobsAt(buildScore(sections, new Map()).byKey.get('s2:pad')!, cycle, EMPTY_MIXER);

  it('are the same whatever history a client holds (a late joiner, or after old sections are forgotten)', () => {
    expect(cutAt([s0, s1, s2], 52)).toEqual({ cut: 4000 });
    expect(cutAt([s1, s2], 52)).toEqual({ cut: 4000 });
    expect(cutAt([s2], 52)).toEqual({ cut: 4000 });
  });
});

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
