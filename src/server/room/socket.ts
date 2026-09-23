// The listener socket (src/shared/protocol.ts). Websocket transport only; hello → welcome, and only
// then does a socket join the 'live' broadcast room (in the same synchronous block, so it can't miss
// or pre-empt an update). Every payload is zod-validated and every handler wrapped: a malformed or
// hostile message costs a nack, never the process.
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Socket as EngineSocket } from 'engine.io';
import { Server, type Socket } from 'socket.io';
import { RATE_LIMITS } from '../../shared/music.ts';
import {
  CLIENT_EVENT_SCHEMAS,
  namesScheduledPart,
  type ClientToServerEvents,
  type ConnectError,
  type Nack,
  type NackReason,
  type RequestAck,
  type RoomSnapshot,
  type ServerToClientEvents,
  type Telemetry,
} from '../../shared/protocol.ts';
import { clientAddress } from '../http/security.ts';
import type { Broadcaster, Conductor, Crowd, EventArgs, JoinResult, Logger, RoomClock, ServerConfig, SnapshotBase } from '../types.ts';
import { createBucket, KeyedBuckets, take, type Rate } from './buckets.ts';
import { networkKey } from './identity.ts';

interface SocketData {
  address: string;
  network: string;
}

export type RoomServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type RoomSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export const LIVE_ROOM = 'live';
const listenerRoom = (listenerId: string) => `listener:${listenerId}`;

/** Largest client message we accept (telemetry is the biggest, ~2 KB). */
const MAX_MESSAGE_BYTES = 16 * 1024;
/** Hard ceiling on concurrent sockets, whatever their networks. */
const MAX_SOCKETS = 20_000;
/**
 * Engine.io connections beyond the socket caps, globally and per network: handshakes in flight and
 * refused clients retrying. Connections that never join the namespace count too.
 */
const ENGINE_SLACK = 8;
/** New connections per network. */
const CONNECT_RATE: Rate = { perSec: 1, burst: 30 };
/** Hellos per socket: the first and a few resyncs (each builds a whole welcome). */
const HELLO_RATE: Rate = { perSec: 0.2, burst: 3 };
/** All events from one socket; beyond it messages are dropped, and a persistent flood is disconnected. */
const FLOOD_RATE: Rate = { perSec: 20, burst: 80 };
const FLOOD_DISCONNECT_AFTER = 200;
/** The shared snapshot is rebuilt at least this often even if nothing was broadcast. */
const SNAPSHOT_MAX_AGE_MS = 1000;
const MAX_NOTES = 50;

type EventName = keyof typeof CLIENT_EVENT_SCHEMAS | 'clock';
const EVENTS: ReadonlySet<string> = new Set<EventName>([...(Object.keys(CLIENT_EVENT_SCHEMAS) as EventName[]), 'clock']);

/** Every broadcast that changes what a welcome would contain bumps the version of its server. */
const SNAPSHOT_EVENTS: ReadonlySet<keyof ServerToClientEvents> = new Set(['schedule', 'mixer', 'note', 'composer']);
const broadcastVersions = new WeakMap<object, { value: number }>();

function sameOrigin(req: IncomingMessage, trustProxy: number): boolean {
  const origin = req.headers.origin;
  // Non-browser clients send no Origin; browsers always do for websockets.
  if (!origin) return true;
  try {
    const { protocol, host } = new URL(origin);
    // Compare as URLs so a default port spelled out in Host (":443") still matches.
    const sameHost = (candidate: string | undefined) => Boolean(candidate) && new URL(`${protocol}//${candidate}`).host === host;
    const forwardedHost = trustProxy > 0 ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim() : undefined;
    return sameHost(req.headers.host) || sameHost(forwardedHost);
  } catch {
    return false;
  }
}

