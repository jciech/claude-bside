import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { audibleInstances, nowPlaying, partState, summaryLines } from '../../src/client/ui/now.ts';
import { appendNote, applyScheduleUpdate, applySnapshotToStores, createRoomStores, movementAt, pruneSections, recordEtch, scheduleFromSnapshot, sectionAtCycle } from '../../src/client/ui/stores.ts';
import type { LinerNote, ScheduleUpdate } from '../../src/shared/protocol.ts';
import { sectionA, sectionB, snapshot } from '../engine/fixtures.ts';

const base = scheduleFromSnapshot(snapshot);
const update = (over: Partial<ScheduleUpdate>): ScheduleUpdate => ({ epoch: snapshot.epoch, rev: snapshot.rev + 1, timeline: snapshot.timeline, movements: snapshot.movements, upserts: [], revokes: [], ...over });

describe('schedule reducer', () => {
  it('applies upserts and revokes atomically and keeps sections sorted', () => {
    const moved = { ...sectionB, rev: 2, startCycle: 20 };
    const r = applyScheduleUpdate(base, update({ upserts: [moved], revokes: [sectionA.id] }));
    expect(r.gap).toBe(false);
    expect(r.state.sections.map((s) => [s.id, s.startCycle])).toEqual([[sectionB.id, 20]]);
  });

  it('ignores stale revs and reports gaps and epoch changes', () => {
    expect(applyScheduleUpdate(base, update({ rev: snapshot.rev })).stale).toBe(true);
    expect(applyScheduleUpdate(base, update({ rev: snapshot.rev + 3 })).gap).toBe(true);
    const other = applyScheduleUpdate(base, update({ epoch: 'zzzz' }));
    expect(other.gap).toBe(true);
    expect(other.state).toBe(base);
  });

  it('prunes long-gone sections but keeps the one before the current', () => {
    const later = { ...sectionB, id: 'fx01-0003', startCycle: 48 };
    const pruned = pruneSections([sectionA, sectionB, later], 50);
    expect(pruned.map((s) => s.id)).toEqual([sectionB.id, later.id]);
    expect(pruneSections([sectionA, sectionB], 20).map((s) => s.id)).toEqual([sectionA.id, sectionB.id]);
  });

  it('finds the section, movement and notes the UI needs', () => {
    expect(sectionAtCycle(base.sections, 3)?.id).toBe(sectionA.id);
    expect(sectionAtCycle(base.sections, 100)?.id).toBe(sectionB.id);
    expect(sectionAtCycle(base.sections, -1)).toBeNull();
    expect(movementAt(base.movements, 5)?.side).toBe(1);
    const n = (id: string, cycle: number): LinerNote => ({ id, cycle, kind: 'section', text: id, sectionId: null, answering: [], author: 'claude' });
    expect(appendNote(appendNote([n('a', 0)], n('b', 8)), n('a', 0)).map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('fills every store from a welcome snapshot', () => {
    const stores = createRoomStores();
    applySnapshotToStores(stores, snapshot);
    expect(get(stores.schedule).sections).toHaveLength(2);
    expect(get(stores.you)).toEqual({ hue: 120 });
    expect(get(stores.crowd)?.listeners).toBe(3);
    recordEtch(stores, { type: 'fire', cycle: 10, hue: 120 });
    recordEtch(stores, { type: 'fire', cycle: 40, hue: 120 });
    expect(get(stores.etches).map((e) => e.cycle)).toEqual([40]);
  });
});

describe('now playing', () => {
  it('knows where the track is and what comes next', () => {
    const np = nowPlaying(base, 10);
    expect(np.section?.name).toBe('First Light');
    expect(np.next?.name).toBe('Glass Harbour');
    expect(np.barsToNext).toBe(6);
    expect(np.progress).toBeCloseTo(10 / 16);
  });

  it('has part states around their windows', () => {
    expect(partState({ enterBar: 8, exitBar: null }, 4)).toBe('waiting');
    expect(partState({ enterBar: 0, exitBar: 16 }, 15.5)).toBe('leaving');
    expect(partState({ enterBar: 0, exitBar: 16 }, 16)).toBe('gone');
  });

  it('lists crossfading and pickup instances by engine key', () => {
    // The next section's pickup (fill, enterBar -1) plays over the last bar of this one.
    const before = audibleInstances(base, 15.5).map((x) => x.key);
    expect(before).toContain(`${sectionB.id}:fill`);
    // During B's 2-bar crossfade, A's rewritten hats are still audible; its continuing kick is not doubled.
    const during = audibleInstances(base, 17);
    expect(during.filter((x) => x.leaving).map((x) => x.key)).toEqual([`${sectionA.id}:hats`, `${sectionA.id}:pad`]);
    expect(audibleInstances(base, 20).some((x) => x.leaving)).toBe(false);
  });

  it('keys the What’s-playing lines by instance: a pickup can read exactly like the part it rewrites', () => {
    // B rewrites the pad with a one-bar lead-in on the same instrument, over the last bar of A.
    const pickup = { ...sectionA.parts.find((p) => p.id === 'pad')!, enterBar: -1, continues: false };
    const schedule = applyScheduleUpdate(base, update({ upserts: [{ ...sectionB, rev: 2, parts: [...sectionB.parts, pickup] }] })).state;
    const lines = summaryLines(schedule, 15.5, new Set(['kick']));
    const pads = lines.filter((l) => l.text === 'pad — Triangle, playing');
    expect(pads.map((l) => l.key)).toEqual([`${sectionA.id}:pad`, `${sectionB.id}:pad`]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    expect(lines.find((l) => l.key === `${sectionA.id}:kick`)?.text).toBe('kick — Synth kick, playing (muted in your mix)');
  });
});
