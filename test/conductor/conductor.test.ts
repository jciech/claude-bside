import { describe, expect, it } from 'vitest';
import { cpsToBpm } from '../../src/shared/music.ts';
import { lockMs } from '../../src/shared/schedule.ts';
import { cycleAtMs, msAtCycle } from '../../src/shared/timeline.ts';
import { STORE_KEYS, type PersistedSession } from '../../src/server/types.ts';
import { bpmsAt, createRoom, lastSchedule, movement, part, plan, section, type Room } from './harness.ts';

async function boot(over: Parameters<typeof createRoom>[0] = {}): Promise<Room> {
  const room = createRoom({ config: { driver: 'external', ...(over.config ?? {}) } as never, ...over });
  await room.conductor.start();
  return room;
}

const sectionsOf = (room: Room) => room.conductor.snapshot().sections;
const tail = (room: Room) => sectionsOf(room).at(-1)!;

describe('boot', () => {
  it('commits a scripted section and opens a movement before start() resolves, whatever the driver', async () => {
    const room = createRoom({ config: { driver: 'claude' } as never });
    await room.conductor.start();
    const snap = room.conductor.snapshot();
    expect(snap.epoch).toBe('ep1');
    expect(snap.sections).toHaveLength(1);
    expect(snap.sections[0]).toMatchObject({ id: 'ep1-0001', author: 'scripted', movementId: 'ep1-m1', index: 1, track: 1, provisional: false });
    expect(snap.movements).toMatchObject([{ id: 'ep1-m1', side: 1, startCycle: snap.sections[0]!.startCycle }]);
    // It starts on a 4-bar line whose lock point is still ahead.
    expect(snap.sections[0]!.startCycle % 4).toBe(0);
    expect(lockMs(snap.timeline, snap.sections[0]!)).toBeGreaterThan(room.clock.now());
    expect(room.scripted.contexts[0]).toMatchObject({ request: { kind: 'movement', reasons: ['boot'] }, movement: null, now: null });
    expect(room.store.readJson<PersistedSession>(STORE_KEYS.session)).toMatchObject({ version: 1, epoch: 'ep1', sections: [{ id: 'ep1-0001' }] });
    expect(lastSchedule(room)).toMatchObject({ epoch: 'ep1', upserts: [{ id: 'ep1-0001' }], revokes: [] });
  });

  it('starts the section at its bar 0: crowd, ledger, notes, SSE', async () => {
    const room = await boot();
    const started: string[] = [];
    room.conductor.on('started', (id) => started.push(id));
    const first = sectionsOf(room)[0]!;
    await room.clock.toCycle(first.startCycle);
    expect(started).toEqual([first.id]);
    expect(room.crowd.called('sectionStarted')).toEqual([[{ id: first.id, startCycle: first.startCycle, bars: first.bars, role: first.role }]]);
    expect(room.crowd.called('markSectionPlaying')).toEqual([[first.id]]);
    const notes = room.broadcaster.of('note');
    expect(notes.map((n) => n.kind)).toEqual(['movement', 'section']);
    expect(notes[1]).toMatchObject({ sectionId: first.id, text: first.publicNote, cycle: first.startCycle, author: 'scripted' });
    expect(room.store.readJsonl<{ t: string; row: { sectionId: string } }>(STORE_KEYS.ledger)[0]).toMatchObject({ t: 'row', row: { sectionId: first.id, author: 'scripted', audible: 1 } });
    expect(room.conductor.snapshot().movements[0]!.tracks).toEqual([{ id: first.id, name: first.name, role: first.role, startCycle: first.startCycle, bars: first.bars }]);
  });
});

