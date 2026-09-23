import { describe, expect, it } from 'vitest';
import { cycleAtMs, msAtCycle } from '../../src/shared/timeline.ts';
import { plannedPlayBars } from '../../src/shared/schedule.ts';
import { STORE_KEYS, type PersistedSession } from '../../src/server/types.ts';
import { createMemoryStore } from '../../src/server/conductor/store.ts';
import { createFakeClock, createRoom, lastSchedule, movement, part, plan, section, type Room } from './harness.ts';

async function boot(over: Parameters<typeof createRoom>[0] = {}): Promise<Room> {
  const room = createRoom(over);
  await room.conductor.start();
  return room;
}

const sectionsOf = (room: Room) => room.conductor.snapshot().sections;
const tail = (room: Room) => sectionsOf(room).at(-1)!;
const claudeRoom = (over: Parameters<typeof createRoom>[0] = {}) => boot({ config: { driver: 'claude' } as never, ...over });

describe('planning requests and deadlines', () => {
  it('asks Claude when the committed horizon drops below the trigger, with deadlines and a context', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const { request } = room.claude.last();
    const t = tail(room);
    const tl = room.conductor.snapshot().timeline;
    expect(request.kind).toBe('section');
    // The boot section was the autopilot's, so Claude's first plan is a handoff.
    expect(request.context.request.reasons).toEqual(['horizon', 'handoff']);
    // The tail can vamp, so the target moves out far enough for a typical compose (p90 60 s).
    expect(request.targetCycle).toBeGreaterThanOrEqual(t.startCycle + t.bars);
    expect(request.softDeadlineMs - room.clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(request.hardDeadlineMs - request.softDeadlineMs).toBe(8 * 2000);
    expect(msAtCycle(tl, request.targetCycle) - request.softDeadlineMs).toBe(8000 + 2 * 2000 + 3000);
    expect(room.conductor.snapshot().composer).toMatchObject({ driver: 'claude', state: 'planning' });
  });

  it('a vamp-able tail waits until the hard deadline, then the autopilot fills and late commits are refused', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const req = room.claude.last();
    await room.clock.advance(req.request.softDeadlineMs - room.clock.now() + 2500);
    expect(req.signal.aborted).toBe(false);
    // Deadlines are checked every bar: the vamping tail makes up to a bar of lateness harmless.
    await room.clock.advance(req.request.hardDeadlineMs - room.clock.now() + 2001);
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toBe('deadline');
    expect(tail(room).author).toBe('scripted');
    const late = await req.tools.commit(plan([section({ role: 'bridge' })]));
    expect(late.errors[0]!.rule).toBe('request-closed');
    expect(room.conductor.previewContext().health.lastPlan).toBe('failed');
  });

  it('a tail that must not vamp (a build) gets the autopilot at the soft deadline', async () => {
    const room = await claudeRoom();
    // Claude follows the boot section with a long build (a role that must not vamp).
    await room.clock.advance(1);
    const first = room.claude.last();
    const r = await room.claude.commit(plan([section({ role: 'build', bars: 64, name: 'Long Build', parts: [part('kick', { code: 's("sbd").rise()' })] })]));
    expect(r.accepted).toBe(true);
    expect(tail(room).vamp.allowed).toBe(false);
    // The build covers the horizon for a while; the next request comes when it no longer does.
    for (let i = 0; i < 64 && room.claude.last() === first; i++) await room.clock.advance(2000);
    const req = room.claude.last();
    expect(req).not.toBe(first);
    const t = tail(room);
    const soft = req.request.softDeadlineMs;
    expect(req.request.targetCycle).toBe(t.startCycle + t.bars);
    // Checked every bar, it acts at the last bar before the soft deadline, never after it.
    await room.clock.advance(soft - room.clock.now() - 2001);
    expect(req.signal.aborted).toBe(false);
    await room.clock.advance(2000);
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toBe('deadline');
    const filled = tail(room);
    expect(filled.author).toBe('scripted');
    expect(filled.startCycle).toBe(t.startCycle + t.bars);
  });

  it('a commit being checked when the deadline hits still lands; the fallback is not needed', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const req = room.claude.last();
    await room.clock.advance(req.request.hardDeadlineMs - room.clock.now() - 1000);
    room.checker.delayMs = 5;
    const pending = req.tools.commit(plan([section({ role: 'bridge', name: 'Just In Time' })]));
    await room.clock.advance(1500);
    const r = await pending;
    expect(r.accepted).toBe(true);
    expect(tail(room).name).toBe('Just In Time');
    expect(sectionsOf(room).filter((s) => s.author === 'scripted')).toHaveLength(1);
  });

  it('a commit still being checked after the accept budget is dropped and the autopilot fills in', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const req = room.claude.last();
    await room.clock.advance(req.request.hardDeadlineMs - room.clock.now() - 500);
    room.checker.delayMs = 150; // real milliseconds: the simulated clock runs far ahead meanwhile
    const pending = req.tools.commit(plan([section({ role: 'bridge', name: 'Too Late' })]));
    await room.clock.advance(4000); // past the deadline: deferred for the commit being checked
    expect(req.signal.aborted).toBe(false);
    await room.clock.advance(4000); // past the accept budget: forced
    expect(req.signal.reason).toBe('deadline');
    const r = await pending;
    expect(r.errors[0]!.rule).toBe('request-closed');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tail(room).author).toBe('scripted');
    expect(sectionsOf(room).some((s) => s.name === 'Too Late')).toBe(false);
  });

  it('three Claude failures open the breaker for five minutes, then one half-open attempt', async () => {
    const room = await claudeRoom();
    for (let i = 0; i < 3; i++) {
      await room.clock.advance(1);
      room.claude.last().resolve({ status: 'failed', reason: 'api error', attempts: 1 });
      await room.clock.advance(1);
      // A failed request is retried after a pause, not in a tight loop.
      expect(room.claude.requests).toHaveLength(i + 1);
      await room.clock.advance(6000);
    }
    expect(room.claude.requests).toHaveLength(3);
    expect(room.conductor.snapshot().composer.state).toBe('failed');
    await room.clock.advance(4 * 60_000);
    expect(room.claude.requests).toHaveLength(3);
    expect(sectionsOf(room).some((s) => s.author === 'scripted')).toBe(true);
    // After the open window, the next request that falls due goes to Claude once more (half-open).
    await room.clock.advance(60_000);
    for (let i = 0; i < 90 && room.claude.requests.length < 4; i++) await room.clock.advance(2000);
    expect(room.claude.requests).toHaveLength(4);
    expect(room.claude.last().request.context.request.reasons).toContain('handoff');
  });

  it('a failed half-open attempt re-opens the breaker at once', async () => {
    const room = await claudeRoom();
    for (let i = 0; i < 3; i++) {
      await room.clock.advance(1);
      room.claude.last().resolve({ status: 'failed', reason: 'api error', attempts: 1 });
      await room.clock.advance(6000);
    }
    await room.clock.advance(5 * 60_000);
    for (let i = 0; i < 90 && room.claude.requests.length < 4; i++) await room.clock.advance(2000);
    room.claude.last().resolve({ status: 'failed', reason: 'still down', attempts: 1 });
    await room.clock.advance(1);
    expect(room.conductor.snapshot().composer.state).toBe('failed');
    await room.clock.advance(4 * 60_000);
    expect(room.claude.requests).toHaveLength(4);
  });

  it('a plan against a schedule that changed underneath it fails with stale-context only when a rule breaks', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const req = room.claude.last();
    // Meanwhile a person commits a section without the pad part.
    const r = await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Sparse', parts: [part('kick')] })]) }, 'external');
    expect(r.accepted).toBe(true);
    const stale = await req.tools.commit(plan([section({ role: 'interlude', parts: [part('pad', { code: null })] })]));
    expect(stale.errors.map((e) => e.rule)).toEqual(['carry', 'stale-context']);
    expect(stale.errors[1]!.message).toMatch(/Sparse/);
    // A plan that still fits the new schedule is accepted despite the older rev.
    const fine = await room.claude.commit(plan([section({ role: 'interlude', parts: [part('kick', { code: null })] })]));
    expect(fine.accepted).toBe(true);
    expect(fine.sections[0]!.startCycle).toBe(r.sections[0]!.startCycle + 16);
  });

  it('corroborated client errors trigger a guardrail replan (codes only in the context)', async () => {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', bars: 64 })]), requestId: room.external.last().request.id }, 'external');
    const first = sectionsOf(room)[0]!;
    const errors = [{ sectionId: first.id, partId: 'pad', code: 'density' as const, clients: 3 }];
    room.crowd.corroboratedErrors = () => errors;
    const before = room.external.requests.length;
    for (let i = 0; i < 4; i++) await room.clock.advance(2000);
    expect(room.external.requests.length).toBe(before + 1);
    const ctx = room.external.last().request.context;
    expect(ctx.request.reasons).toContain('guardrail');
    expect(ctx.health.clientErrors).toEqual(errors);
    expect(ctx.health.notes.join(' ')).toMatch(/density/);
  });

  it('a movement past 12 minutes asks for a new movement unless the room is loving it', async () => {
    const room = await boot();
    room.crowd.listeners = 1;
    await room.clock.advance(13 * 60_000);
    const kinds = room.scripted.contexts.map((c) => c.request.kind);
    expect(kinds.at(-1)).toBe('movement');
    expect(room.scripted.contexts.at(-1)!.request.reasons).toContain('movement-age');
    expect(room.scripted.contexts.at(-1)!.expected.at(-1)!.notes.join(' ')).toMatch(/new movement/);
  });

  it('no Claude calls while nobody is audible: the autopilot keeps going and its rows are marked inaudible', async () => {
    const room = await claudeRoom();
    room.crowd.listeners = 0;
    await room.clock.advance(3 * 60_000);
    expect(room.claude.requests).toHaveLength(0);
    expect(sectionsOf(room).filter((s) => s.author === 'scripted').length).toBeGreaterThan(1);
    expect(room.conductor.snapshot().composer.state).toBe('paused');
    const rows = room.store.readJsonl<{ t: string; row?: { audible: number } }>(STORE_KEYS.ledger).filter((e) => e.t === 'row');
    expect(rows.every((e) => e.row!.audible === 0)).toBe(true);
    room.crowd.listeners = 2;
    await room.clock.advance(3 * 60_000);
    expect(room.claude.requests.length).toBeGreaterThan(0);
    expect(room.claude.requests[0]!.request.context.request.reasons).toContain('handoff');
  });

  it('the plans-per-hour budget hands over to the autopilot', async () => {
    const room = await boot({ config: { driver: 'claude', maxPlansPerHour: 1 } as never });
    await room.clock.advance(1);
    await room.claude.commit(plan([section({ role: 'bridge' })]));
    await room.clock.advance(3 * 60_000);
    expect(room.claude.requests).toHaveLength(1);
    expect(sectionsOf(room).some((s) => s.author === 'scripted' && s.index > 2)).toBe(true);
  });

  it('switching the driver aborts the request in flight', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const req = room.claude.last();
    const status = await room.conductor.setDriver('external');
    expect(req.signal.reason).toBe('driver-switch');
    expect(status.driver).toBe('external');
    await room.clock.advance(1);
    await room.clock.advance(2001);
    expect(room.external.requests.length).toBe(1);
    expect(room.external.last().request.context.request.reasons).toContain('handoff');
  });

  it('the trigger counts locked music only; a horizon request follows the provisional section without replacing it', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const first = room.claude.last();
    // Locked: boot (to bar 20) + 16 bars ≈ 72 s < 120 s; the provisional 64 bars don't count.
    const r = await room.claude.commit(plan([section({ role: 'bridge', name: 'Short' }), section({ role: 'interlude', name: 'Prov', bars: 64 })]));
    expect(r.accepted).toBe(true);
    await room.clock.advance(1);
    const next = room.claude.last();
    expect(next).not.toBe(first);
    expect(next.request.context.request).toMatchObject({ reasons: ['horizon'], replaces: [] });
    expect(next.request.targetCycle).toBeGreaterThanOrEqual(r.sections[1]!.startCycle + 64);
    expect(room.conductor.snapshot().composer.horizonSec).toBeLessThan(120);
  });

  it('a two-section plan: the second is provisional until its predecessor starts playing', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const r = await room.claude.commit(plan([section({ role: 'bridge', name: 'One', bars: 32 }), section({ role: 'interlude', name: 'Two', bars: 32 })]));
    expect(r.accepted).toBe(true);
    const [one, two] = r.sections;
    expect(sectionsOf(room).find((s) => s.id === two!.id)!.provisional).toBe(true);
    await room.clock.toCycle(one!.startCycle);
    const flipped = sectionsOf(room).find((s) => s.id === two!.id)!;
    expect(flipped).toMatchObject({ provisional: false, rev: 2 });
    expect(lastSchedule(room).upserts).toEqual([flipped]);
  });
});

