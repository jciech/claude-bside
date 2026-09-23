import { describe, expect, it } from 'vitest';
import { bpmToCps } from '../../src/shared/music.ts';
import type { ProgramPart, SectionProgram } from '../../src/shared/program.ts';
import { lockMs, publishDeadlineMs } from '../../src/shared/schedule.ts';
import { createTimeline, msAtCycle } from '../../src/shared/timeline.ts';
import { changeableAt, patternBarAt, place, plannedEnd, rebuildTimeline, scoreEndAt, type PlacementInput } from '../../src/server/conductor/placement.ts';
import { decideKeep } from '../../src/server/conductor/keep.ts';
import { bpmsAt } from './harness.ts';

const T0 = 1_000_000;
const tl = createTimeline(T0, bpmToCps(120)); // 2 s per bar

function prog(id: string, startCycle: number, over: Partial<SectionProgram> = {}): SectionProgram {
  const p = (pid: string, extra: Partial<ProgramPart> = {}): ProgramPart => ({
    id: pid,
    role: 'pad',
    code: 's("triangle")',
    orbit: 1,
    level: 0.8,
    trimDb: 0,
    enterBar: 0,
    exitBar: null,
    knobs: [],
    automation: [],
    duck: null,
    originCycle: startCycle,
    continues: false,
    carried: false,
    chromatic: false,
    instrument: '',
    digest: null,
    ...extra,
  });
  const flat = { start: 0.5, end: 0.5 };
  return {
    id,
    rev: 1,
    index: 1,
    track: 1,
    movementId: 'm1',
    name: id,
    role: 'groove',
    startCycle,
    bars: 16,
    jumps: [],
    vamp: { allowed: true, loopBars: 8 },
    provisional: false,
    tempo: { fromBpm: 120, toBpm: 120, rampBars: 0, rampAt: 'start' },
    scale: 'D:dorian',
    chords: null,
    transitionIn: { type: 'cut', bars: 0 },
    targets: { intensity: flat, brightness: flat, density: flat, tension: flat },
    measured: { intensity: flat, brightness: flat, density: flat, tension: flat },
    parts: [p('pad', { orbit: 1 }), p('kick', { orbit: 2, role: 'kick' })],
    publicNote: '',
    author: 'scripted',
    ...over,
  };
}

const cut = { type: 'cut' as const, bars: 0 };
const input = (over: Partial<PlacementInput>): PlacementInput => ({
  mode: 'horizon',
  sections: [],
  replaces: [],
  planningLocked: new Set(),
  timeline: tl,
  nowMs: T0,
  shapes: [{ transitionIn: cut, parts: [{ enterBar: 0 }], bars: 16 }],
  gridOrigin: 0,
  ...over,
});