describe('commit pipeline', () => {
  it('rejects schema errors with paths, and cross-field errors before running the checker', async () => {
    const room = await boot();
    const calls = room.checker.calls.length;
    const bad = await room.conductor.commit({ plan: { sections: [] } as never }, 'external');
    expect(bad.accepted).toBe(false);
    expect(bad.errors[0]).toMatchObject({ rule: 'schema' });
    const carry = await room.conductor.commit({ plan: plan([section({ name: 'x <script>' })]) }, 'external');
    expect(carry.errors.map((e) => e.rule)).toEqual(['text']);
    expect(room.checker.calls.length).toBe(calls);
  });

  it('reports checker errors at plan paths and accepts clean plans with measured spans and digests', async () => {
    const room = await boot();
    const bad = await room.conductor.commit({ plan: plan([section({ role: 'bridge', parts: [part('kick'), part('pad', { code: 's("triangle").BAD()' })] })]) }, 'external');
    expect(bad.errors[0]).toMatchObject({ rule: 'unknown-method', path: 'sections[0].parts[1] (pad)' });
    const ok = await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Second' })]) }, 'external');
    expect(ok).toMatchObject({ accepted: true, errors: [], sections: [{ id: 'ep1-0002', name: 'Second', startCycle: tail(room).startCycle, bars: 16 }] });
    const program = tail(room);
    expect(program).toMatchObject({ author: 'external', index: 2, track: 2, measured: { intensity: { start: 0.5, end: 0.5 } } });
    expect(program.parts[0]!.digest).toMatchObject({ instrument: 'sbd' });
  });

  it('serialises concurrent commits: the second is checked and placed only after the first is applied', async () => {
    const room = await boot();
    room.checker.delayMs = 15;
    const order: string[] = [];
    const check = room.checker.checkSection.bind(room.checker);
    room.checker.checkSection = async (input, opts) => {
      order.push(`check:${input.parts[0]!.id}`);
      return check(input, opts);
    };
    room.conductor.on('section', (s) => order.push(`section:${s.parts[0]!.id}`));
    const [a, b] = await Promise.all([
      room.conductor.commit({ plan: plan([section({ role: 'bridge', parts: [part('aa', { code: 's("sine")' })] })]) }, 'external'),
      room.conductor.commit({ plan: plan([section({ role: 'interlude', parts: [part('bb', { code: 's("square")' })] })]) }, 'external'),
    ]);
    expect(a.accepted && b.accepted).toBe(true);
    expect(order).toEqual(['check:aa', 'section:aa', 'check:bb', 'section:bb']);
    expect(b.sections[0]!.startCycle).toBe(a.sections[0]!.startCycle + 16);
    const ids = sectionsOf(room).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a request-bound commit fulfils the pending request; afterwards its tools are closed', async () => {
    const room = await boot();
    await room.clock.advance(1);
    const req = room.external.last();
    expect(room.conductor.apiStatus().pending?.id).toBe(req.request.id);
    const r = await room.conductor.commit({ plan: plan([section({ role: 'bridge' })]), requestId: req.request.id }, 'external');
    expect(r.accepted).toBe(true);
    expect(req.signal.aborted).toBe(true);
    expect(req.signal.reason).toBe('fulfilled');
    const late = await req.tools.commit(plan([section({ role: 'bridge' })]));
    expect(late.errors[0]!.rule).toBe('request-closed');
  });

  it('applies request decisions to the crowd and answers them in the liner note at bar 0', async () => {
    const room = await boot();
    room.crowd.known.add('rq1');
    room.crowd.known.add('rq2');
    const r = await room.conductor.commit(
      {
        plan: plan([section({ role: 'bridge', publicNote: 'Jazz, as asked.' })], {
          requestDecisions: [
            { requestId: 'rq1', decision: 'this-plan', sectionIndex: 0, mergedInto: null, publicReply: 'Walking bass now.' },
            { requestId: 'rq2', decision: 'declined', sectionIndex: null, mergedInto: null, publicReply: 'Not this time.' },
          ],
        }),
      },
      'external',
    );
    const id = r.sections[0]!.id;
    expect(room.crowd.called('applyDecisions').at(-1)![0]).toEqual([
      { requestId: 'rq1', status: 'planned', publicReply: 'Walking bass now.', sectionId: id },
      { requestId: 'rq2', status: 'declined', publicReply: 'Not this time.', sectionId: null },
    ]);
    await room.clock.toCycle(r.sections[0]!.startCycle);
    expect(room.broadcaster.of('note').find((n) => n.sectionId === id && n.kind === 'section')).toMatchObject({ answering: ['rq1'], text: 'Jazz, as asked.' });
  });

  it('scripted commits get novelty and dramaturgy as warnings; the same plan from a person is refused', async () => {
    const room = await boot();
    const short = () => plan([section({ bars: 8, role: 'groove', name: 'Short' })]);
    const human = await room.conductor.commit({ plan: short() }, 'external');
    expect(human.accepted).toBe(false);
    expect(human.errors.map((e) => e.rule)).toContain('dramaturgy');
    const auto = await room.conductor.commit({ plan: short() }, 'scripted');
    expect(auto.accepted).toBe(true);
    expect(auto.warnings.find((w) => w.rule === 'dramaturgy')!.message).toMatch(/relaxed for the autopilot/);
  });

  it('a build that rises only through its automation lanes is accepted; a flat one is refused with a hint that works', async () => {
    const room = await boot();
    const lane = (target: string, from: number, to: number) => ({ target, fromBar: 0, toBar: 16, from, to, curve: 'exp' as const });
    const cut = { name: 'cut', default: 300, min: 200, max: 8000, follows: 'brightness' as const };
    const build = (parts: ReturnType<typeof part>[]) => plan([section({ role: 'build', name: 'Swell', parts })]);
    const flat = await room.conductor.commit({ plan: build([part('kick'), part('pad', { code: 's("sawtooth").lpf(knob("cut"))', knobs: [cut] })]) }, 'external');
    expect(flat.errors.map((e) => e.rule)).toEqual(['dramaturgy']);
    expect(flat.errors[0]!.hint).toMatch(/level lanes/);
    const swell = build([
      part('kick', { automation: [lane('level', 0.2, 1)] }),
      part('pad', { code: 's("sawtooth").lpf(knob("cut"))', knobs: [cut], automation: [lane('knob:cut', 300, 8000), lane('level', 0.1, 1)] }),
    ]);
    const r = await room.conductor.commit({ plan: swell }, 'external');
    expect(r.errors).toEqual([]);
    expect(r.accepted).toBe(true);
  });

  it('tempo rules bind the autopilot too', async () => {
    const room = await boot();
    const r = await room.conductor.commit({ plan: plan([section({ bpm: 130 })]) }, 'scripted');
    expect(r.accepted).toBe(false);
    expect(r.errors.map((e) => e.rule)).toContain('tempo');
  });

  it('a new movement: tempo within 12 BPM, a crate draw, a new side, and the movement note at its bar 0', async () => {
    const room = await boot();
    const crate = room.conductor.previewContext().novelty.crate.map((c) => c.id);
    const withCrate = (ids: string[]) => ids.map((id, i) => part(`c${i}`, { role: 'perc', code: `s("${id}")` }));
    const opening = plan([section({ role: 'intro', bpm: 128, tempoRampBars: 8, parts: withCrate(crate.slice(0, 2)) })], { movement: movement({ name: 'Side Two', bpm: 128 }) });
    // The first side is minutes old: too young to replace (for a person), fine for the autopilot.
    const human = await room.conductor.commit({ plan: opening }, 'external');
    expect(human.errors.map((e) => e.message).join(' ')).toMatch(/only 0 min old/);
    const r = await room.conductor.commit({ plan: opening }, 'scripted');
    expect(r.accepted).toBe(true);
    const snap = room.conductor.snapshot();
    expect(snap.movements.map((m) => [m.id, m.side, m.name])).toEqual([
      ['ep1-m1', 1, expect.any(String)],
      ['ep1-m2', 2, 'Side Two'],
    ]);
    const opened = tail(room);
    expect(opened).toMatchObject({ movementId: 'ep1-m2', track: 1 });
    expect(opened.tempo).toEqual({ fromBpm: 120, toBpm: 128, rampBars: 8, rampAt: 'start' });
    expect(bpmsAt(snap.timeline, [opened.startCycle - 1, opened.startCycle + 4, opened.startCycle + 8])).toEqual([120, 124, 128]);
    await room.clock.toCycle(opened.startCycle);
    expect(room.broadcaster.of('note').filter((n) => n.kind === 'movement').at(-1)).toMatchObject({ text: 'Side Two: A slow tide.', sectionId: opened.id });
  });

  it('a side revoked before it plays gives its number back: the replacement is the next side, not one after', async () => {
    const room = await boot();
    await room.clock.toCycle(sectionsOf(room)[0]!.startCycle + 1);
    const opening = (name: string, i: number) =>
      plan([section({ role: 'bridge', name: `Close ${i}` }), section({ role: 'intro', name, bpm: 124, tempoRampBars: 4 })], { movement: movement({ name, startsAtSection: 1, bpm: 124 }) });
    expect((await room.conductor.commit({ plan: opening('Side Two', 1) }, 'scripted')).accepted).toBe(true);
    expect(room.conductor.snapshot().movements.map((m) => [m.side, m.name])).toEqual([[1, expect.any(String)], [2, 'Side Two']]);
    // A --next commit replaces both unlocked sections, and with them the side they opened.
    const again = plan([section({ role: 'intro', name: 'Take Two', bpm: 124, tempoRampBars: 4 })], { movement: movement({ name: 'Take Two', bpm: 124 }) });
    expect((await room.conductor.commit({ plan: again, mode: 'next' }, 'scripted')).accepted).toBe(true);
    expect(room.conductor.snapshot().movements.map((m) => [m.side, m.name])).toEqual([[1, expect.any(String)], [2, 'Take Two']]);
  });

  it('a cut-in is checked against the tempo actually playing where it starts, not the section\'s end tempo', async () => {
    const room = await boot();
    // Ramp holds 120 BPM for 16 bars, then ramps into 124 by its end.
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Ramp', bars: 32, bpm: 124, tempoRampBars: 16, tempoRampAt: 'end' })]) }, 'external');
    const ramp = tail(room);
    await room.clock.toCycle(ramp.startCycle + 1);
    const cutIn = (tempoRampBars: number) => plan([section({ role: 'groove', name: 'Cut In', bpm: 124, tempoRampBars })]);
    const jump = await room.conductor.commit({ plan: cutIn(0), mode: 'next' }, 'external');
    expect(jump.accepted).toBe(false);
    expect(jump.errors).toContainEqual(expect.objectContaining({ rule: 'tempo', message: expect.stringMatching(/from 120\)/) }));
    const ramped = await room.conductor.commit({ plan: cutIn(4), mode: 'next' }, 'external');
    expect(ramped.accepted).toBe(true);
    expect(ramped.sections[0]!.startCycle).toBeLessThan(ramp.startCycle + 16);
  });

  it('a new movement must dig into its crate', async () => {
    const room = await boot();
    const r = await room.conductor.commit({ plan: plan([section({ role: 'intro', bpm: 124, tempoRampBars: 4 })], { movement: movement({ bpm: 124 }) }) }, 'scripted');
    expect(r.warnings.map((w) => w.rule)).toContain('crate');
  });

  it('next mode replaces every unlocked section; now mode cuts in as soon as the lock allows', async () => {
    const room = await boot();
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'B' })]) }, 'external');
    await room.conductor.commit({ plan: plan([section({ role: 'interlude', name: 'C' })]) }, 'external');
    expect(sectionsOf(room).map((s) => s.name)).toEqual([expect.any(String), 'B', 'C']);
    const first = sectionsOf(room)[0]!;
    await room.clock.toCycle(first.startCycle + 1);
    const r = await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'Now' })]), mode: 'now' }, 'external');
    expect(r.accepted).toBe(true);
    const update = lastSchedule(room);
    expect(update.revokes).toHaveLength(2);
    expect(update.upserts[0]).toMatchObject({ name: 'Now', transitionIn: { type: 'cut', bars: 0 } });
    const now = room.clock.now();
    expect(lockMs(update.timeline, update.upserts[0]!)).toBeGreaterThan(now);
    expect(r.warnings.map((w) => w.rule)).toContain('lead-time');
  });
});

