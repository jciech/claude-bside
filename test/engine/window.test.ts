import { describe, expect, it } from 'vitest';
import { instanceKnobsAt } from '../../src/client/engine/envelope.ts';
import { buildScore, effectiveTransition } from '../../src/client/engine/score.ts';
import { EMPTY_MIXER } from '../../src/shared/program.ts';
import { cutAfter, cutForRun, inWindowAt, isDiscontinuity, lastExitBefore, runs } from '../../src/client/engine/window.ts';
import { part, section, sectionA, sectionB } from './fixtures.ts';

const score = buildScore([sectionA, sectionB], new Map());
const inst = (key: string) => score.byKey.get(key)!;

describe('instances from the fixture', () => {
  it('derives extents: continuing parts hand over at bar 0, outgoing ones overlap the crossfade', () => {
    expect(inst('fx01-0001:kick')).toMatchObject({ start: 0, end: 16, continuedByNext: true, continuing: false });
    expect(inst('fx01-0002:kick')).toMatchObject({ start: 16, end: Infinity, continuing: true });
    expect(inst('fx01-0001:hats')).toMatchObject({ start: 0, end: 18, fadeOut: { at: 16, bars: 2 } });
    expect(inst('fx01-0001:pad')).toMatchObject({ end: 18, fadeOut: { at: 16, bars: 2 } });
    expect(inst('fx01-0002:hats')).toMatchObject({ start: 16, fadeIn: { at: 16, bars: 2 } });
    expect(inst('fx01-0002:fill')).toMatchObject({ start: 15, end: Infinity, fadeIn: null });
    expect(inst('fx01-0002:lead').fadeIn).toEqual({ at: 16, bars: 2 });
  });

  it('plays a carried part from its knob default (the value the conductor carried over), with or without the section before', () => {
    const alone = buildScore([sectionB], new Map()).byKey.get('fx01-0002:bass')!;
    for (const bass of [inst('fx01-0002:bass'), alone]) expect(instanceKnobsAt(bass, 20, EMPTY_MIXER)).toEqual({ cut: 1200 });
  });

  it('skips a transition window that began before the section arrived', () => {
    expect(effectiveTransition(sectionB, 10)).toBe('crossfade');
    expect(effectiveTransition(sectionB, 16.5)).toBe('cut');
    const riser = section({ id: 'r', startCycle: 32, transitionIn: { type: 'riser', bars: 4 }, parts: [] });
    expect(effectiveTransition(riser, 27)).toBe('riser');
    expect(effectiveTransition(riser, 29)).toBe('cut');
    const late = buildScore([sectionA, sectionB], new Map([['fx01-0002', 17]]));
    expect(late.byKey.get('fx01-0001:hats')).toMatchObject({ end: 16, fadeOut: null });
  });

  it('cuts outgoing pitched parts instead of crossfading when the scale changes', () => {
    const b = { ...sectionB, scale: 'E:minor' };
    const s = buildScore([sectionA, b], new Map());
    expect(s.byKey.get('fx01-0001:pad')).toMatchObject({ end: 16, fadeOut: null });
    expect(s.byKey.get('fx01-0001:hats')).toMatchObject({ end: 18 });
  });
});

describe('runs', () => {
  it('opens the window at enterBar with an entry', () => {
    expect(runs(inst('fx01-0001:hats'), 3.9, 4.1)).toEqual([{ from: 4, to: 4.1, shift: 0, entry: true }]);
    expect(runs(inst('fx01-0001:hats'), 4, 4.1)).toEqual([{ from: 4, to: 4.1, shift: 0, entry: true }]);
    expect(runs(inst('fx01-0001:hats'), 4.1, 4.2)).toEqual([{ from: 4.1, to: 4.2, shift: 0, entry: false }]);
    expect(runs(inst('fx01-0001:hats'), 2, 3)).toEqual([]);
  });

  it('plays the pickup in the bar before B only', () => {
    const fill = inst('fx01-0002:fill');
    expect(runs(fill, 14, 17)).toEqual([{ from: 15, to: 16, shift: 0, entry: true }]);
  });

  it('loops the last phrase past the score (outgoing crossfade tail) with an entry at the loop point', () => {
    const pad = inst('fx01-0001:pad');
    expect(isDiscontinuity(pad, 16)).toBe(true);
    expect(runs(pad, 15.5, 17)).toEqual([
      { from: 15.5, to: 16, shift: 0, entry: false },
      { from: 16, to: 17, shift: 8, entry: true },
    ]);
  });

  it('never re-onsets or splits a continuing instance, and hands over at the boundary', () => {
    const a = inst('fx01-0001:kick');
    const b = inst('fx01-0002:kick');
    expect(runs(a, 15.9, 16.1)).toEqual([{ from: 15.9, to: 16, shift: 0, entry: false }]);
    expect(runs(b, 15.9, 16.1)).toEqual([{ from: 16, to: 16.1, shift: 0, entry: false }]);
    expect(runs(b, 40, 41)).toEqual([{ from: 40, to: 41, shift: 0, entry: false }]);
  });

  it('marks the output start as an entry for every instance', () => {
    expect(runs(inst('fx01-0002:kick'), 20, 20.2, 20)[0]!.entry).toBe(true);
  });

  it('maps Stay/Move-on jumps onto score time', () => {
    const s = section({ id: 's', startCycle: 100, bars: 16, jumps: [{ atBar: 12, toBar: 8 }], parts: [part({ id: 'p', enterBar: 0 })] });
    const p = buildScore([s], new Map()).byKey.get('s:p')!;
    expect(runs(p, 111, 113)).toEqual([
      { from: 111, to: 112, shift: 0, entry: false },
      { from: 112, to: 113, shift: 4, entry: true },
    ]);
  });

  it('re-enters a window each vamp loop when the exit lies inside the loop', () => {
    const s = section({ id: 'v', startCycle: 0, bars: 16, parts: [part({ id: 'p', enterBar: 10, exitBar: 14 })] });
    const p = buildScore([s], new Map()).byKey.get('v:p')!;
    expect(runs(p, 0, 32).map((r) => [r.from, r.to, r.shift, r.entry])).toEqual([
      [10, 14, 0, true],
      [18, 22, 8, true],
      [26, 30, 16, true],
    ]);
  });
});

describe('cuts', () => {
  it('truncates at window exits, section ends and score discontinuities, never where a part continues', () => {
    expect(cutAfter(inst('fx01-0001:kick'), 15)).toBe(Infinity);
    expect(cutAfter(inst('fx01-0001:hats'), 15)).toBe(16); // vamp loop point inside the crossfade tail
    expect(cutAfter(inst('fx01-0001:hats'), 16.5)).toBe(18);
    expect(cutAfter(inst('fx01-0002:fill'), 15.5)).toBe(16);
    expect(cutAfter(inst('fx01-0002:lead'), 30)).toBe(48); // B vamps (loop point at its bar 32)
    const run = runs(inst('fx01-0002:fill'), 15, 15.5)[0]!;
    expect(cutForRun(inst('fx01-0002:fill'), run, 15.5)).toBe(16);
  });

  it('knows when an instance sounds and when it last stopped', () => {
    const fill = inst('fx01-0002:fill');
    expect(inWindowAt(fill, 15.5)).toBe(true);
    expect(inWindowAt(fill, 16)).toBe(false);
    expect(lastExitBefore(fill, 16.2, 1)).toBe(16);
    expect(lastExitBefore(inst('fx01-0001:kick'), 16.2, 1)).toBeNull();
    expect(lastExitBefore(inst('fx01-0001:hats'), 18.1, 1)).toBe(18);
  });
});