describe('placement under the lock', () => {
  it('follows the locked horizon exactly when the publish deadline can be met', () => {
    const a = prog('a', 0);
    const b = prog('b', 16);
    const r = place(input({ sections: [a, b], nowMs: msAtCycle(tl, 4) }));
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ startCycle: 32, anchor: { id: 'b' }, revokes: [], preload: true, lateBars: 0 });
  });

  it('lands on the first later 4-bar line whose preload deadline still holds when the tail is vamping', () => {
    const a = prog('a', 0);
    // Now is bar 20.5: a's planned end (16) is behind us; preload needs 8 s + 2 bars = 6 bars ahead.
    const now = msAtCycle(tl, 20.5);
    const r = place(input({ sections: [a], nowMs: now }));
    if ('error' in r) throw new Error(r.error);
    expect(r.startCycle).toBe(28);
    expect(publishDeadlineMs(tl, { startCycle: 28, transitionIn: cut, parts: [] })).toBeGreaterThanOrEqual(now);
    expect(publishDeadlineMs(tl, { startCycle: 24, transitionIn: cut, parts: [] })).toBeLessThan(now);
    expect(r.lateBars).toBe(12);
  });

  it('counts pre-roll: a riser section must be placed so its riser starts after its lock point', () => {
    const a = prog('a', 0);
    const now = msAtCycle(tl, 10);
    const riser = [{ transitionIn: { type: 'riser' as const, bars: 8 }, parts: [{ enterBar: 0 }], bars: 16 }];
    const r = place(input({ sections: [a], nowMs: now, shapes: riser }));
    if ('error' in r) throw new Error(r.error);
    // Influence = start − 8 must be more than 8 s + 2 bars (6 bars at 120 BPM) ahead: start > 24.
    expect(r.startCycle).toBe(28);
  });

  it('replaces only provisional, unlocked sections and revokes them together with everything after', () => {
    const a = prog('a', 0);
    const b = prog('b', 16);
    const c = prog('c', 32, { provisional: true });
    const r = place(input({ sections: [a, b, c], replaces: ['c'], nowMs: msAtCycle(tl, 2) }));
    if ('error' in r) throw new Error(r.error);
    expect(r).toMatchObject({ startCycle: 32, anchor: { id: 'b' }, revokes: ['c'], lockedReplaces: [] });
  });

  it('refuses to replace a provisional section once it is inside its lock window (a change attempted inside the lock)', () => {
    const a = prog('a', 0);
    const b = prog('b', 16, { provisional: true });
    // b's lock point is 4 s (2 bars) before bar 16; now is bar 15.
    const now = msAtCycle(tl, 15);
    expect(now).toBeGreaterThan(lockMs(tl, b));
    const r = place(input({ sections: [a, b], replaces: ['b'], nowMs: now }));
    if ('error' in r) throw new Error(r.error);
    expect(r.revokes).toEqual([]);
    expect(r.lockedReplaces).toEqual(['b']);
    expect(r.anchor?.id).toBe('b');
    expect(r.startCycle).toBeGreaterThanOrEqual(32);
  });

  it('never replaces the playing section\'s successor even when provisional (planning-locked)', () => {
    const a = prog('a', 0);
    const b = prog('b', 16, { provisional: true });
    const r = place(input({ sections: [a, b], replaces: ['b'], planningLocked: new Set(['a', 'b']), nowMs: msAtCycle(tl, 1) }));
    if ('error' in r) throw new Error(r.error);
    expect(r.revokes).toEqual([]);
    expect(r.lockedReplaces).toEqual(['b']);
  });

  it('next mode revokes every unlocked section and cuts in at the first line with preload', () => {
    const a = prog('a', 0, { bars: 32 });
    const b = prog('b', 32);
    const now = msAtCycle(tl, 5);
    const r = place(input({ mode: 'next', sections: [a, b], nowMs: now }));
    if ('error' in r) throw new Error(r.error);
    expect(r.revokes).toEqual(['b']);
    expect(r.anchor?.id).toBe('a');
    expect(r.startCycle).toBe(12); // 5 + 6 bars of preload → first 4-bar line at 12
    expect(r.preload).toBe(true);
  });

  it('now mode only needs the lock point (preload not guaranteed)', () => {
    const a = prog('a', 0, { bars: 32 });
    const now = msAtCycle(tl, 5);
    const r = place(input({ mode: 'now', sections: [a], nowMs: now }));
    if ('error' in r) throw new Error(r.error);
    expect(r.startCycle).toBe(8); // lock: 2 bars (4 s) + margin before bar 8
    expect(r.preload).toBe(false);
  });

  it('next mode keeps a hard-locked successor and places after it', () => {
    const a = prog('a', 0);
    const b = prog('b', 16);
    const r = place(input({ mode: 'next', sections: [a, b], nowMs: msAtCycle(tl, 14.5) }));
    if ('error' in r) throw new Error(r.error);
    expect(r.revokes).toEqual([]);
    expect(r.anchor?.id).toBe('b');
    expect(r.startCycle).toBeGreaterThan(16);
  });

  it('checks the lock of every section of a two-section plan', () => {
    const a = prog('a', 0);
    const shapes = [
      { transitionIn: cut, parts: [{ enterBar: 0 }], bars: 8 },
      { transitionIn: { type: 'riser' as const, bars: 8 }, parts: [{ enterBar: 0 }], bars: 16 },
    ];
    const now = msAtCycle(tl, 14);
    const r = place(input({ mode: 'now', sections: [a], nowMs: now, shapes }));
    if ('error' in r) throw new Error(r.error);
    // Second section's riser starts at its predecessor's bar 0; both must be ahead of the lock.
    expect(lockMs(tl, { startCycle: r.startCycle + 8, transitionIn: shapes[1]!.transitionIn, parts: [] })).toBeGreaterThan(now);
  });

  it('after a section that must not vamp, a pre-roll that would push the plan past its end is refused with the pre-roll that still fits', () => {
    const build = prog('build', 20, { bars: 32, role: 'build', vamp: { allowed: false, loopBars: 8 } });
    // 3 s before the soft deadline a cut would still land at 52: its publish deadline is bar 46.
    const now = publishDeadlineMs(tl, { startCycle: 52, transitionIn: cut, parts: [] }) - 3000 - 3000;
    const riser = (bars: number) => [{ transitionIn: { type: 'riser' as const, bars }, parts: [{ enterBar: 0 }], bars: 32 }];
    const r = place(input({ sections: [build], nowMs: now, shapes: riser(8) }));
    expect(r).toEqual({ error: expect.stringMatching(/must not vamp.*cycle 52.*at most 2 bars/) });
    const pickup = place(input({ sections: [build], nowMs: now, shapes: [{ transitionIn: cut, parts: [{ enterBar: -4 }], bars: 32 }] }));
    expect('error' in pickup).toBe(true);
    for (const shapes of [riser(2), [{ transitionIn: cut, parts: [{ enterBar: 0 }], bars: 32 }]]) {
      const ok = place(input({ sections: [build], nowMs: now, shapes }));
      if ('error' in ok) throw new Error(ok.error);
      expect(ok).toMatchObject({ startCycle: 52, lateBars: 0 });
    }
    // The autopilot's fill only needs the lock, and a tail that may vamp still takes the next line that fits.
    const fill = place(input({ mode: 'fill', sections: [build], nowMs: now, shapes: riser(8) }));
    if ('error' in fill) throw new Error(fill.error);
    expect(fill.startCycle).toBe(56);
    const vamping = place(input({ sections: [{ ...build, role: 'groove', vamp: { allowed: true, loopBars: 8 } }], nowMs: now, shapes: riser(8) }));
    if ('error' in vamping) throw new Error(vamping.error);
    expect(vamping).toMatchObject({ startCycle: 60, lateBars: 8 });
  });
});