describe('tempo map across revokes (design-review regressions)', () => {
  it('replacing a provisional section drops its tempo change; the replacement ramps from the tempo before it', async () => {
    const room = await boot({ config: { driver: 'external' } as never });
    await room.clock.advance(1);
    const first = room.external.last();
    // The locked part alone covers the horizon trigger, so the crowd replan is the next request.
    const two = plan([section({ role: 'bridge', name: 'Keep', bars: 48 }), section({ role: 'interlude', name: 'Prov', bars: 32, bpm: 124, tempoRampBars: 4 })]);
    const r = await room.conductor.commit({ plan: two, requestId: first.request.id }, 'external');
    expect(r.accepted).toBe(true);
    const prov = tail(room);
    expect(prov).toMatchObject({ name: 'Prov', provisional: true });
    expect(bpmsAt(room.conductor.snapshot().timeline, [prov.startCycle + 4])).toEqual([124]);
    // A crowd replan request replaces the provisional section.
    room.crowd.queued.push([{ type: 'replan-pressure', axis: 'intensity', pressure: 0.6 }]);
    const pending = room.external.requests.length;
    await room.clock.advance(1);
    await room.clock.advance(2001);
    const req = room.external.requests.at(-1)!;
    expect(room.external.requests.length).toBeGreaterThan(pending);
    expect(req.request.context.request.replaces).toEqual([prov.id]);
    expect(req.request.context.request.replacing).toEqual([
      {
        id: prov.id,
        name: 'Prov',
        role: 'interlude',
        startCycle: prov.startCycle,
        bars: 32,
        bpm: 124,
        scale: prov.scale,
        chords: prov.chords,
        parts: prov.parts.map((p) => ({ id: p.id, role: p.role, instrument: p.instrument })),
      },
    ]);
    expect(req.request.context.committed.map((s) => s.id)).not.toContain(prov.id);
    expect(req.request.context.request.reasons).toContain('crowd-pressure');
    const revokesBefore = room.broadcaster.of('schedule').flatMap((u) => u.revokes);
    expect(revokesBefore).toEqual([]);
    const res = await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'Slower', bpm: 118, tempoRampBars: 2 })]), requestId: req.request.id }, 'external');
    expect(res.accepted).toBe(true);
    const update = lastSchedule(room);
    expect(update.revokes).toEqual([prov.id]);
    expect(update.upserts.map((s) => s.name)).toEqual(['Slower']);
    const start = update.upserts[0]!.startCycle;
    expect(start).toBe(prov.startCycle);
    expect(bpmsAt(update.timeline, [start - 1, start + 1, start + 2, start + 10])).toEqual([120, 119, 118, 118]);
    expect(update.timeline.segments.some((s) => Math.round(cpsToBpm(s.cps)) === 124)).toBe(false);
  });
});