const networkOf = (req: IncomingMessage, config: ServerConfig) =>
  networkKey(clientAddress({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, config.trustProxy), config.ipv6Prefix);

/**
 * The socket.io server for the room: websocket only, small messages, no client bundle, and no
 * cross-site sockets (a foreign page must not be able to enrol its visitors as listeners).
 * Engine.io connections are counted per network from the handshake on: the admission middleware in
 * attachRoom only sees clients that join the namespace, and a silent one is held until connectTimeout.
 */
export function createRoomServer(http: HttpServer, config: ServerConfig): RoomServer {
  const held = new Map<string, number>();
  let total = 0;
  const io: RoomServer = new Server(http, {
    transports: ['websocket'],
    serveClient: false,
    maxHttpBufferSize: MAX_MESSAGE_BYTES,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    allowRequest: (req, callback) =>
      callback(
        null,
        sameOrigin(req, config.trustProxy) &&
          total < MAX_SOCKETS + ENGINE_SLACK &&
          (held.get(networkOf(req, config)) ?? 0) < config.maxSocketsPerNetwork + ENGINE_SLACK,
      ),
  });
  io.engine.on('connection', (conn: EngineSocket) => {
    const network = networkOf(conn.request, config);
    total++;
    held.set(network, (held.get(network) ?? 0) + 1);
    conn.once('close', () => {
      total--;
      const left = (held.get(network) ?? 1) - 1;
      if (left > 0) held.set(network, left);
      else held.delete(network);
    });
  });
  return io;
}

export function createBroadcaster(io: Server): Broadcaster {
  const version = { value: 0 };
  broadcastVersions.set(io, version);
  const send = (target: ReturnType<Server['to']>, event: string, args: unknown[]) =>
    (target.emit as (event: string, ...args: unknown[]) => boolean)(event, ...args);
  return {
    emit<E extends keyof ServerToClientEvents>(event: E, ...args: EventArgs<E>) {
      if (SNAPSHOT_EVENTS.has(event)) version.value++;
      send(io.to(LIVE_ROOM), event, args);
    },
    toListener<E extends keyof ServerToClientEvents>(listenerId: string, event: E, ...args: EventArgs<E>) {
      send(io.to(listenerRoom(listenerId)), event, args);
    },
  };
}

export interface RoomDeps {
  crowd: Crowd;
  conductor: Conductor;
  clock: RoomClock;
  config: ServerConfig;
  log: Logger;
}

/**
 * Wires the listener protocol onto `io`. Returns a function that removes the handlers and conductor
 * subscriptions (for teardown before io.close(); socket.io cannot remove the admission middleware).
 */
export function attachRoom(io: RoomServer, deps: RoomDeps): () => void {
  const { crowd, conductor, clock, config, log } = deps;
  const perNetwork = new Map<string, number>();
  const connectRates = new KeyedBuckets(CONNECT_RATE);
  let sockets = 0;

  // ─── The shared part of every welcome ─────────────────────────────────────────────────────────
  const broadcasts = () => broadcastVersions.get(io)?.value ?? 0;
  let conductorVersion = 0;
  let cached: { base: SnapshotBase; broadcasts: number; conductor: number; at: number } | null = null;
  const unsubscribe = (['request', 'status', 'section', 'revoke', 'started'] as const).map((event) =>
    conductor.on(event, () => void conductorVersion++),
  );

  function snapshotBase(t: number): SnapshotBase {
    if (cached && cached.broadcasts === broadcasts() && cached.conductor === conductorVersion && t - cached.at < SNAPSHOT_MAX_AGE_MS) {
      return cached.base;
    }
    const base = conductor.snapshot();
    cached = { base: { ...base, notes: base.notes.slice(-MAX_NOTES) }, broadcasts: broadcasts(), conductor: conductorVersion, at: t };
    return cached.base;
  }

  /** Client errors are kept only when they name the live schedule, so the crowd holds no ids the server didn't issue. */
  function liveErrors(errors: Telemetry['errors'], t: number): Telemetry['errors'] {
    if (!errors.length) return errors;
    const { sections } = snapshotBase(t);
    return errors.filter((e) => namesScheduledPart(sections, e));
  }

  function welcome(join: JoinResult, t: number): RoomSnapshot {
    const base = snapshotBase(t);
    return {
      epoch: base.epoch,
      rev: base.rev,
      serverTime: t,
      timeline: base.timeline,
      movements: base.movements,
      sections: base.sections,
      mixer: base.mixer,
      crowd: crowd.frame(clock.cycle(), conductor.needle()),
      fork: crowd.forkFor(join.listenerId),
      notes: base.notes,
      requests: crowd.requestCardsFor(join.listenerId),
      composer: base.composer,
      telemetry: join.telemetry,
      you: { hue: join.hue, token: join.token },
      sourceUrl: config.sourceUrl,
    };
  }

  // ─── Admission: caps before any listener state exists ─────────────────────────────────────────
  io.use((socket, next) => {
    const refuse = (message: ConnectError) => next(new Error(message));
    const address = clientAddress({ remoteAddress: socket.request.socket.remoteAddress, headers: socket.handshake.headers }, config.trustProxy);
    const network = networkKey(address, config.ipv6Prefix);
    if (sockets >= MAX_SOCKETS) return refuse('server-full');
    if ((perNetwork.get(network) ?? 0) >= config.maxSocketsPerNetwork) return refuse('too-many-connections');
    if (!connectRates.take(network, clock.now())) return refuse('rate-limited');
    socket.data = { address, network };
    sockets++;
    perNetwork.set(network, (perNetwork.get(network) ?? 0) + 1);
    // The transport's close fires even if the socket never finishes connecting.
    socket.conn.once('close', () => {
      sockets--;
      const left = (perNetwork.get(network) ?? 1) - 1;
      if (left > 0) perNetwork.set(network, left);
      else perNetwork.delete(network);
    });
    next();
  });

  const onConnection = (socket: RoomSocket) => {
    let listenerId: string | null = null;
    const flood = createBucket(FLOOD_RATE, clock.now());
    const hellos = createBucket(HELLO_RATE, clock.now());
    const clockProbes = createBucket(RATE_LIMITS.clock, clock.now());
    let dropped = 0;

    const nack = (event: string, reason: NackReason) => socket.emit('nack', { event: String(event).slice(0, 32), reason });
    const ackOf = <T>(args: unknown[]) => {
      const last = args[args.length - 1];
      return typeof last === 'function' ? (last as (res: T) => void) : null;
    };

    // Gate every incoming packet: flood control, unknown events, hello first.
    socket.use(([event, ...args], next) => {
      if (!take(flood, FLOOD_RATE, clock.now())) {
        if (++dropped === FLOOD_DISCONNECT_AFTER) {
          log.warn('disconnecting a flooding socket', { network: socket.data.network });
          socket.disconnect(true);
        }
        return;
      }
      if (typeof event !== 'string' || !EVENTS.has(event)) return nack(String(event), 'unknown-event');
      if (event !== 'hello' && listenerId === null) {
        if (event === 'request') ackOf<RequestAck>(args)?.({ ok: false, error: 'hello-first' });
        return nack(event, 'hello-first');
      }
      next();
    });

    const handle =
      (event: EventName, fn: (t: number, args: unknown[]) => void) =>
      (...args: unknown[]) => {
        try {
          fn(clock.now(), args);
        } catch (err) {
          log.error('socket handler failed', { event, err });
          nack(event, 'internal');
        }
      };

    /** Validates the first argument against the event's schema; nacks and returns undefined if invalid. */
    const parse = <E extends keyof typeof CLIENT_EVENT_SCHEMAS>(event: E, payload: unknown) => {
      const parsed = CLIENT_EVENT_SCHEMAS[event].safeParse(payload);
      if (parsed.success) return parsed.data as ReturnType<(typeof CLIENT_EVENT_SCHEMAS)[E]['parse']>;
      nack(event, 'invalid');
      return undefined;
    };

    const reply = (event: string, result: Nack | null) => {
      if (result) nack(result.event || event, result.reason);
    };

    socket.on(
      'hello',
      handle('hello', (t, [payload]) => {
        const hello = parse('hello', payload);
        if (!hello) return;
        if (!take(hellos, HELLO_RATE, t)) return nack('hello', 'rate-limited');
        // A repeated hello resyncs: the crowd keeps a socket's listener for the socket's lifetime.
        const joined = crowd.join(socket.id, hello, socket.data.address, t);
        if (!('listenerId' in joined)) return reply('hello', joined);
        const snapshot = welcome(joined, t);
        listenerId = joined.listenerId;
        socket.emit('welcome', snapshot);
        void socket.join([LIVE_ROOM, listenerRoom(joined.listenerId)]);
      }),
    );

    socket.on(
      'heartbeat',
      handle('heartbeat', (t, [payload]) => {
        const hb = parse('heartbeat', payload);
        if (hb) reply('heartbeat', crowd.heartbeat(socket.id, hb, t));
      }),
    );

    socket.on(
      'pad',
      handle('pad', (t, [payload]) => {
        const pad = parse('pad', payload);
        if (pad) reply('pad', crowd.pad(socket.id, pad, t));
      }),
    );

    socket.on(
      'keep',
      handle('keep', (t, [payload]) => {
        const keep = parse('keep', payload);
        if (keep) reply('keep', crowd.keep(socket.id, keep, clock.cycle(), t));
      }),
    );

    socket.on(
      'react',
      handle('react', (t, [payload]) => {
        const react = parse('react', payload);
        if (react) reply('react', crowd.react(socket.id, react, clock.cycle(), t));
      }),
    );

    socket.on(
      'request',
      handle('request', (t, args) => {
        const ack = ackOf<RequestAck>(args);
        const request = parse('request', args[0]);
        if (!request) return ack?.({ ok: false, error: 'invalid' });
        const result = crowd.request(socket.id, request, t);
        if (ack) ack(result);
        else if (!result.ok) nack('request', result.error);
      }),
    );

    socket.on(
      'vote',
      handle('vote', (t, [payload]) => {
        const vote = parse('vote', payload);
        if (vote) reply('vote', crowd.vote(socket.id, vote, t));
      }),
    );

    socket.on(
      'telemetry',
      handle('telemetry', (t, [payload]) => {
        const telemetry = parse('telemetry', payload);
        if (telemetry) reply('telemetry', crowd.telemetry(socket.id, { ...telemetry, errors: liveErrors(telemetry.errors, t) }, t));
      }),
    );

    socket.on(
      'clock',
      handle('clock', (t, args) => {
        const ack = ackOf<number>(args);
        if (!ack) return nack('clock', 'invalid');
        if (!take(clockProbes, RATE_LIMITS.clock, t)) return nack('clock', 'rate-limited');
        ack(clock.now());
      }),
    );

    socket.on('disconnect', () => {
      try {
        crowd.leave(socket.id, clock.now());
      } catch (err) {
        log.error('leave failed', { err });
      }
    });

    socket.on('error', (err) => log.debug('socket error', { err: err.message }));
  };

  io.on('connection', onConnection);

  return () => {
    io.off('connection', onConnection);
    for (const off of unsubscribe) off();
  };
}