describe('Stay and Move on in the room', () => {
  async function playing(bars = 32): Promise<Room> {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Floor', bars: bars as 32 })]), requestId: room.external.last().request.id }, 'external');
    const floor = tail(room);
    await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'Next', bars: 32, parts: [part('kick', { code: null }), part('pad', { code: 's("sine")' })] })]) }, 'external');
    await room.clock.toCycle(floor.startCycle + 1);
    return room;
  }

  it('Stay repeats a phrase, pushes the successor 8 bars and keeps its continuing parts in phase', async () => {
    const room = await playing();
    const [, floor, next] = sectionsOf(room);
    const originBefore = next!.parts.find((p) => p.id === 'kick')!.originCycle;
    room.crowd.queued.push([{ type: 'keep', direction: 1, sectionId: floor!.id }]);
    await room.clock.advance(2001);
    const [, floor2, next2] = sectionsOf(room);
    expect(floor2).toMatchObject({ id: floor!.id, jumps: [{ atBar: 24, toBar: 16 }], rev: floor!.rev + 1 });
    expect(next2).toMatchObject({ id: next!.id, startCycle: next!.startCycle + 8, rev: next!.rev + 1 });
    // The carried kick picks up at pattern bar 32 either way (the score still ends at bar 32).
    expect(next2!.parts.find((p) => p.id === 'kick')!.originCycle).toBe(originBefore + 8);
    expect(room.crowd.called('setKeepPending').at(-1)![0]).toMatchObject({ kind: 'extend', atCycle: floor!.startCycle + 24, blocked: null });
    expect(room.crowd.called('consumeKeep')).toHaveLength(1);
    expect(lastSchedule(room).upserts.map((s) => s.id)).toEqual([floor!.id, next!.id]);
    // Its tempo map moved too.
    const tl = lastSchedule(room).timeline;
    expect(msAtCycle(tl, next2!.startCycle) - msAtCycle(tl, floor!.startCycle)).toBe(40 * 2000);
  });

  it('a third Stay is refused as the limit (max), not as a lock', async () => {
    const room = await playing();
    const floor = sectionsOf(room)[1]!;
    for (let i = 0; i < 3; i++) {
      room.crowd.queued.push([{ type: 'keep', direction: 1, sectionId: floor.id }]);
      await room.clock.advance(2000);
    }
    expect(sectionsOf(room).find((s) => s.id === floor.id)!.jumps).toHaveLength(2);
    expect(room.crowd.called('consumeKeep')).toHaveLength(2);
    expect(room.crowd.called('setKeepPending').at(-1)![0]).toMatchObject({ kind: 'extend', blocked: 'max', atCycle: null });
  });

  it('a Stay that can no longer be made before the lock is refused and reported', async () => {
    const room = await playing(16);
    const floor = sectionsOf(room)[1]!;
    await room.clock.toCycle(floor.startCycle + 7);
    const rev = room.conductor.snapshot().rev;
    room.crowd.queued.push([{ type: 'keep', direction: 1, sectionId: floor.id }]);
    await room.clock.advance(2000);
    expect(room.crowd.called('setKeepPending').at(-1)![0]).toMatchObject({ kind: 'extend', blocked: 'locked', atCycle: null });
    expect(room.crowd.called('consumeKeep')).toHaveLength(0);
    expect(room.conductor.snapshot().rev).toBe(rev);
  });

  it('Move on with a successor jumps to the final phrase and pulls the successor in', async () => {
    const room = await playing();
    const [, floor, next] = sectionsOf(room);
    room.crowd.queued.push([{ type: 'keep', direction: -1, sectionId: floor!.id }]);
    await room.clock.advance(2001);
    const [, floor2, next2] = sectionsOf(room);
    expect(floor2!.jumps).toEqual([{ atBar: 8, toBar: 24 }]);
    expect(plannedPlayBars(floor2!)).toBe(16);
    expect(next2!.startCycle).toBe(next!.startCycle - 16);
  });

  it('Move on with nothing committed after asks for a plan with reason move-on', async () => {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    const first = room.external.last();
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Only', bars: 64 })]), requestId: first.request.id }, 'external');
    const only = tail(room);
    await room.clock.toCycle(only.startCycle + 1);
    const before = room.external.requests.length;
    room.crowd.queued.push([{ type: 'keep', direction: -1, sectionId: only.id }]);
    await room.clock.advance(2001);
    expect(tail(room).jumps).toEqual([{ atBar: 8, toBar: 56 }]);
    expect(room.external.requests.length).toBe(before + 1);
    const req = room.external.last();
    expect(req.request.context.request.reasons).toContain('move-on');
    expect(req.request.targetCycle).toBeGreaterThanOrEqual(only.startCycle + 16);
  });
});

