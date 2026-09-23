// The live room over socket.io (src/shared/protocol.ts): websocket transport only, `hello` on every
// (re)connect, `welcome` → engine snapshot + stores, schedule/mixer → engine, everything else →
// stores. It also owns the clock probes (the engine's ClockSync), the heartbeat, sampled telemetry
// and the listener's outgoing gestures.
import { io, type Socket } from 'socket.io-client';
import { CATALOG_URL } from '../../shared/catalog.ts';
import { HEARTBEAT_MS, RATE_LIMITS, type DockReaction } from '../../shared/music.ts';
import {
  CLIENT_VERSION,
  isConnectError,
  type ClientToServerEvents,
  type ConnectError,
  type Heartbeat,
  type NackReason,
  type PadPoint,
  type ServerToClientEvents,
} from '../../shared/protocol.ts';
import { startClockSync } from '../engine/clock-sync.ts';
import { createEngine } from '../engine/engine.ts';
import type { ClockSync, Engine, EngineOptions } from '../engine/types.ts';
import { ARRIVAL_SLACK_MS, TokenBucket } from '../ui/cooldown.ts';
import { quantizePad } from '../ui/pad.ts';
import { safeStorage } from '../ui/settings.ts';
import { applyScheduleUpdate, applySnapshotToStores, appendNote, pruneSections, recordEtch } from '../ui/stores.ts';
import { loadIdentity } from './identity.ts';
import type { RequestResult, Room, RoomOptions } from './types.ts';

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** ≤ 4 Hz while dragging (RATE_LIMITS.pad). */
export const PAD_INTERVAL_MS = 250;
/** Heartbeats triggered by a change are spaced at least this far apart (server bucket: 1/s). */
export const POKE_GAP_MS = 1100;
export const TELEMETRY_EVERY_BARS = 4;
const TICK_MS = 1000;
const CLOCK_PROBE_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 8000;
/** A clock probe issued before `welcome` waits this long for it, then fails (the server nacks early probes). */
const WELCOME_WAIT_MS = 2000;
const OFFLINE_AFTER_ERRORS = 3;
const RETRY_REFUSED_MS = 5000;
/** A hello refused for capacity is retried from RETRY_REFUSED_MS, doubling up to this (± a quarter, so a full room isn't hit in step). */
const RETRY_HELLO_MAX_MS = 30_000;
/** Refusals that mean the room (or this network's share of it) is at capacity, not a network fault. */
const FULL_ON_CONNECT: ReadonlySet<ConnectError> = new Set(['server-full', 'too-many-connections']);
const FULL_ON_HELLO: ReadonlySet<NackReason> = new Set(['room-full', 'too-many-tabs']);

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

export interface ConnectionDeps {
  socket: () => RoomSocket;
  createEngine: (options: EngineOptions) => Engine;
  startClockSync: (probe: () => Promise<number>) => ClockSync;
  storage: Storage | null;
  timers: Timers;
  /** Monotonic ms for throttles. */
  now: () => number;
  visible: () => boolean;
  /** Calls `listener` when the page's visibility changes; returns an unsubscribe. */
  onVisibility: (listener: () => void) => () => void;
}

const browserTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