describe('turn context', () => {
  it('is plain JSON, token-lean, and carries memory, replaces, expectations, budgets and the crate', async () => {
    const room = await boot();
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'B' })], { motifs: [{ id: 'hook', role: 'lead', code: 'n("0 2 4")' }], rationale: 'Next: a build.' }) }, 'external');
    const ctx = room.conductor.previewContext();
    expect(JSON.parse(JSON.stringify(ctx))).toEqual(ctx);
    expect(JSON.stringify(ctx).length).toBeLessThan(12_000);
    expect(ctx.memory).toMatchObject({ lastRationale: 'Next: a build.', motifs: [{ id: 'hook', fromSectionId: 'ep1-0002' }] });
    expect(ctx.request).toMatchObject({ replaces: [], replacing: [], vamping: false, scheduleRev: room.conductor.snapshot().rev });
    expect(ctx.expected.length).toBeGreaterThanOrEqual(1);
    expect(ctx.rules.budget).toMatchObject({ peakSecAllowedNow: expect.any(Number), floorSecAllowedNow: expect.any(Number), lastRoles: expect.any(Array) });
    expect(ctx.novelty.crate).toHaveLength(16);
    expect(ctx.health.clientErrors).toEqual([]);
    expect(ctx.committed.map((s) => s.name)).toContain('B');
    const part0 = ctx.committed.at(-1)!.parts[0]!;
    expect(part0).toMatchObject({ code: expect.any(String), knobValuesAtEnd: {}, patternBarAtEnd: 16, instrument: 'sbd' });
    expect(ctx.movement).toMatchObject({ id: 'ep1-m1', baseline: { intensity: 0.5, brightness: 0.5 } });
  });
});

