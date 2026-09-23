// Boots the HTTP + socket layer in-process — real crowd, clock, broadcaster, security and API —
// around a fake conductor, and connects socket.io clients over websocket.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import type { ComposerApiStatus, CommitBody, DriverName, TurnContext } from '../../src/shared/composer-api.ts';
import { bpmToCps } from '../../src/shared/music.ts';
import type { ClientToServerEvents, RoomSnapshot, ServerToClientEvents } from '../../src/shared/protocol.ts';
import { createTimeline } from '../../src/shared/timeline.ts';
import { createHttpApp } from '../../src/server/http/app.ts';
import { createRoomClock, serverNow } from '../../src/server/room/clock.ts';
import { createCrowd } from '../../src/server/room/crowd.ts';
import { attachRoom, createBroadcaster, createRoomServer } from '../../src/server/room/socket.ts';
import type { Conductor, ConductorEvents, Logger, ServerConfig, SnapshotBase } from '../../src/server/types.ts';
import { memoryStore, testConfig } from '../room/sim.ts';

export type Client = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

export const fixture = JSON.parse(readFileSync(new URL('../fixtures/snapshot.json', import.meta.url), 'utf8')) as RoomSnapshot;

export interface FakeConductor extends Conductor {
  commits: { body: CommitBody; author: DriverName }[];
  plans: string[];
  fire<E extends keyof ConductorEvents>(event: E, ...args: Parameters<ConductorEvents[E]>): void;
  listenerCount(): number;
}

export function fakeConductor(now: () => number): FakeConductor {
  const listeners = new Map<keyof ConductorEvents, Set<(...args: unknown[]) => void>>();
  let driver: DriverName = 'scripted';
  const status = (): ComposerApiStatus => ({
    serverTime: now(),
    epoch: fixture.epoch,
    driver,
    pending: null,
    cycle: 0,
    bpm: 120,
    horizonSec: 90,
    now: null,
    committed: [],
  });
  const conductor: FakeConductor = {
    commits: [],
    plans: [],
    start: async () => {},
    stop: async () => {},
    snapshot: (): SnapshotBase => ({
      epoch: fixture.epoch,
      rev: fixture.rev,
      timeline: fixture.timeline,
      movements: fixture.movements,
      sections: fixture.sections,
      mixer: fixture.mixer,
      notes: fixture.notes,
      composer: fixture.composer,
    }),
    apiStatus: status,
    previewContext: () => ({ request: { id: 'preview' } }) as unknown as TurnContext,
    audition: async (input) => ({ ok: true, errors: [], warnings: [], parts: input.parts.map((p) => ({ id: p.id, role: p.role, ok: true, errors: [], warnings: [], analysis: null, digest: null })), mix: null, descriptors: null }),
    commit: async (body, author) => {
      conductor.commits.push({ body, author });
      return { accepted: true, errors: [], warnings: [], sections: [{ id: `${fixture.epoch}-0099`, name: body.plan.sections[0]!.name, startCycle: 64, bars: body.plan.sections[0]!.bars }] };
    },
    setDriver: async (d) => {
      driver = d;
      return status();
    },
    requestPlan: (reason) => void conductor.plans.push(reason),
    // Moves continuously, so every crowd frame differs from the last.
    needle: () => ({ x: Math.round(Math.sin(now() / 1000) * 1000) / 1000, y: 0 }),
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (...args: unknown[]) => void);
      listeners.set(event, set);
      return () => void set.delete(listener as (...args: unknown[]) => void);
    },
    fire(event, ...args) {
      for (const l of listeners.get(event) ?? []) l(...args);
    },
    listenerCount: () => [...listeners.values()].reduce((a, s) => a + s.size, 0),
  };
  return conductor;
}

export const quietLog: Logger & { errors: unknown[] } = {
  errors: [],
  debug() {},
  info() {},
  warn() {},
  error(msg, data) {
    quietLog.errors.push({ msg, ...data });
  },
};

export interface Room {
  url: string;
  config: ServerConfig;
  conductor: FakeConductor;
  crowd: ReturnType<typeof createCrowd>;
  broadcaster: ReturnType<typeof createBroadcaster>;
  /** Moves the room's clock forward (heartbeat staleness, warm-up, rate-limit refills). */
  skip(ms: number): void;
  connect(opts?: { headers?: Record<string, string> }): Promise<Client>;
  close(): Promise<void>;
}

export async function bootRoom(overrides: Partial<ServerConfig> = {}): Promise<Room> {
  const paletteDir = mkdtempSync(join(tmpdir(), 'bside-palette-'));
  mkdirSync(join(paletteDir, 'maps'));
  writeFileSync(join(paletteDir, 'catalog.json'), JSON.stringify({ version: 'test', maps: [] }));
  writeFileSync(join(paletteDir, 'maps', 'drums.json'), JSON.stringify({ _base: 'https://example.org/' }));
  writeFileSync(join(paletteDir, 'levels.json'), '{}');

  const config = testConfig(overrides);
  let offset = 0;
  const now = () => serverNow() + offset;
  const clock = createRoomClock({ timeline: createTimeline(now(), bpmToCps(120)), now });
  let handler: RequestListener = (_req, res) => void res.end();
  const httpServer = createServer((req, res) => handler(req, res));
  const io = createRoomServer(httpServer, config);
  const broadcaster = createBroadcaster(io);
  const crowd = createCrowd({ broadcaster, config, store: memoryStore(), log: quietLog, now });
  const conductor = fakeConductor(now);
  clock.start();
  crowd.start({ cycle: () => clock.cycle(), needle: () => conductor.needle() });
  const detach = attachRoom(io, { crowd, conductor, clock, config, log: quietLog });
  handler = createHttpApp({ conductor, crowd, clock, config, log: quietLog, reference: () => 'SYSTEM PROMPT', paletteDir, sseHeartbeatMs: 50 });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
  const clients: Client[] = [];

  return {
    url,
    config,
    conductor,
    crowd,
    broadcaster,
    skip: (ms) => void (offset += ms),
    connect(opts = {}) {
      const socket: Client = connectClient(url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: opts.headers });
      clients.push(socket);
      return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket));
        socket.once('connect_error', reject);
      });
    },
    async close() {
      for (const c of clients) c.disconnect();
      detach();
      crowd.stop();
      clock.stop();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      rmSync(paletteDir, { recursive: true, force: true });
    },
  };
}

/** Resolves with the next `event` (or rejects after `ms`). */
export function next<T = unknown>(socket: Client, event: string, ms = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      (socket as unknown as ClientSocket).off(event, on);
      reject(new Error(`no ${event} within ${ms} ms`));
    }, ms);
    const on = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    (socket as unknown as ClientSocket).once(event, on);
  });
}

/** Collects every `event` for `ms`. */
export async function collect<T = unknown>(socket: Client, event: string, ms: number): Promise<T[]> {
  const got: T[] = [];
  const on = (payload: T) => got.push(payload);
  (socket as unknown as ClientSocket).on(event, on);
  await new Promise((r) => setTimeout(r, ms));
  (socket as unknown as ClientSocket).off(event, on);
  return got;
}

export async function hello(socket: Client, anonId = `anon-${Math.random().toString(36).slice(2, 12)}`, token: string | null = null): Promise<RoomSnapshot> {
  const welcome = next<RoomSnapshot>(socket, 'welcome');
  socket.emit('hello', { anonId, token, clientVersion: '0.2.0' });
  return welcome;
}

export function ack<T>(socket: Client, event: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
    (socket as unknown as ClientSocket).emit(event, ...args, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}
