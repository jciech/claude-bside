import { describe, expect, it } from 'vitest';
import { cycleAtMs, msAtCycle } from '../../src/shared/timeline.ts';
import { plannedPlayBars } from '../../src/shared/schedule.ts';
import { STORE_KEYS, type PersistedSession } from '../../src/server/types.ts';
import { createMemoryStore } from '../../src/server/conductor/store.ts';
import type { SectionPlan } from '../../src/shared/plan.ts';
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

  it('after a build, a riser that no longer fits before its end is refused; a cut in its place lands on time', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const first = room.claude.last();
    expect((await room.claude.commit(plan([section({ role: 'build', bars: 32, name: 'Build', parts: [part('kick', { code: 's("sbd").rise()' })] })]))).accepted).toBe(true);
    const build = tail(room);
    expect(build.vamp.allowed).toBe(false);
    for (let i = 0; i < 64 && room.claude.last() === first; i++) await room.clock.advance(2000);
    const req = room.claude.last();
    expect(req.request.targetCycle).toBe(build.startCycle + 32);
    // 3 s before the soft deadline: in time for a cut, too late for an 8-bar riser.
    await room.clock.advance(req.request.softDeadlineMs - room.clock.now() - 3000);
    expect(req.signal.aborted).toBe(false);
    const drop = (transitionIn: SectionPlan['transitionIn']) =>
      plan([section({ role: 'drop', name: 'Drop', bars: 32, transitionIn, targets: { ...section().targets, tension: { start: 0.1, end: 0.2 } } })]);
    const riser = await req.tools.commit(drop({ type: 'riser', bars: 8 }));
    expect(riser.accepted).toBe(false);
    expect(riser.errors[0]).toMatchObject({ rule: 'lead-time', message: expect.stringMatching(/must not vamp.*at most 2 bars/) });
    expect(req.signal.aborted).toBe(false);
    const cut = await room.claude.commit(drop({ type: 'cut', bars: 0 }));
    expect(cut.accepted).toBe(true);
    expect(cut.sections[0]!.startCycle).toBe(build.startCycle + 32);
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

  it('a Claude failure too late to retry within its slot hands the slot to the autopilot instead of moving the deadline out', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    await room.claude.commit(plan([section({ role: 'bridge', name: 'Groove', bars: 32 })]));
    const groove = tail(room);
    const first = room.claude.requests.length;
    const failed = new Set<object>();
    let firstHard: number | null = null;
    // Every later request fails 45 s after it was issued, just inside its deadline.
    for (let i = 0; i < 60 && room.clock.cycle() < groove.startCycle + 40; i++) {
      for (const r of room.claude.requests.slice(first)) {
        firstHard ??= r.request.hardDeadlineMs;
        if (!failed.has(r) && room.clock.now() >= r.request.createdAt + 45_000) {
          failed.add(r);
          r.resolve({ status: 'failed', reason: 'api error', attempts: 1 });
        }
      }
      await room.clock.advance(2000);
    }
    expect(failed.size).toBeGreaterThan(0);
    const tl = room.conductor.snapshot().timeline;
    const next = sectionsOf(room).find((s) => s.startCycle > groove.startCycle)!;
    expect(next.author).toBe('scripted');
    expect(next.startCycle).toBeLessThanOrEqual(cycleAtMs(tl, firstHard!) + 4);
    expect(room.conductor.previewContext().health.notes.join(' ')).toMatch(/autopilot/);
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

  it('client errors that name no live section or part reach neither a guardrail nor the context', async () => {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', bars: 64 })]), requestId: room.external.last().request.id }, 'external');
    const first = sectionsOf(room)[0]!;
    const unknown = [
      { sectionId: 'IGNORE_PREVIOUS', partId: 'kick', code: 'eval' as const, clients: 2 },
      { sectionId: first.id, partId: 'lead', code: 'eval' as const, clients: 2 },
    ];
    room.crowd.corroboratedErrors = () => unknown;
    const before = room.external.requests.length;
    // Three guardrail ticks; nothing else asks for a plan in these bars.
    for (let i = 0; i < 12; i++) await room.clock.advance(2000);
    expect(room.external.requests.length).toBe(before);
    const known = { sectionId: first.id, partId: 'pad', code: 'density' as const, clients: 3 };
    room.crowd.corroboratedErrors = () => [...unknown, known];
    for (let i = 0; i < 4; i++) await room.clock.advance(2000);
    const ctx = room.external.last().request.context;
    expect(ctx.request.reasons).toContain('guardrail');
    expect(ctx.health.clientErrors).toEqual([known]);
    expect(ctx.health.notes.join(' ')).not.toMatch(/IGNORE|lead/);
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

  it('a crowd replan never revokes a section committed after the provisional one; that one stops being provisional', async () => {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const r = await room.claude.commit(plan([section({ role: 'bridge', name: 'Keep', bars: 32 }), section({ role: 'interlude', name: 'Prov', bars: 32 })]));
    const prov = r.sections[1]!;
    await room.clock.advance(2000);
    const second = room.claude.last();
    expect(second.request.context.request.replaces).toEqual([]);
    expect((await room.claude.commit(plan([section({ role: 'groove', name: 'After', bars: 32 })]))).accepted).toBe(true);
    expect(sectionsOf(room).find((s) => s.id === prov.id)).toMatchObject({ provisional: false, rev: 2 });
    expect(lastSchedule(room).upserts.map((s) => s.name)).toEqual(['Prov', 'After']);
    room.crowd.queued.push([{ type: 'replan-pressure', axis: 'intensity', pressure: 0.6 }]);
    for (let i = 0; i < 4; i++) await room.clock.advance(2000);
    for (const req of room.claude.requests.slice(room.claude.requests.indexOf(second) + 1)) expect(req.request.context.request.replaces).toEqual([]);
    expect(sectionsOf(room).map((s) => s.name).slice(-3)).toEqual(['Keep', 'Prov', 'After']);
  });

  async function provisionalTail(failAtCycle: number) {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const r = await room.claude.commit(plan([section({ role: 'bridge', name: 'Keep', bars: 16 }), section({ role: 'interlude', name: 'Prov', bars: 32 })]));
    await room.clock.advance(1);
    const horizon = room.claude.last();
    expect(horizon.request.context.request.reasons).toEqual(['horizon']);
    // The room leans while the horizon request is in flight.
    room.crowd.queued.push([{ type: 'replan-pressure', axis: 'intensity', pressure: 0.6 }]);
    await room.clock.toCycle(failAtCycle);
    horizon.resolve({ status: 'failed', reason: 'api error', attempts: 1 });
    // The retry after the failure carries the room's pressure while Prov is still replaceable.
    for (let i = 0; i < 4 && room.claude.last() === horizon; i++) await room.clock.advance(2000);
    const next = room.claude.last();
    expect(next).not.toBe(horizon);
    return { room, prov: r.sections[1]!, next };
  }

  it('a replan with less than the minimum compose time left is not issued; the pressure rides with the horizon request', async () => {
    // The retry comes at bar 19, 17 s before the replaced slot's deadline.
    const { next } = await provisionalTail(15);
    expect(next.request.context.request.replaces).toEqual([]);
    expect(next.request.context.request.reasons).toEqual(['horizon', 'crowd-pressure']);
  });

  it('a replan that misses its deadline is not a Claude failure: the provisional section stands', async () => {
    const { room, prov, next } = await provisionalTail(10);
    expect(next.request.context.request.replaces).toEqual([prov.id]);
    for (let i = 0; i < 20 && !next.signal.aborted; i++) await room.clock.advance(2000);
    expect(next.signal.reason).toBe('deadline');
    expect(sectionsOf(room).find((s) => s.id === prov.id)).toBeTruthy();
    expect(room.conductor.previewContext().health.notes.at(-1)).toMatch(/provisional section stands/);
    // One real failure before and one after: two in a row, not three.
    for (let i = 0; i < 10 && room.claude.last() === next; i++) await room.clock.advance(2000);
    room.claude.last().resolve({ status: 'failed', reason: 'api error', attempts: 1 });
    await room.clock.advance(1);
    expect(room.conductor.snapshot().composer.state).not.toBe('failed');
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

  /** Claude commits a 64-bar groove (reporting `composeMs` as its compose time), then the horizon request follows it. */
  async function grooveWithRequest(composeMs?: number): Promise<{ room: Room; groove: ReturnType<typeof tail>; req: Room['claude']['requests'][number] }> {
    const room = await claudeRoom();
    await room.clock.advance(1);
    const first = room.claude.last();
    const groovePlan = plan([section({ role: 'bridge', name: 'Groove', bars: 64 })]);
    if (composeMs === undefined) await room.claude.commit(groovePlan);
    else {
      const result = await first.tools.commit(groovePlan);
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1, ms: composeMs };
      first.resolve({ status: 'committed', result, attempts: 1, usage });
    }
    const groove = tail(room);
    for (let i = 0; i < 64 && room.claude.last() === first; i++) await room.clock.advance(2000);
    return { room, groove, req: room.claude.last() };
  }

  it('Move on with a request in flight moves its deadlines with the shortened section, so the autopilot fills soon after', async () => {
    const { room, groove, req } = await grooveWithRequest();
    const tl = () => room.conductor.snapshot().timeline;
    expect(req.request.hardDeadlineMs).toBe(msAtCycle(tl(), groove.startCycle + 64) - 15_000 + 16_000);
    room.crowd.queued.push([{ type: 'keep', direction: -1, sectionId: groove.id }]);
    await room.clock.advance(2001);
    const end = groove.startCycle + plannedPlayBars(sectionsOf(room).find((s) => s.id === groove.id)!);
    expect(end).toBeLessThan(groove.startCycle + 64);
    expect(req.request.hardDeadlineMs).toBe(msAtCycle(tl(), end) - 15_000 + 16_000);
    expect(room.conductor.apiStatus().pending?.hardDeadlineMs).toBe(req.request.hardDeadlineMs);
    // Claude never commits: the autopilot takes the slot one phrase after the new end, not 40 bars later.
    await room.clock.toCycle(end + 2);
    expect(req.signal.reason).toBe('deadline');
    const next = sectionsOf(room).find((s) => s.startCycle > groove.startCycle)!;
    expect(next.author).toBe('scripted');
    expect(next.startCycle).toBeLessThanOrEqual(end + 4);
  });

  it('a deadline the room pulled in with Move on is not a Claude failure when Claude misses it', async () => {
    // Claude usually takes 50 s; the Move on leaves this request about 37 s.
    const { room, groove, req } = await grooveWithRequest(50_000);
    room.crowd.queued.push([{ type: 'keep', direction: -1, sectionId: groove.id }]);
    await room.clock.advance(2001);
    const end = groove.startCycle + plannedPlayBars(sectionsOf(room).find((s) => s.id === groove.id)!);
    await room.clock.toCycle(end + 2);
    expect(req.signal.reason).toBe('deadline');
    const notes = () => room.conductor.previewContext().health.notes;
    expect(notes().at(-1)).toMatch(/moved on/);
    expect(notes().join(' ')).not.toMatch(/missed its deadline/);
    // Two real failures after it are two in a row, not three: the breaker stays closed.
    for (let i = 0; i < 2; i++) {
      const before = room.claude.last();
      for (let k = 0; k < 90 && room.claude.last() === before; k++) await room.clock.advance(2000);
      expect(room.claude.last()).not.toBe(before);
      room.claude.last().resolve({ status: 'failed', reason: 'api error', attempts: 1 });
      await room.clock.advance(1);
    }
    expect(room.conductor.snapshot().composer.state).not.toBe('failed');
    expect(notes().join(' ')).not.toMatch(/failed repeatedly/);
  });

  it('a deadline Stay moved out is still Claude’s to miss', async () => {
    const { room, groove, req } = await grooveWithRequest(50_000);
    room.crowd.queued.push([{ type: 'keep', direction: 1, sectionId: groove.id }]);
    await room.clock.advance(2001);
    for (let i = 0; i < 200 && !req.signal.aborted; i++) await room.clock.advance(2000);
    expect(req.signal.reason).toBe('deadline');
    const notes = () => room.conductor.previewContext().health.notes;
    expect(notes().at(-1)).toMatch(/missed its deadline/);
    for (let i = 0; i < 2; i++) {
      const before = room.claude.last();
      for (let k = 0; k < 90 && room.claude.last() === before; k++) await room.clock.advance(2000);
      room.claude.last().resolve({ status: 'failed', reason: 'api error', attempts: 1 });
      await room.clock.advance(1);
    }
    expect(room.conductor.snapshot().composer.state).toBe('failed');
  });

  it('Stay with a request in flight gives the composer the extra phrase too', async () => {
    const { room, groove, req } = await grooveWithRequest();
    const hard = req.request.hardDeadlineMs;
    room.crowd.queued.push([{ type: 'keep', direction: 1, sectionId: groove.id }]);
    await room.clock.advance(2001);
    expect(req.request.hardDeadlineMs).toBe(hard + 8 * 2000);
    await room.clock.advance(hard - room.clock.now() + 2001);
    expect(req.signal.aborted).toBe(false);
    expect((await room.claude.commit(plan([section({ role: 'interlude', name: 'In Time' })]))).accepted).toBe(true);
  });

  it('a move-on already answered by the plan in flight does not replan the new provisional section', async () => {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Only', bars: 64 })]), requestId: room.external.last().request.id }, 'external');
    const only = tail(room);
    await room.clock.toCycle(only.startCycle + 20);
    const inflight = room.external.last();
    expect(inflight.signal.aborted).toBe(false);
    room.crowd.queued.push([{ type: 'keep', direction: -1, sectionId: only.id }]);
    await room.clock.advance(2001);
    expect(tail(room).jumps).toHaveLength(1);
    // The request in flight lands and gives the shortened section its successor.
    const r = await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'A', bars: 32 }), section({ role: 'interlude', name: 'B', bars: 32 })]), requestId: inflight.request.id }, 'external');
    expect(r.accepted).toBe(true);
    await room.clock.advance(2001);
    const later = room.external.requests.slice(room.external.requests.indexOf(inflight) + 1);
    for (const x of later) {
      expect(x.request.context.request.reasons).not.toContain('move-on');
      expect(x.request.context.request.replaces).toEqual([]);
    }
    expect(sectionsOf(room).map((s) => s.name)).toContain('B');
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

  /** A room that played a swept pad into a section carrying it (a continuing kick, fresh hats fading in), then stopped. */
  async function playedCarried() {
    const store = createMemoryStore();
    const wall = { now: 1_700_000_000_000 };
    const room = createRoom({ store, wall, config: { driver: 'external' } as never });
    const cut = { name: 'cut', default: 400, min: 200, max: 4000, follows: 'none' as const };
    const pad = part('pad', { code: 's("triangle").lpf(knob("cut"))', knobs: [cut], automation: [{ target: 'knob:cut', fromBar: 0, toBar: 16, from: 400, to: 4000, curve: 'linear' }] });
    room.scripted.make = () => plan([section({ name: 'First Light', parts: [part('kick'), pad] })], { movement: movement() });
    await room.conductor.start();
    const hats = part('hats', { code: 's("white*8")', level: 0, automation: [{ target: 'level', fromBar: 4, toBar: 12, from: 0, to: 0.8, curve: 'linear' }] });
    const r = await room.conductor.commit({ plan: plan([section({ name: 'Glass', parts: [part('kick', { code: null }), part('pad', { code: null }), hats] })]) }, 'external');
    expect(r.accepted).toBe(true);
    const commitInput = room.checker.calls.at(-1)!;
    await room.clock.advance(1_000);
    await room.conductor.stop();
    const saved = store.readJson<PersistedSession>(STORE_KEYS.session)!;
    const restart = (session: PersistedSession) => {
      store.writeJson(STORE_KEYS.session, session);
      return createRoom({ store, clock: createFakeClock(9_000_000), wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 1000 }, config: { driver: 'external' } as never });
    };
    return { saved, commitInput, restart };
  }

  it('re-checks a restored section with the inputs its commit was checked with', async () => {
    const { saved, commitInput, restart } = await playedCarried();
    const again = restart(saved);
    await again.conductor.start();
    const glass = again.conductor.snapshot().sections.find((s) => s.name === 'Glass')!;
    expect(glass).toBeDefined();
    const restoreInput = again.checker.calls.find((input) => input.parts.some((p) => p.id === 'hats'))!;
    expect(restoreInput).toEqual(commitInput);
  });

  it('writes carried knob values into sections saved before programs held them', async () => {
    const { saved, restart } = await playedCarried();
    const glass = saved.sections.find((s) => s.name === 'Glass')!;
    expect(glass.parts.find((p) => p.id === 'pad')!.knobs[0]!.default).toBe(4000);
    // An older build saved the declared default and left the carried value to its clients.
    const legacy = structuredClone(saved);
    legacy.sections.find((s) => s.id === glass.id)!.parts.find((p) => p.id === 'pad')!.knobs[0]!.default = 400;
    const again = restart(legacy);
    await again.conductor.start();
    const restored = again.conductor.snapshot().sections.find((s) => s.id === glass.id)!;
    expect(restored.parts.find((p) => p.id === 'pad')!.knobs[0]!.default).toBe(4000);
    expect(restored.rev).toBe(glass.rev + 1);
    const unchanged = restart(saved);
    await unchanged.conductor.start();
    expect(unchanged.conductor.snapshot().sections.find((s) => s.id === glass.id)!.rev).toBe(glass.rev);
  });

  it('gives a continuing part of a section saved without trims its predecessor\'s trim', async () => {
    const { saved, restart } = await playedCarried();
    const legacy = structuredClone(saved);
    const [boot, glass] = legacy.sections;
    boot!.parts.find((p) => p.id === 'kick')!.trimDb = 2.5;
    for (const p of glass!.parts) delete (p as { trimDb?: number }).trimDb;
    const again = restart(legacy);
    await again.conductor.start();
    const restored = again.conductor.snapshot().sections.find((s) => s.id === glass!.id)!;
    expect(Object.fromEntries(restored.parts.map((p) => [p.id, p.trimDb]))).toEqual({ kick: 2.5, pad: 0, hats: 0 });
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

  type Entry = { t: 'row'; row: { sectionId: string; startedAtWallMs: number } } | { t: 'close'; sectionId: string; endedAtWallMs: number };
  const ledgerRows = (store: ReturnType<typeof createMemoryStore>) => {
    const out = new Map<string, { started: number; ended: number | null }>();
    for (const e of store.readJsonl<Entry>(STORE_KEYS.ledger)) {
      if (e.t === 'row') out.set(e.row.sectionId, { started: e.row.startedAtWallMs, ended: null });
      else if (out.get(e.sectionId)?.ended === null) out.get(e.sectionId)!.ended = e.endedAtWallMs;
    }
    return out;
  };

  it('a cold restart closes the ledger row of the section that was playing when it stopped', async () => {
    const { store, wall, saved } = await played();
    expect([...ledgerRows(store).values()].filter((r) => r.ended === null)).toHaveLength(1);
    const clock = createFakeClock(9_000_000);
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 60 * 60_000 }, config: { driver: 'external' } as never, newEpoch: () => 'ep2' });
    await again.conductor.start();
    const rows = ledgerRows(store);
    const old = [...rows].filter(([id]) => id.startsWith('ep1-'));
    expect(old.length).toBeGreaterThan(0);
    for (const [, r] of old) expect(r.ended).not.toBeNull();
    expect(Math.max(...old.map(([, r]) => r.ended!))).toBeLessThanOrEqual(saved.savedAtWallMs);
  });

  it('a warm restore records the sections that started during the downtime and closes the one before them', async () => {
    const { store, wall, saved } = await played();
    const [, long, longer] = saved.sections;
    expect(ledgerRows(store).has(longer!.id)).toBe(false);
    // Down long enough for Longer to have started (at cycle 84; the stop was just after 20).
    const clock = createFakeClock(9_000_000);
    const again = createRoom({ store, clock, wall: { now: wall.now + (saved.savedAtServerMs - 1_000_000) + 132_000 }, config: { driver: 'external' } as never });
    await again.conductor.start();
    expect(again.conductor.snapshot().epoch).toBe('ep1');
    const rows = ledgerRows(store);
    const startedAt = saved.savedAtWallMs + (msAtCycle(saved.timeline, longer!.startCycle) - saved.savedAtServerMs);
    expect(rows.get(longer!.id)).toEqual({ started: startedAt, ended: null });
    expect(rows.get(long!.id)!.ended).toBe(startedAt);
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