describe('crowd each bar', () => {
  it('ticks the crowd with the movement baseline, answers harsh consensus with a safety trim, and points the needle', async () => {
    const room = await boot();
    const ticks: unknown[][] = [];
    const tick = room.crowd.tick;
    room.crowd.tick = (...args) => {
      ticks.push(args);
      return tick(...args);
    };
    room.crowd.queued.push([{ type: 'harsh' }]);
    const at = room.clock.now();
    await room.clock.advance(1);
    expect(ticks[0]![2]).toEqual({ intensity: 0.5, brightness: 0.5 });
    const mixer = room.broadcaster.of('mixer').at(-1)!;
    expect(mixer.safety).toMatchObject({ masterDb: -3, highShelfDb: -3, untilCycle: mixer.safety!.fromCycle + 16 });
    expect(mixer.safety!.fromCycle).toBeGreaterThanOrEqual(cycleAtMs(room.conductor.snapshot().timeline, at + 4000));
    expect(room.broadcaster.of('note').at(-1)).toMatchObject({ kind: 'system', author: 'room' });
    const needle = room.conductor.needle();
    expect(Math.abs(needle.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(needle.y)).toBeLessThanOrEqual(1);
  });

  it('fast lane: the pull becomes a cycle-stamped keyframe at least MIN_CHANGE_LEAD ahead', async () => {
    const room = await boot();
    room.crowd.pullPoint = { x: 0.6, y: -0.3 };
    await room.clock.advance(2001);
    const m = room.broadcaster.of('mixer').at(-1)!;
    expect(m.next.macros).toEqual({ brightness: 0.6, intensity: -0.3 });
    const tl = room.conductor.snapshot().timeline;
    expect(msAtCycle(tl, m.next.atCycle)).toBeGreaterThanOrEqual(room.clock.now() + 4000);
    expect(m.next.rampBars).toBe(1);
  });

  it('balance trims travel with each section\'s own instances, so they hold from bar 0 whatever the pad does', async () => {
    const room = await boot();
    room.crowd.listeners = 5;
    const hats = (rms: number) => part('hats', { code: `s("white*8").gain(0.8) // rms${rms}` });
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', name: 'A', parts: [part('kick'), hats(-40)] })]) }, 'external');
    await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'B', parts: [part('kick', { code: null }), hats(-2)] })]) }, 'external');
    const [, a, b] = sectionsOf(room);
    expect(a!.parts.find((p) => p.id === 'hats')!.trimDb).toBe(3);
    expect(b!.parts.find((p) => p.id === 'hats')!.trimDb).toBe(-6);
    expect(a!.parts.find((p) => p.id === 'kick')!.trimDb).toBe(0);
    // The room keeps moving the pad across both starts; the fast lane carries macros only.
    for (let bar = 0; bar < b!.startCycle + 4; bar++) {
      room.crowd.pullPoint = { x: bar % 2 ? 0.3 : 0, y: 0 };
      await room.clock.advance(2000);
    }
    for (const m of room.broadcaster.of('mixer')) expect(Object.keys(m.next)).toEqual(['atCycle', 'rampBars', 'macros']);
  });
});

