// Listener requests reach the composer only through a real composer's planning request: the
// autopilot, its fallbacks and `bside context` previews read the crowd summary without marking it.
import { describe, expect, it } from 'vitest';
import type { CrowdSummary } from '../../src/shared/composer-api.ts';
import { createCrowd } from '../../src/server/room/crowd.ts';
import { memoryStore, recordingBroadcaster, silentLog, testConfig } from '../room/sim.ts';
import { createFakeClock, createRoom, plan, section, type Room } from './harness.ts';

const REQUEST: CrowdSummary['requests'][number] = { id: 'rq1', text: 'more cowbell', support: 1, supporters: 1, ageSec: 30 };

async function boot(driver: 'claude' | 'external' | 'scripted', over: Parameters<typeof createRoom>[0] = {}): Promise<Room> {
  const room = createRoom({ config: { driver } as never, ...over });
  room.crowd.requests = [REQUEST];
  room.crowd.known.add(REQUEST.id);
  await room.conductor.start();
  return room;
}

describe('which turns count as the composer seeing requests', () => {
  it('a Claude planning request marks the requests in its context as shown', async () => {
    const room = await boot('claude');
    await room.clock.advance(1);
    expect(room.claude.last().request.context.crowd.requests.map((r) => r.id)).toEqual(['rq1']);
    expect(room.crowd.called('markShown')).toEqual([[['rq1']]]);
  });

  it('so does a request handed to the external driver', async () => {
    const room = await boot('external');
    await room.clock.advance(1);
    expect(room.external.requests).toHaveLength(1);
    expect(room.crowd.called('markShown')).toEqual([[['rq1']]]);
  });

  it('the autopilot, its fallbacks and previews never do', async () => {
    const room = await boot('scripted');
    await room.clock.advance(1);
    expect(room.scripted.contexts.at(-1)!.crowd.requests.map((r) => r.id)).toEqual(['rq1']);
    expect(room.conductor.previewContext().crowd.requests.map((r) => r.id)).toEqual(['rq1']);
    expect(room.crowd.called('markShown')).toEqual([]);
  });

  it('nor does Claude resting while nobody listens (the autopilot composes instead)', async () => {
    const room = createRoom({ config: { driver: 'claude' } as never });
    room.crowd.listeners = 0;
    room.crowd.requests = [REQUEST];
    await room.conductor.start();
    await room.clock.advance(1);
    expect(room.claude.requests).toHaveLength(0);
    expect(room.crowd.called('markShown')).toEqual([]);
  });

  it('a missed deadline lets the autopilot fill without marking anything again', async () => {
    const room = await boot('claude');
    await room.clock.advance(1);
    const req = room.claude.last();
    await room.clock.advance(req.request.hardDeadlineMs - room.clock.now() + 2001);
    expect(req.signal.reason).toBe('deadline');
    expect(room.crowd.called('markShown')).toHaveLength(1);
  });
});

describe('request lifecycle end to end (real crowd, real conductor)', () => {
  async function liveRoom(driver: 'claude' | 'scripted') {
    const clock = createFakeClock();
    const broadcaster = recordingBroadcaster();
    const crowd = createCrowd({ broadcaster, config: testConfig(), store: memoryStore(), log: silentLog, now: () => clock.now() });
    const sockets = ['s1', 's2'];
    const hb = () => sockets.forEach((s) => crowd.heartbeat(s, { audible: true, visible: true, heardCycle: null, syncRttMs: 10, offsetJitterMs: 1 }, clock.now()));
    const listenerIds = sockets.map((s, i) => {
      const joined = crowd.join(s, { anonId: `anon-0000000${i}`, token: null, clientVersion: '0.2.0' }, `10.0.${i}.1`, clock.now());
      if (!('listenerId' in joined)) throw new Error('join failed');
      return joined.listenerId;
    });
    hb();
    clock.set(clock.now() + 11_000);
    hb();
    const ids = ['more cowbell', 'a theremin'].map((text, i) => {
      const ack = crowd.request(sockets[i]!, { text }, clock.now());
      if (!ack.ok) throw new Error(`request refused: ${ack.error}`);
      return ack.id;
    });
    const room = createRoom({ clock, crowd, config: { driver } as never });
    await room.conductor.start();
    const status = (i: number) => crowd.requestCardsFor(listenerIds[i]!).find((c) => c.id === ids[i])!;
    return { room, broadcaster, ids, status, listenerId: listenerIds[0]! };
  }

  it('received → considered when Claude is asked → planned / declined → playing → played', async () => {
    const { room, broadcaster, ids, status, listenerId } = await liveRoom('claude');
    expect([status(0).status, status(1).status]).toEqual(['received', 'received']);
    room.conductor.previewContext();
    expect(status(0).status).toBe('received');

    await room.clock.advance(1);
    const req = room.claude.last();
    expect(req.request.context.crowd.requests.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect([status(0).status, status(1).status]).toEqual(['considered', 'considered']);
    expect(broadcaster.last('requests', listenerId)).toEqual(expect.arrayContaining([expect.objectContaining({ id: ids[0], status: 'considered' })]));

    const r = await room.claude.commit(
      plan([section({ role: 'bridge', name: 'Cowbell Bridge' })], {
        requestDecisions: [
          { requestId: ids[0]!, decision: 'this-plan', sectionIndex: 0, mergedInto: null, publicReply: 'Cowbell in the bridge.' },
          { requestId: ids[1]!, decision: 'declined', sectionIndex: null, mergedInto: null, publicReply: 'Not tonight.' },
        ],
      }),
    );
    expect(r.accepted).toBe(true);
    const bridge = r.sections[0]!;
    expect(status(0)).toMatchObject({ status: 'planned', sectionId: bridge.id, publicReply: 'Cowbell in the bridge.' });
    expect(status(1)).toMatchObject({ status: 'declined', publicReply: 'Not tonight.' });

    await room.clock.toCycle(bridge.startCycle);
    expect(status(0).status).toBe('playing');
    const next = await room.conductor.commit({ plan: plan([section({ role: 'groove', name: 'After The Bridge' })]) }, 'external');
    expect(next.accepted).toBe(true);
    await room.clock.toCycle(next.sections[0]!.startCycle);
    expect(status(0).status).toBe('played');
  });

  it('stays received while only the autopilot composes', async () => {
    const { room, status } = await liveRoom('scripted');
    await room.clock.advance(1);
    expect(room.scripted.contexts.length).toBeGreaterThan(1);
    expect([status(0).status, status(1).status]).toEqual(['received', 'received']);
  });
});