describe('continuation origins', () => {
  it('continues pattern time exactly across a plain boundary', () => {
    const a = prog('a', 0);
    // A fresh part in `a` (origin 0) reaches pattern bar 16 at cycle 16.
    expect(patternBarAt(a, a.parts[0]!, 16)).toBe(16);
  });

  it('continues from the vamp position when the tail vamped', () => {
    const a = prog('a', 0); // vamp loops [8, 16)
    // Played 20 bars: bars 16..19 replayed score 8..11, so the next pattern bar is 12.
    expect(scoreEndAt(a, 20)).toBe(12);
    expect(patternBarAt(a, a.parts[0]!, 20)).toBe(12);
    // After a whole number of loops the pattern moves on to bar 16, not back to 8.
    expect(scoreEndAt(a, 24)).toBe(16);
  });

  it('continues after a Stay jump from where the score really is', () => {
    const a = prog('a', 0, { bars: 32, jumps: [{ atBar: 24, toBar: 16 }] });
    expect(plannedEnd(a)).toBe(40);
    expect(patternBarAt(a, a.parts[0]!, 40)).toBe(32);
    expect(patternBarAt(a, a.parts[0]!, 30)).toBe(22); // inside the repeated phrase
  });

  it('inherits the origin of an instance that already continues (play time)', () => {
    const a = prog('a', 16, { jumps: [{ atBar: 8, toBar: 0 }] });
    const cont = { ...a.parts[0]!, continues: true, originCycle: 3 };
    expect(patternBarAt(a, cont, 40)).toBe(37);
  });

  it('accounts for a non-continuing instance whose origin predates its section (restored data)', () => {
    const a = prog('a', 16);
    expect(patternBarAt(a, { continues: false, originCycle: 0 }, 32)).toBe(32);
  });
});