describe('forks', () => {
  it('opens a fork when allowed and closes it at its cycle, asking for a plan', async () => {
    const room = await boot();
    const fork = {
      prompt: 'Where next?',
      options: [
        { id: 'A' as const, label: 'Deeper', description: 'darker', kind: 'contrast' as const, requestId: null },
        { id: 'B' as const, label: 'Up', description: 'lift', kind: 'continue' as const, requestId: null },
      ],
      defaultOption: 'A' as const,
    };
    await room.clock.advance(1);
    await room.conductor.commit({ plan: plan([section({ role: 'bridge', bars: 48 })], { fork }), requestId: room.external.last().request.id }, 'external');
    const [opened] = room.crowd.called('openFork').at(-1)! as [{ id: string; closesAtCycle: number; opensAtCycle: number }];
    expect(opened.closesAtCycle - opened.opensAtCycle).toBeGreaterThanOrEqual(16);
    room.crowd.closeFork = () => ({ forkId: opened.id, option: 'B', label: 'Up', binding: true, turnout: 0.5, requestId: null });
    // A second fork is refused while one is open.
    const again = await room.conductor.commit({ plan: plan([section({ role: 'interlude' })], { fork }) }, 'external');
    expect(again.warnings.map((w) => w.rule)).toContain('fork');
    await room.clock.toCycle(opened.closesAtCycle);
    await room.clock.advance(1);
    const req = room.external.requests.at(-1)!;
    expect(req.request.context.request.reasons).toContain('fork-closed');
  });
});