describe('restart', () => {
  async function played() {
    const store = createMemoryStore();
    const wall = { now: 1_700_000_000_000 };
    const room = await boot({ store, wall, config: { driver: 'external' } as never });
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Long', bars: 64 })]), requestId: room.external.last().request.id }, 'external');
    await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'Longer', bars: 64, parts: [part('kick', { code: null }), part('pad')] })]) }, 'external');
    await room.clock.advance(40_000);
    await room.conductor.stop();
    const saved = store.readJson<PersistedSession>(STORE_KEYS.session)!;
    return { store, wall, room, saved };
  }

  it('warm-restores the same epoch after a quick restart, rebasing server time and re-checking programs', async () => {
    const { store, wall, room, saved } = await played();
    const cycleAtStop = room.clock.cycle();
    // A new process: a different server-clock basis, 5 s of downtime on the wall clock.
    const clock = createFakeClock(9_000_000);
    const downtime = 5_000;
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + downtime }, config: { driver: 'external' } as never });
    const checks = again.checker.calls.length;
    await again.conductor.start();
    const snap = again.conductor.snapshot();
    expect(snap.epoch).toBe('ep1');
    expect(snap.rev).toBeGreaterThan(saved.rev);
    expect(snap.sections.map((s) => s.id)).toEqual(saved.sections.slice(-3).map((s) => s.id));
    expect(again.checker.calls.length - checks).toBe(3);
    // The cycle continues where it would have been 5 s later.
    expect(cycleAtMs(snap.timeline, clock.now())).toBeCloseTo(cycleAtStop + downtime / 2000, 3);
    // No duplicate ledger rows for sections that already started.
    const rows = store.readJsonl<{ t: string; row?: { sectionId: string } }>(STORE_KEYS.ledger).filter((e) => e.t === 'row').map((e) => e.row!.sectionId);
    expect(new Set(rows).size).toBe(rows.length);
    // And it keeps playing: the next section starts on time.
    const next = snap.sections.find((s) => s.startCycle > cycleAtMs(snap.timeline, clock.now()))!;
    const started: string[] = [];
    again.conductor.on('started', (id) => started.push(id));
    await clock.toCycle(next.startCycle);
    expect(started).toEqual([next.id]);
  });

  it('a movement committed for later still opens with its note after a warm restore', async () => {
    const store = createMemoryStore();
    const wall = { now: 1_700_000_000_000 };
    const room = await boot({ store, wall, config: { driver: 'external' } as never });
    await room.clock.advance(1);
    const crate = room.external.last().request.context.novelty.crate.map((c) => c.id);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Long', bars: 64 })]), requestId: room.external.last().request.id }, 'external');
    const opening = plan([section({ role: 'intro', parts: crate.slice(0, 2).map((id, i) => part(`c${i}`, { role: 'perc', code: `s("${id}")` })) })], { movement: movement({ name: 'Later Side' }) });
    expect((await room.conductor.commit({ plan: opening }, 'scripted')).accepted).toBe(true);
    await room.clock.advance(10_000);
    await room.conductor.stop();
    const saved = store.readJson<PersistedSession>(STORE_KEYS.session)!;
    const clock = createFakeClock(9_000_000);
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 1000 }, config: { driver: 'external' } as never });
    await again.conductor.start();
    const later = again.conductor.snapshot().sections.at(-1)!;
    expect(later.movementId).toBe('ep1-m2');
    await clock.toCycle(later.startCycle);
    expect(again.broadcaster.of('note').find((n) => n.kind === 'movement')).toMatchObject({ text: 'Later Side: A slow tide.' });
  });

  it('drops a restored section that no longer validates (and everything after it)', async () => {
    const { store, wall, saved } = await played();
    const tampered = structuredClone(saved);
    tampered.sections.at(-1)!.parts[1]!.code = 's("triangle").BAD()';
    store.writeJson(STORE_KEYS.session, tampered);
    const clock = createFakeClock(9_000_000);
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 1000 }, config: { driver: 'external' } as never });
    await again.conductor.start();
    const ids = again.conductor.snapshot().sections.map((s) => s.id);
    expect(ids).not.toContain(tampered.sections.at(-1)!.id);
    expect(again.conductor.snapshot().epoch).toBe('ep1');
  });

  it('starts a new epoch after a long outage: cycles never go backwards, a scripted boot section plays', async () => {
    const { store, wall, saved } = await played();
    const clock = createFakeClock(9_000_000);
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 60 * 60_000 }, config: { driver: 'external' } as never, newEpoch: () => 'ep2' });
    await again.conductor.start();
    const snap = again.conductor.snapshot();
    expect(snap.epoch).toBe('ep2');
    expect(snap.sections).toHaveLength(1);
    expect(snap.sections[0]).toMatchObject({ id: 'ep2-0001', author: 'scripted' });
    const oldCycleNow = saved.lastCycle + (60 * 60_000 + (clock.now() - clock.now())) / 2000;
    expect(cycleAtMs(snap.timeline, clock.now())).toBeGreaterThanOrEqual(Math.ceil(oldCycleNow) + 8 - 1e-9);
    expect(snap.sections[0]!.startCycle).toBeGreaterThan(oldCycleNow);
  });
});

describe('autopilot resilience', () => {
  it('when the autopilot\'s own plan is refused, the tail is carried instead of left to vamp', async () => {
    const room = await boot({ config: { driver: 'scripted' } as never });
    const first = sectionsOf(room)[0]!;
    // From now on the library produces something the rules refuse (a tempo jump).
    room.scripted.make = () => plan([section({ bpm: 140 })]);
    await room.clock.advance(1);
    const carried = tail(room);
    expect(carried).not.toBe(first);
    expect(carried.author).toBe('scripted');
    expect(carried.parts.every((p) => p.continues && p.carried)).toBe(true);
    expect(carried.startCycle).toBe(first.startCycle + first.bars);
    expect(room.log.lines.some((l) => l.msg.includes('carrying the tail'))).toBe(true);
  });

  it('a boot plan that throws counts as a failed attempt; three failures stop start()', async () => {
    const room = createRoom();
    let calls = 0;
    room.scripted.make = () => {
      calls++;
      throw new Error('library broken');
    };
    await expect(room.conductor.start()).rejects.toThrow(/no boot section/);
    expect(calls).toBe(3);
  });
});
