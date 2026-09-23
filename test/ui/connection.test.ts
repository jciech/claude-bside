import { get } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectRoom, PAD_INTERVAL_MS, type RoomSocket } from '../../src/client/room/connection.ts';
import { loadIdentity } from '../../src/client/room/identity.ts';
import { createRoomStores } from '../../src/client/ui/stores.ts';
import { readSettings } from '../../src/client/ui/settings.ts';
import type { ClockSync, Engine, EngineState } from '../../src/client/engine/types.ts';
import { createBucket, take } from '../../src/server/room/buckets.ts';
import { quantizePad } from '../../src/client/ui/pad.ts';
import { HEARTBEAT_MS, RATE_LIMITS } from '../../src/shared/music.ts';
import { CLIENT_VERSION, HeartbeatSchema, HelloSchema, KeepSchema, PadSchema, ReactSchema, type RoomSnapshot } from '../../src/shared/protocol.ts';
import { sectionA, snapshot } from '../engine/fixtures.ts';

// The real engine needs Web Audio; the connection only talks to its public surface.
vi.mock('../../src/client/engine/engine.ts', () => ({ createEngine: () => null }));
vi.mock('../../src/client/engine/clock-sync.ts', () => ({ startClockSync: () => null }));

type Handler = (...args: any[]) => void;

class FakeSocket {
  connected = false;
  active = true;
  readonly handlers = new Map<string, Handler[]>();
  readonly sent: { event: string; payload: any; at: number }[] = [];
  readonly acks = new Map<string, (payload: any) => unknown>();
  on(event: string, fn: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
    return this;
  }
  emit(event: string, payload?: unknown) {
    this.sent.push({ event, payload, at: Date.now() });
    return this;
  }
  timeout(_ms: number) {
    return {
      emitWithAck: (event: string, payload?: unknown) => {
        this.sent.push({ event, payload, at: Date.now() });
        const reply = this.acks.get(event);
        return reply ? Promise.resolve(reply(payload)) : Promise.reject(new Error('timeout'));
      },
    };
  }
  connect() {
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
  open() {
    this.connected = true;
    this.fire('connect');
  }
  of(event: string) {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload);
  }
}

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

function fakeEngine() {
  const listeners = { state: new Set<(s: EngineState) => void>(), resync: new Set<() => void>() };
  const engine = {
    state: 'idle' as EngineState,
    cycle: 10.5,
    applySnapshot: vi.fn(),
    applySchedule: vi.fn(),
    setMixer: vi.fn(),
    suspend: vi.fn(),
    now: () => engine.cycle,
    sectionAt: (c: number) => (c >= 0 && c < 16 ? sectionA : null),
    telemetry: vi.fn(() => ({ cycle: engine.cycle, rmsDb: -20, peakDb: -6, centroidHz: 1000, clipPct: 0, errors: [], preloadFailed: [] })),
    on: (event: string, fn: (s: EngineState) => void) => {
      if (event !== 'state') return () => {};
      listeners.state.add(fn);
      return () => listeners.state.delete(fn);
    },
    onResyncNeeded: (fn: () => void) => {
      listeners.resync.add(fn);
      return () => listeners.resync.delete(fn);
    },
    setState(s: EngineState) {
      engine.state = s;
      for (const l of listeners.state) l(s);
    },
    needResync() {
      for (const l of listeners.resync) l();
    },
  };
  return engine;
}

function setup(opts: { volume?: number; storage?: Storage } = {}) {
  const socket = new FakeSocket();
  const engine = fakeEngine();
  let probe: (() => Promise<number>) | null = null;
  const clock = { ready: new Promise<void>(() => {}), rttMs: () => 20, jitterMs: () => 2, resync: vi.fn(), stop: vi.fn() };
  const stores = createRoomStores();
  const storage = opts.storage ?? new MemoryStorage();
  let visibility: (() => void) | null = null;
  const room = connectRoom(
    { stores, volume: () => opts.volume ?? 0.8 },
    {
      socket: () => socket as unknown as RoomSocket,
      createEngine: () => engine as unknown as Engine,
      startClockSync: (p) => {
        probe = p;
        return clock as unknown as ClockSync;
      },
      storage,
      now: () => Date.now(),
      visible: () => true,
      onVisibility: (l) => {
        visibility = l;
        return () => {};
      },
    },
  );
  return { socket, engine, clock, stores, storage, room, probe: () => probe!(), visibility: () => visibility?.() };
}