describe('Stay / Move on', () => {
  const now = (cycle: number) => msAtCycle(tl, cycle);

  it('Stay repeats the penultimate phrase and pushes the successor by 8 bars', () => {
    const a = prog('a', 0, { bars: 32 });
    const b = prog('b', 32);
    const o = decideKeep({ current: a, next: b, direction: 1, timeline: tl, nowMs: now(10), nowCycle: 10 });
    expect(o).toMatchObject({ ok: true, kind: 'extend', jumps: [{ atBar: 24, toBar: 16 }], shift: 8, atCycle: 24, needsPlan: false });
  });

  it('Stay is refused for builds, intros and transitions', () => {
    for (const role of ['build', 'intro', 'transition'] as const) {
      const o = decideKeep({ current: prog('a', 0, { bars: 32, role }), next: null, direction: 1, timeline: tl, nowMs: now(4), nowCycle: 4 });
      expect(o).toMatchObject({ ok: false, blocked: 'role' });
    }
  });

  it('Stay at most twice, then reports the limit (max) rather than the lock', () => {
    const once = prog('a', 0, { bars: 32, jumps: [{ atBar: 24, toBar: 16 }] });
    expect(decideKeep({ current: once, next: null, direction: 1, timeline: tl, nowMs: now(4), nowCycle: 4 }).ok).toBe(true);
    const a = prog('a', 0, { bars: 32, jumps: [{ atBar: 24, toBar: 16 }, { atBar: 24, toBar: 16 }] });
    expect(decideKeep({ current: a, next: null, direction: 1, timeline: tl, nowMs: now(4), nowCycle: 4 })).toMatchObject({ ok: false, kind: 'extend', blocked: 'max' });
  });

  it('a Stay inside the lock window is refused', () => {
    const a = prog('a', 0, { bars: 32 });
    // The jump would act at bar 24; at bar 22.5 that is closer than max(4 s, 2 bars).
    expect(changeableAt(tl, 24, now(22.5))).toBe(false);
    expect(decideKeep({ current: a, next: null, direction: 1, timeline: tl, nowMs: now(22.5), nowCycle: 22.5 })).toMatchObject({ ok: false, blocked: 'locked' });
  });

  it('Move on jumps from the next 8-bar line to the final phrase and pulls the successor in', () => {
    const a = prog('a', 0, { bars: 32 });
    const b = prog('b', 32);
    const o = decideKeep({ current: a, next: b, direction: -1, timeline: tl, nowMs: now(3), nowCycle: 3 });
    expect(o).toMatchObject({ ok: true, kind: 'shorten', jumps: [{ atBar: 8, toBar: 24 }], shift: -16, atCycle: 8, needsPlan: false });
  });

  it('Move on skips a line that is already inside the lock window', () => {
    const a = prog('a', 0, { bars: 32 });
    const o = decideKeep({ current: a, next: null, direction: -1, timeline: tl, nowMs: now(6.5), nowCycle: 6.5 });
    expect(o).toMatchObject({ ok: true, jumps: [{ atBar: 16, toBar: 24 }], atCycle: 16, needsPlan: true });
  });

  it('Move on waits for a line whose successor can still move (next-not-ready)', () => {
    const a = prog('a', 0, { bars: 48 });
    const b = prog('b', 48, { transitionIn: { type: 'riser', bars: 16 } });
    // Line 8 would move b to 16 with its riser from bar 0: past its lock. Line 16 → b at 24, riser from 8: fine.
    const o = decideKeep({ current: a, next: b, direction: -1, timeline: tl, nowMs: now(3), nowCycle: 3 });
    expect(o).toMatchObject({ ok: true, atCycle: 16, shift: -24 });
  });

  it('Move on reports min-length when the track ends anyway', () => {
    const a = prog('a', 0, { bars: 16 });
    expect(decideKeep({ current: a, next: prog('b', 16), direction: -1, timeline: tl, nowMs: now(2), nowCycle: 2 })).toMatchObject({ ok: false, blocked: 'min-length' });
  });

  it('Move on before a pending Stay cancels the repeat instead of reporting min-length', () => {
    const a = prog('a', 0, { bars: 32, jumps: [{ atBar: 24, toBar: 16 }] });
    for (const next of [null, prog('b', 40)]) {
      for (const played of [16, 17, 21]) {
        const o = decideKeep({ current: a, next, direction: -1, timeline: tl, nowMs: now(played), nowCycle: played });
        expect(o).toEqual({ ok: true, kind: 'shorten', jumps: [], shift: -8, atCycle: 24, needsPlan: next === null });
      }
    }
    // A second pending Stay is cancelled on its own once the first has played.
    const twice = prog('a', 0, { bars: 32, jumps: [{ atBar: 24, toBar: 16 }, { atBar: 24, toBar: 16 }] });
    expect(decideKeep({ current: twice, next: null, direction: -1, timeline: tl, nowMs: now(25), nowCycle: 25 })).toMatchObject({
      ok: true,
      jumps: [{ atBar: 24, toBar: 16 }],
      shift: -8,
      atCycle: 32,
    });
    // Once the Stay has played, the final phrase comes anyway.
    expect(decideKeep({ current: a, next: null, direction: -1, timeline: tl, nowMs: now(25), nowCycle: 25 })).toMatchObject({ ok: false, blocked: 'min-length' });
  });

  it('Stay and Move on measure from where a successor that cut in early really starts', () => {
    const a = prog('a', 0, { bars: 32 });
    // A --next commit cut in at bar 16: the final phrase of a is never reached.
    const early = prog('b', 16);
    expect(decideKeep({ current: a, next: early, direction: -1, timeline: tl, nowMs: now(3), nowCycle: 3 })).toMatchObject({ ok: false, blocked: 'min-length' });
    // Move on still shortens a section cut in later: the successor follows the final phrase.
    const later = prog('b', 28);
    expect(decideKeep({ current: a, next: later, direction: -1, timeline: tl, nowMs: now(3), nowCycle: 3 })).toEqual({
      ok: true,
      kind: 'shorten',
      jumps: [{ atBar: 8, toBar: 24 }],
      shift: -12,
      atCycle: 8,
      needsPlan: false,
    });
    // Stay repeats the phrase before the cut, where it is heard, and pushes the successor by that much.
    expect(decideKeep({ current: a, next: early, direction: 1, timeline: tl, nowMs: now(3), nowCycle: 3 })).toEqual({
      ok: true,
      kind: 'extend',
      jumps: [{ atBar: 16, toBar: 8 }],
      shift: 8,
      atCycle: 16,
      needsPlan: false,
    });
  });

  it('Move on while the tail vamps asks for a plan', () => {
    const a = prog('a', 0, { bars: 16 });
    expect(decideKeep({ current: a, next: null, direction: -1, timeline: tl, nowMs: now(20), nowCycle: 20 })).toMatchObject({ ok: true, needsPlan: true, atCycle: null, shift: 0 });
  });

  it('a ramp into the end moves with the end, so it must still be changeable', () => {
    const a = prog('a', 0, { bars: 32, tempo: { fromBpm: 120, toBpm: 110, rampBars: 12, rampAt: 'end' } });
    // Stay at bar 12: the old ramp starts at bar 20, the jump at 24 — still changeable.
    expect(decideKeep({ current: a, next: null, direction: 1, timeline: tl, nowMs: now(12), nowCycle: 12 }).ok).toBe(true);
    // At bar 19 the ramp start (20) is inside the lock window.
    expect(decideKeep({ current: a, next: null, direction: 1, timeline: tl, nowMs: now(19), nowCycle: 19 })).toMatchObject({ ok: false, blocked: 'locked' });
  });
});