function defaultDeps(): ConnectionDeps {
  return {
    socket: () => io({ transports: ['websocket'], reconnectionDelay: 1000, reconnectionDelayMax: 8000 }),
    createEngine,
    startClockSync,
    storage: safeStorage(),
    timers: browserTimers,
    now: () => performance.now(),
    visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibility: (listener) => {
      if (typeof document === 'undefined') return () => {};
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

const finiteOrNull = (v: number): number | null => (Number.isFinite(v) ? v : null);
const clampMs = (v: number): number => Math.min(60_000, Math.max(0, v));

export function connectRoom(options: RoomOptions, overrides: Partial<ConnectionDeps> = {}): Room {
  const deps: ConnectionDeps = { ...defaultDeps(), ...overrides };
  const { stores } = options;
  const { timers } = deps;
  const identity = loadIdentity(deps.storage);
  const socket = deps.socket();

  let welcomed = false;
  let everWelcomed = false;
  let resyncing = false;
  let telemetryOn = false;
  let clockReady = false;
  let connectErrors = 0;
  let lastBeatAt = Number.NEGATIVE_INFINITY;
  let pokeTimer: unknown = null;
  let lastTelemetryBlock: number | null = null;
  let padPending: { point: PadPoint; active: boolean } | null = null;
  let padTimer: unknown = null;
  let lastPadAt = Number.NEGATIVE_INFINITY;
  const padBucket = new TokenBucket(RATE_LIMITS.pad, deps.now());
  let retryTimer: unknown = null;
  let helloTimer: unknown = null;
  let helloBackoffMs = RETRY_REFUSED_MS;
  let hue: number | null = null;
  const welcomeWaiters = new Set<() => void>();

  const probe = async (): Promise<number> => {
    if (!welcomed) {
      await new Promise<void>((resolve) => {
        const done = () => {
          welcomeWaiters.delete(done);
          timers.clearTimeout(timer);
          resolve();
        };
        const timer = timers.setTimeout(done, WELCOME_WAIT_MS);
        welcomeWaiters.add(done);
      });
      // Measure on a fresh probe: this one's round trip included the wait.
      throw new Error('not in the room yet');
    }
    return socket.timeout(CLOCK_PROBE_TIMEOUT_MS).emitWithAck('clock');
  };
  const clock = deps.startClockSync(probe);
  void clock.ready.then(() => (clockReady = true));
  const engine = deps.createEngine({ catalogUrl: CATALOG_URL, clock });

  const hello = () => socket.emit('hello', { anonId: identity.anonId, token: identity.token(), clientVersion: CLIENT_VERSION });

  const resync = () => {
    if (resyncing || !socket.connected) return;
    resyncing = true;
    hello();
  };

  // The server keeps a refused socket connected without ever welcoming it: ask again later.
  const retryHello = () => {
    if (helloTimer !== null) return;
    const wait = helloBackoffMs * (0.75 + Math.random() / 2);
    helloBackoffMs = Math.min(RETRY_HELLO_MAX_MS, helloBackoffMs * 2);
    helloTimer = timers.setTimeout(() => {
      helloTimer = null;
      resync();
    }, wait);
  };

  const cancelHelloRetry = () => {
    if (helloTimer !== null) timers.clearTimeout(helloTimer);
    helloTimer = null;
    helloBackoffMs = RETRY_REFUSED_MS;
  };

  // ─── Heartbeat and telemetry ──────────────────────────────────────────────────────────────────

  const heartbeat = (): Heartbeat => {
    const running = engine.state === 'running';
    return {
      audible: running && options.volume() > 0,
      visible: deps.visible(),
      heardCycle: running ? finiteOrNull(engine.now()) : null,
      syncRttMs: clockReady ? clampMs(clock.rttMs()) : null,
      offsetJitterMs: clockReady ? clampMs(clock.jitterMs()) : null,
    };
  };

  const beat = () => {
    if (!welcomed) return;
    socket.emit('heartbeat', heartbeat());
    lastBeatAt = deps.now();
  };

  const poke = () => {
    if (!welcomed || pokeTimer !== null) return;
    const wait = lastBeatAt + POKE_GAP_MS - deps.now();
    if (wait <= 0) beat();
    else
      pokeTimer = timers.setTimeout(() => {
        pokeTimer = null;
        beat();
      }, wait);
  };

  const telemetry = () => {
    if (!telemetryOn || !welcomed || engine.state !== 'running') return;
    const block = Math.floor(engine.now() / TELEMETRY_EVERY_BARS);
    if (!Number.isFinite(block)) return;
    // The first block after starting is partial; report from the next boundary on.
    if (lastTelemetryBlock !== null && block > lastTelemetryBlock) socket.emit('telemetry', engine.telemetry());
    lastTelemetryBlock = block;
  };

  const tick = timers.setInterval(() => {
    if (welcomed && deps.now() - lastBeatAt >= HEARTBEAT_MS) beat();
    telemetry();
  }, TICK_MS);

  const offState = engine.on('state', poke);
  const offVisibility = deps.onVisibility(poke);
  const offResync = engine.onResyncNeeded(resync);

  // ─── Socket lifecycle ─────────────────────────────────────────────────────────────────────────

  socket.on('connect', () => {
    connectErrors = 0;
    resyncing = false;
    cancelHelloRetry();
    stores.connection.set(everWelcomed ? 'reconnecting' : 'connecting');
    hello();
  });

  socket.on('disconnect', () => {
    welcomed = false;
    cancelHelloRetry();
    stores.connection.set('reconnecting');
  });

  socket.on('connect_error', (err) => {
    connectErrors++;
    // Before the first welcome there is nothing playing to reconnect to: say the room is full.
    if (!everWelcomed && isConnectError(err.message) && FULL_ON_CONNECT.has(err.message)) stores.connection.set('full');
    else if (!everWelcomed || connectErrors >= OFFLINE_AFTER_ERRORS) stores.connection.set(connectErrors >= OFFLINE_AFTER_ERRORS ? 'offline' : 'connecting');
    // Refused by the server's admission caps: socket.io won't retry on its own.
    if (!socket.active && retryTimer === null) {
      retryTimer = timers.setTimeout(() => {
        retryTimer = null;
        socket.connect();
      }, RETRY_REFUSED_MS);
    }
  });

  socket.on('welcome', (s) => {
    identity.setToken(s.you.token);
    hue = s.you.hue;
    engine.applySnapshot({ epoch: s.epoch, rev: s.rev, timeline: s.timeline, sections: s.sections, mixer: s.mixer });
    applySnapshotToStores(stores, s);
    telemetryOn = s.telemetry;
    welcomed = true;
    resyncing = false;
    cancelHelloRetry();
    if (everWelcomed) clock.resync();
    everWelcomed = true;
    stores.connection.set('live');
    for (const wake of [...welcomeWaiters]) wake();
    beat();
  });

  socket.on('schedule', (update) => {
    engine.applySchedule(update);
    let gap = false;
    stores.schedule.update((state) => {
      const result = applyScheduleUpdate(state, update);
      gap = result.gap;
      if (result.stale) return state;
      return { ...result.state, sections: pruneSections(result.state.sections, engine.now()) };
    });
    if (gap) resync();
  });

  socket.on('mixer', (mixer) => {
    engine.setMixer(mixer);
    stores.mixer.set(mixer);
  });
  socket.on('crowd', (frame) => stores.crowd.set(frame));
  socket.on('fork', (fork) => stores.fork.set(fork));
  socket.on('note', (note) => stores.notes.update((notes) => appendNote(notes, note)));
  socket.on('requests', (cards) => stores.requests.set(cards));
  socket.on('composer', (status) => stores.composer.set(status));
  socket.on('nack', (nack) => {
    stores.nack.set({ ...nack, at: Date.now() });
    if (nack.event === 'hello') resyncing = false;
    if (nack.event === 'hello' && FULL_ON_HELLO.has(nack.reason)) {
      stores.connection.set('full');
      retryHello();
    }
  });

  // ─── Outgoing gestures ────────────────────────────────────────────────────────────────────────

  // Drag points are spaced PAD_INTERVAL_MS apart; a release skips the spacing, but every message
  // needs a token from the server's bucket, or fast tapping would get the final release refused.
  const flushPad = () => {
    padTimer = null;
    if (!padPending) return;
    const now = deps.now();
    const spacing = padPending.active ? lastPadAt + PAD_INTERVAL_MS - now : 0;
    const refill = padBucket.waitMs(now);
    const wait = Math.max(spacing, refill > 0 ? refill + ARRIVAL_SLACK_MS : 0);
    if (wait > 0) {
      padTimer = timers.setTimeout(flushPad, wait);
      return;
    }
    const { point, active } = padPending;
    padPending = null;
    if (!welcomed) return;
    padBucket.take(now);
    socket.emit('pad', { x: point.x, y: point.y, active });
    lastPadAt = now;
  };

  const actions = {
    pad(point: PadPoint, active: boolean) {
      padPending = { point: quantizePad(point), active };
      if (padTimer !== null) {
        if (active) return;
        timers.clearTimeout(padTimer);
      }
      flushPad();
    },

    keep(v: 1 | -1): boolean {
      const heardCycle = engine.now();
      const section = engine.sectionAt(heardCycle);
      if (!welcomed || !section || !Number.isFinite(heardCycle)) return false;
      socket.emit('keep', { v, sectionId: section.id, heardCycle });
      if (hue !== null) recordEtch(stores, { type: v > 0 ? 'stay' : 'move', cycle: heardCycle, hue });
      return true;
    },

    react(type: DockReaction): boolean {
      const heardCycle = engine.now();
      if (!welcomed || !Number.isFinite(heardCycle)) return false;
      socket.emit('react', { type, heardCycle });
      if (hue !== null) recordEtch(stores, { type, cycle: heardCycle, hue });
      return true;
    },

    async request(text: string): Promise<RequestResult> {
      const clean = text.trim();
      if (!clean) return { ok: false, error: 'empty' };
      if (!welcomed) return { ok: false, error: 'offline' };
      try {
        return await socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('request', { text: clean.slice(0, 280) });
      } catch {
        return { ok: false, error: 'timeout' };
      }
    },

    vote(forkId: string, option: 'A' | 'B' | 'C'): boolean {
      if (!welcomed) return false;
      socket.emit('vote', { forkId, option });
      return true;
    },

    poke,
  };

  return {
    engine,
    clock,
    stores,
    actions,
    mock: false,
    destroy() {
      timers.clearInterval(tick);
      for (const t of [pokeTimer, padTimer, retryTimer, helloTimer]) if (t !== null) timers.clearTimeout(t);
      offState();
      offVisibility();
      offResync();
      socket.disconnect();
      clock.stop();
      engine.suspend();
    },
  };
}