const welcome = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({ ...snapshot, you: { hue: 200, token: 'signed-token' }, ...over });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('room connection', () => {
  it('says hello on every (re)connect and applies the welcome', () => {
    const t = setup();
    t.socket.open();
    const hello = t.socket.of('hello')[0];
    expect(HelloSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({ token: null, clientVersion: CLIENT_VERSION });

    t.socket.fire('welcome', welcome());
    expect(t.engine.applySnapshot).toHaveBeenCalledWith(expect.objectContaining({ epoch: snapshot.epoch, rev: snapshot.rev, sections: snapshot.sections }));
    expect(get(t.stores.connection)).toBe('live');
    expect(get(t.stores.notes)).toHaveLength(1);
    expect(t.storage.getItem('bside.token')).toBe('signed-token');
    // The first heartbeat goes out with the welcome.
    expect(HeartbeatSchema.safeParse(t.socket.of('heartbeat')[0]).success).toBe(true);

    t.socket.fire('disconnect');
    expect(get(t.stores.connection)).toBe('reconnecting');
    t.socket.open();
    expect(t.socket.of('hello')).toHaveLength(2);
    expect(t.socket.of('hello')[1]).toMatchObject({ anonId: hello.anonId, token: 'signed-token' });
    t.socket.fire('welcome', welcome());
    expect(t.clock.resync).toHaveBeenCalledTimes(1);
  });

  it('resyncs with a fresh hello on a schedule gap or when the engine asks', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    t.socket.fire('schedule', { epoch: snapshot.epoch, rev: snapshot.rev + 5, timeline: snapshot.timeline, movements: snapshot.movements, upserts: [], revokes: [] });
    expect(t.engine.applySchedule).toHaveBeenCalled();
    expect(t.socket.of('hello')).toHaveLength(2);
    // Only one resync in flight until the welcome answers it.
    t.engine.needResync();
    expect(t.socket.of('hello')).toHaveLength(2);
    t.socket.fire('welcome', welcome());
    t.engine.needResync();
    expect(t.socket.of('hello')).toHaveLength(3);
  });

  it('routes room events to the engine and the stores', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    const mixer = { ...snapshot.mixer, rev: 9 };
    t.socket.fire('mixer', mixer);
    expect(t.engine.setMixer).toHaveBeenCalledWith(mixer);
    t.socket.fire('note', { id: 'n2', cycle: 16, kind: 'section', text: 'hi', sectionId: null, answering: [], author: 'claude' });
    expect(get(t.stores.notes).map((n) => n.id)).toEqual(['n1', 'n2']);
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    expect(get(t.stores.connection)).toBe('full');
  });

  it('a first connection refused for capacity says the room is full; other refusals keep trying', () => {
    const t = setup();
    t.socket.fire('connect_error', new Error('rate-limited'));
    expect(get(t.stores.connection)).toBe('connecting');
    t.socket.fire('connect_error', new Error('server-full'));
    expect(get(t.stores.connection)).toBe('full');
    t.socket.open();
    t.socket.fire('welcome', welcome());
    expect(get(t.stores.connection)).toBe('live');
    // Once the music is playing, a refused reconnect is a reconnect problem, not a full room.
    t.socket.fire('disconnect');
    t.socket.fire('connect_error', new Error('too-many-connections'));
    expect(get(t.stores.connection)).toBe('reconnecting');
  });

  it('a hello refused for capacity is retried with backoff until the room lets the listener in', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('nack', { event: 'hello', reason: 'too-many-tabs' });
    expect(get(t.stores.connection)).toBe('full');
    // Jittered: the first retry lands within 5 s (± a quarter), the next within 10 s.
    vi.advanceTimersByTime(6250);
    expect(t.socket.of('hello')).toHaveLength(2);
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    vi.advanceTimersByTime(3000);
    expect(t.socket.of('hello')).toHaveLength(2);
    vi.advanceTimersByTime(9500);
    expect(t.socket.of('hello')).toHaveLength(3);
    t.socket.fire('welcome', welcome());
    expect(get(t.stores.connection)).toBe('live');
    vi.advanceTimersByTime(10 * 60_000);
    expect(t.socket.of('hello')).toHaveLength(3);
  });

  it('a listener refused on reconnect keeps retrying and can steer again once back in', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    t.engine.setState('running');
    t.socket.fire('disconnect');
    t.socket.open();
    t.socket.fire('nack', { event: 'hello', reason: 'too-many-tabs' });
    expect(get(t.stores.connection)).toBe('full');
    expect(t.room.actions.keep(1)).toBe(false);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(40_000);
      t.socket.fire('nack', { event: 'hello', reason: 'too-many-tabs' });
    }
    // Backoff tops out at 30 s: every 40 s window holds exactly one more hello.
    expect(t.socket.of('hello')).toHaveLength(2 + 5);
    vi.advanceTimersByTime(40_000);
    t.socket.fire('welcome', welcome());
    expect(t.room.actions.keep(1)).toBe(true);
  });

  it('a pending hello retry is dropped on welcome, on disconnect and on destroy', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    t.socket.fire('welcome', welcome());
    vi.advanceTimersByTime(60_000);
    expect(t.socket.of('hello')).toHaveLength(1);
    expect(get(t.stores.connection)).toBe('live');
    t.socket.fire('disconnect');
    t.socket.open();
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    t.socket.fire('disconnect');
    vi.advanceTimersByTime(60_000);
    expect(t.socket.of('hello')).toHaveLength(2);
    // The reconnect says hello itself, and its own refusal starts the backoff again from 5 s.
    t.socket.open();
    expect(t.socket.of('hello')).toHaveLength(3);
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    vi.advanceTimersByTime(6250);
    expect(t.socket.of('hello')).toHaveLength(4);
    t.socket.fire('nack', { event: 'hello', reason: 'room-full' });
    t.room.destroy();
    vi.advanceTimersByTime(60_000);
    expect(t.socket.of('hello')).toHaveLength(4);
  });

  it('sends the pad at most 4 times a second while dragging, and always the release', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    for (let i = 0; i < 20; i++) {
      t.room.actions.pad({ x: i / 20, y: -i / 40 }, true);
      vi.advanceTimersByTime(50);
    }
    const during = t.socket.of('pad');
    expect(during.length).toBeGreaterThanOrEqual(3);
    expect(during.length).toBeLessThanOrEqual(1 + Math.ceil(1000 / PAD_INTERVAL_MS));
    t.room.actions.pad({ x: 0.9, y: -0.4 }, false);
    const all = t.socket.of('pad');
    expect(all.at(-1)).toEqual({ x: 0.9, y: -0.4, active: false });
    for (const p of all) expect(PadSchema.safeParse(p).success).toBe(true);
  });

  it('keeps fast taps on the pad within the server’s pad bucket, so the last release always counts', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    const joinedAt = Date.now();
    let spot = { x: 0, y: 0 };
    // A tap every 300 ms (held 100 ms), each somewhere new, for 6 s.
    for (let i = 0; i < 20; i++) {
      spot = { x: ((i * 7) % 20) / 10 - 1, y: ((i * 3) % 20) / 10 - 1 };
      t.room.actions.pad(spot, true);
      vi.advanceTimersByTime(100);
      t.room.actions.pad(spot, false);
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(2000);
    const pads = t.socket.sent.filter((s) => s.event === 'pad');
    const refused = (latency: (i: number) => number) => {
      const bucket = createBucket(RATE_LIMITS.pad, joinedAt);
      return pads.flatMap((p, i) => (take(bucket, RATE_LIMITS.pad, p.at + latency(i)) ? [] : [p.at - joinedAt]));
    };
    expect(refused(() => 0)).toEqual([]);
    // Even when the final release overtakes everything before it by 40 ms.
    expect(refused((i) => (i < pads.length - 1 ? 40 : 0))).toEqual([]);
    expect(pads.at(-1)!.payload).toEqual({ ...quantizePad(spot), active: false });
  });

  it('attributes Stay / Move on and reactions to what the listener heard', () => {
    const t = setup();
    expect(t.room.actions.keep(1)).toBe(false);
    t.socket.open();
    t.socket.fire('welcome', welcome());
    expect(t.room.actions.keep(-1)).toBe(true);
    const keep = t.socket.of('keep')[0];
    expect(KeepSchema.safeParse(keep).success).toBe(true);
    expect(keep).toEqual({ v: -1, sectionId: sectionA.id, heardCycle: 10.5 });
    expect(t.room.actions.react('fire')).toBe(true);
    expect(ReactSchema.safeParse(t.socket.of('react')[0]).success).toBe(true);
    expect(get(t.stores.etches).map((e) => e.type)).toEqual(['move', 'fire']);
    t.engine.cycle = 99;
    expect(t.room.actions.keep(1)).toBe(false);
  });

  it('sends requests with an ack', async () => {
    const t = setup();
    expect(await t.room.actions.request('more bells')).toEqual({ ok: false, error: 'offline' });
    t.socket.open();
    t.socket.fire('welcome', welcome());
    t.socket.acks.set('request', () => ({ ok: true, id: 'r1' }));
    expect(await t.room.actions.request('  more bells  ')).toEqual({ ok: true, id: 'r1' });
    expect(t.socket.of('request')[0]).toEqual({ text: 'more bells' });
    t.socket.acks.delete('request');
    expect(await t.room.actions.request('again')).toEqual({ ok: false, error: 'timeout' });
  });

  it('only probes the clock once the room has welcomed the listener', async () => {
    const t = setup();
    t.socket.acks.set('clock', () => 123_456);
    const early = t.probe();
    const settled = vi.fn();
    early.catch(settled);
    t.socket.open();
    t.socket.fire('welcome', welcome());
    await vi.runAllTimersAsync().catch(() => {});
    await Promise.resolve();
    expect(settled).toHaveBeenCalled();
    expect(t.socket.of('clock')).toHaveLength(0);
    expect(await t.probe()).toBe(123_456);
  });

  it('heartbeats every 10 s and when audibility changes', () => {
    const t = setup();
    t.socket.open();
    t.socket.fire('welcome', welcome());
    expect(t.socket.of('heartbeat')).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    t.engine.setState('running');
    vi.advanceTimersByTime(10);
    const beats = t.socket.of('heartbeat');
    expect(beats).toHaveLength(2);
    expect(beats[1]).toMatchObject({ audible: true, visible: true, heardCycle: 10.5 });
    vi.advanceTimersByTime(HEARTBEAT_MS + 1000);
    expect(t.socket.of('heartbeat').length).toBe(3);
  });

  it('reports telemetry every 4 bars, only when sampled', () => {
    const off = setup();
    off.socket.open();
    off.socket.fire('welcome', welcome({ telemetry: false }));
    off.engine.setState('running');
    for (let i = 0; i < 20; i++) {
      off.engine.cycle += 1;
      vi.advanceTimersByTime(1000);
    }
    expect(off.socket.of('telemetry')).toHaveLength(0);

    const on = setup();
    on.socket.open();
    on.socket.fire('welcome', welcome({ telemetry: true }));
    on.engine.setState('running');
    on.engine.cycle = 8.2;
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 12; i++) {
      on.engine.cycle += 1;
      vi.advanceTimersByTime(1000);
    }
    // Bars 8.2 → 20.2 cross the 12, 16 and 20 lines.
    expect(on.socket.of('telemetry')).toHaveLength(3);
  });
});

describe('listener identity and settings storage', () => {
  const broken = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;

  it('keeps a stable, schema-valid id and survives storage that throws', () => {
    const storage = new MemoryStorage();
    const a = loadIdentity(storage);
    expect(a.anonId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(loadIdentity(storage).anonId).toBe(a.anonId);
    const b = loadIdentity(broken);
    expect(b.anonId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    b.setToken('t');
    expect(b.token()).toBe('t');
  });

  it('reads defaults from missing or broken settings', () => {
    expect(readSettings(broken).volume).toBe(0.8);
    const s = new MemoryStorage();
    s.setItem('bside.settings.v1', '{"volume": 7, "calm": true, "shortcuts": false}');
    expect(readSettings(s)).toEqual({ volume: 1, calm: true, pauseVisuals: false, shortcuts: false });
    s.setItem('bside.settings.v1', 'not json');
    expect(readSettings(s).calm).toBeNull();
  });
});