describe('derived tempo map', () => {
  it('rebuilds later tempo changes when a section moves (Stay/Move on), never leaving stale segments', () => {
    const a = prog('a', 0, { bars: 32 });
    const b = prog('b', 32, { tempo: { fromBpm: 120, toBpm: 124, rampBars: 4, rampAt: 'start' } });
    const c = prog('c', 48, { tempo: { fromBpm: 124, toBpm: 128, rampBars: 0, rampAt: 'start' } });
    const before = rebuildTimeline(tl, T0, [a, b, c]);
    expect(bpmsAt(before, [31, 36, 47, 48])).toEqual([120, 124, 124, 128]);
    // Stay on a: b and c move 8 bars later; their tempo changes move with them.
    const moved = [{ ...a, jumps: [{ atBar: 24, toBar: 16 }] }, { ...b, startCycle: 40 }, { ...c, startCycle: 56 }];
    const after = rebuildTimeline(before, msAtCycle(before, 10), moved);
    expect(bpmsAt(after, [39, 41, 44, 55, 56])).toEqual([120, 121, 124, 124, 128]);
  });

  it('drops a revoked section\'s tempo and ramps its replacement from the tempo before it', () => {
    const a = prog('a', 0);
    const b = prog('b', 16, { tempo: { fromBpm: 120, toBpm: 124, rampBars: 0, rampAt: 'start' } });
    const withB = rebuildTimeline(tl, T0, [a, b]);
    expect(bpmsAt(withB, [16])).toEqual([124]);
    const b2 = prog('b2', 16, { tempo: { fromBpm: 120, toBpm: 118, rampBars: 2, rampAt: 'start' } });
    const replaced = rebuildTimeline(withB, msAtCycle(withB, 2), [a, b2]);
    expect(bpmsAt(replaced, [15, 16.5, 17.5, 20])).toEqual([120, 120, 119, 118]);
  });

  it('keeps segments inside the change lead untouched', () => {
    const a = prog('a', 0, { tempo: { fromBpm: 120, toBpm: 120, rampBars: 0, rampAt: 'start' } });
    const b = prog('b', 16, { tempo: { fromBpm: 120, toBpm: 130, rampBars: 0, rampAt: 'start' } });
    const built = rebuildTimeline(tl, T0, [a, b]);
    // One bar before b, an attempt to drop b cannot remove its tempo change (inside the lead).
    const late = rebuildTimeline(built, msAtCycle(built, 15), [a]);
    expect(bpmsAt(late, [16])).toEqual([130]);
  });
});
