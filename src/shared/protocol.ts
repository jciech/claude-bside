// Socket.io protocol between the room server and listeners' browsers.
// Transport: websocket only (clock probes over long-polling are too noisy).
// Order: the client sends `hello` on every (re)connect; the server replies with `welcome` and only
// then adds the socket to the broadcast room. Other client events before hello are nacked.
// Every client→server payload is validated with these zod schemas before it touches state.
// All `*Ms` / `serverTime` fields are server clock: performance.timeOrigin + performance.now().
import { z } from 'zod';
import { DOCK_REACTIONS, PART_ID_PATTERN, type EtchType } from './music.ts';
import type { Timeline } from './timeline.ts';
import type { MixerState, MovementInfo, SectionProgram } from './program.ts';

// ─── Crowd state as seen by listeners ────────────────────────────────────────────────────────────

/** Pad coordinates: x = dark(-1)…bright(+1), y = calm(-1)…intense(+1). */
export interface PadPoint {
  x: number;
  y: number;
}

export interface KeepPending {
  kind: 'extend' | 'shorten';
  /** Bars the room has held this lean, and bars needed before it acts. */
  heldBars: number;
  needBars: number;
  /** Cycle where it will take effect, once decided. */
  atCycle: number | null;
  /** 'max': this section was already extended the maximum number of times. */
  blocked: null | 'min-length' | 'next-not-ready' | 'role' | 'locked' | 'max';
}

export interface CrowdFrame {
  cycle: number;
  listeners: number;
  /** Where the room collectively leans (smoothed aggregate of everyone's pads). */
  pull: PadPoint;
  /** Where the music is heading: current section's target at this bar + measured offset + fast lane. */
  needle: PadPoint;
  /** Fraction of listeners actively steering (0..1). */
  turnout: number;
  /** 1 = everyone agrees, 0 = scattered. */
  consensus: number;
  split: null | { axis: 'x' | 'y'; low: number; high: number };
  /** Keep (+1) vs move on (-1) for the current section, smoothed. */
  keep: number;
  keepPending: KeepPending | null;
  /** Up to 64 other listeners' pucks (anonymous, quantised), for the school of fish on the pad. */
  ghosts: { x: number; y: number; hue: number }[];
  /** Reactions of the last 16 bars, for etching into the record rim. */
  etches: { type: EtchType; cycle: number; hue: number }[];
  /** Requests waiting for a decision (count only; raw text is private). */
  requestsWaiting: number;
}

export type RequestStatus =
  | 'received'
  | 'considered'
  | 'planned'
  | 'next-movement'
  | 'fork-option'
  | 'merged'
  | 'declined'
  | 'playing'
  | 'played'
  | 'expired';

/**
 * A listener request. Raw text is only ever sent back to its author; everyone else sees the
 * composer's paraphrase (publicReply) once decided. All strings are plain text (src/shared/text.ts).
 */
export interface RequestCard {
  id: string;
  mine: boolean;
  /** Author's own (sanitised) text, only when mine; otherwise null. */
  text: string | null;
  status: RequestStatus;
  supporters: number;
  publicReply: string | null;
  sectionId: string | null;
  createdAt: number;
}

export interface ForkState {
  id: string;
  prompt: string;
  options: { id: 'A' | 'B' | 'C'; label: string; description: string; kind: string }[];
  opensAtCycle: number;
  closesAtCycle: number;
  /** Weighted shares per option id, 0..1. */
  tally: Record<string, number>;
  turnout: number;
  myVote: 'A' | 'B' | 'C' | null;
  result: null | { option: 'A' | 'B' | 'C'; binding: boolean };
  /** Once decided: which section realises it and when it lands. */
  resolvesForSectionId: string | null;
  landsAtCycle: number | null;
}

export type LinerNoteKind = 'section' | 'movement' | 'announce' | 'reply' | 'system';

/** Claude's (or the autopilot's) voice. Plain text only. */
export interface LinerNote {
  id: string;
  cycle: number;
  kind: LinerNoteKind;
  text: string;
  sectionId: string | null;
  /** Request ids this note answers. */
  answering: string[];
  author: 'claude' | 'external' | 'scripted' | 'room';
}

export interface ComposerStatus {
  driver: 'claude' | 'external' | 'scripted';
  state: 'idle' | 'planning' | 'waiting' | 'failed' | 'paused';
  /** Seconds of locked music ahead of now. */
  horizonSec: number;
  lastPlanAt: number | null;
  /** When the composer is expected to decide next ("Claude decides in ~40 s"). */
  nextDecisionAtMs: number | null;
  /** Plain-language status, e.g. "Claude is listening to the band vamp". */
  note: string | null;
}

/** Atomic schedule change. Clients ignore rev ≤ their current rev and resync on gaps. */
export interface ScheduleUpdate {
  epoch: string;
  rev: number;
  timeline: Timeline;
  /** Current and committed future movements (a new side can be committed before it starts). */
  movements: MovementInfo[];
  upserts: SectionProgram[];
  revokes: string[];
}

export interface RoomSnapshot {
  epoch: string;
  rev: number;
  serverTime: number;
  timeline: Timeline;
  movements: MovementInfo[];
  /** The section before the current one (for tails), the current one, and every committed one. */
  sections: SectionProgram[];
  mixer: MixerState;
  crowd: CrowdFrame;
  fork: ForkState | null;
  /** Newest last, at most 50. */
  notes: LinerNote[];
  /** This listener's own cards plus up to 20 public decided ones. */
  requests: RequestCard[];
  composer: ComposerStatus;
  /** This client should send audio telemetry (the server samples a subset). */
  telemetry: boolean;
  you: { hue: number; token: string };
  /** Public source URL (AGPL-3.0 §13). */
  sourceUrl: string;
}

// ─── Telemetry ──────────────────────────────────────────────────────────────────────────────────

/** Coded client-side failures. Never free text: telemetry reaches the composer (corroborated). */
export const TELEMETRY_ERROR_CODES = ['eval', 'query', 'density', 'sound-missing', 'preload', 'late-schedule', 'clip'] as const;
export type TelemetryErrorCode = (typeof TELEMETRY_ERROR_CODES)[number];

/**
 * A telemetry error names a section and a part by the ids the server issued ('' = none: the whole
 * section, or no section at all). The server keeps only errors naming its live schedule.
 */
const orNone = (id: z.ZodString) => z.union([z.literal(''), id]);

export const TelemetrySchema = z
  .object({
    cycle: z.number().refine(Number.isFinite),
    rmsDb: z.number().min(-120).max(12),
    peakDb: z.number().min(-120).max(12),
    centroidHz: z.number().min(0).max(24000),
    clipPct: z.number().min(0).max(100),
    errors: z
      .array(
        z
          .object({
            sectionId: orNone(z.string().regex(/^[A-Za-z0-9_-]{1,24}$/)),
            partId: orNone(z.string().regex(PART_ID_PATTERN)),
            code: z.enum(TELEMETRY_ERROR_CODES),
          })
          .strict(),
      )
      .max(8),
    preloadFailed: z.array(z.string().max(64)).max(8),
  })
  .strict();
export type Telemetry = z.infer<typeof TelemetrySchema>;

/** Whether a telemetry error names one of `sections` and one of its parts ('' = the whole section). */
export function namesScheduledPart(sections: readonly { id: string; parts: readonly { id: string }[] }[], e: { sectionId: string; partId: string }): boolean {
  const section = sections.find((s) => s.id === e.sectionId);
  return section !== undefined && (e.partId === '' || section.parts.some((p) => p.id === e.partId));
}

// ─── Client → server ────────────────────────────────────────────────────────────────────────────

const finite = z.number().refine(Number.isFinite, 'must be finite');
const padCoord = finite.pipe(z.number().min(-1).max(1));
const sectionId = z.string().max(24);

export const HelloSchema = z
  .object({
    anonId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    /** Token from a previous welcome (HMAC of anonId); invalid or missing = a new identity. */
    token: z.string().max(200).nullable(),
    clientVersion: z.string().max(32),
  })
  .strict();
export const HeartbeatSchema = z
  .object({
    audible: z.boolean(),
    visible: z.boolean(),
    heardCycle: finite.nullable(),
    syncRttMs: z.number().min(0).max(60000).nullable(),
    offsetJitterMs: z.number().min(0).max(60000).nullable(),
  })
  .strict();
export const PadSchema = z.object({ x: padCoord, y: padCoord, active: z.boolean() }).strict();
/** Latest ballot per listener per section wins; the server drops ballots for a section not audible at heardCycle. */
export const KeepSchema = z.object({ v: z.union([z.literal(1), z.literal(-1)]), sectionId, heardCycle: finite }).strict();
export const ReactSchema = z.object({ type: z.enum(DOCK_REACTIONS), heardCycle: finite }).strict();
export const RequestSchema = z.object({ text: z.string().min(1).max(280) }).strict();
export const VoteSchema = z.object({ forkId: z.string().max(32), option: z.enum(['A', 'B', 'C']) }).strict();

export type Hello = z.infer<typeof HelloSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type PadInput = z.infer<typeof PadSchema>;
export type KeepInput = z.infer<typeof KeepSchema>;
export type ReactInput = z.infer<typeof ReactSchema>;
export type RequestInput = z.infer<typeof RequestSchema>;
export type VoteInput = z.infer<typeof VoteSchema>;

/** heardCycle must lie in [serverCycle - 8, serverCycle + 1]; otherwise the input is nacked. */
export const HEARD_CYCLE_WINDOW = { behind: 8, ahead: 1 } as const;

// ─── Refusals ───────────────────────────────────────────────────────────────────────────────────

/** Why the server refused a client event (the `nack` payload's reason). */
export const NACK_REASONS = [
  // any event
  'unknown-event',
  'invalid',
  'internal',
  'hello-first',
  'rate-limited',
  // hello
  'room-full',
  'too-many-tabs',
  // keep, react, telemetry
  'heard-cycle',
  'wrong-section',
  'section-ended',
  'not-sampled',
  // vote
  'no-fork',
  'closed',
  'invalid-option',
  // a `request` sent without an ack is refused with a nack carrying its RequestError
  'empty',
  'too-early',
  'room-busy',
] as const;
export type NackReason = (typeof NACK_REASONS)[number];

export interface Nack {
  event: string;
  reason: NackReason;
}

/** Why a `request` was refused (its ack's `error`). */
export const REQUEST_ERRORS = ['hello-first', 'invalid', 'empty', 'too-early', 'rate-limited', 'room-busy'] as const satisfies readonly NackReason[];
export type RequestError = (typeof REQUEST_ERRORS)[number];
export type RequestAck = { ok: true; id: string } | { ok: false; error: RequestError };

/**
 * Admission refusals before any listener state exists: the `connect_error` message. A handshake over
 * the per-network connect rate is refused by engine.io itself, without a message.
 */
export const CONNECT_ERRORS = ['server-full', 'too-many-connections'] as const;
export type ConnectError = (typeof CONNECT_ERRORS)[number];

export const isConnectError = (message: string): message is ConnectError => (CONNECT_ERRORS as readonly string[]).includes(message);

export const CLIENT_EVENT_SCHEMAS = {
  hello: HelloSchema,
  heartbeat: HeartbeatSchema,
  pad: PadSchema,
  keep: KeepSchema,
  react: ReactSchema,
  request: RequestSchema,
  vote: VoteSchema,
  telemetry: TelemetrySchema,
} as const;

export interface ClientToServerEvents {
  hello: (payload: Hello) => void;
  heartbeat: (payload: Heartbeat) => void;
  pad: (payload: PadInput) => void;
  keep: (payload: KeepInput) => void;
  react: (payload: ReactInput) => void;
  request: (payload: RequestInput, ack: (res: RequestAck) => void) => void;
  vote: (payload: VoteInput) => void;
  telemetry: (payload: Telemetry) => void;
  /** NTP-style clock probe; the ack carries the server clock in ms. */
  clock: (ack: (serverMs: number) => void) => void;
}

// ─── Server → client ────────────────────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  /** Full state, in reply to hello (every connect and reconnect). */
  welcome: (snapshot: RoomSnapshot) => void;
  /** Atomic schedule change: timeline, movements, section upserts and revokes. */
  schedule: (update: ScheduleUpdate) => void;
  /** Fast-lane mixer keyframes (at most one per bar). */
  mixer: (mixer: MixerState) => void;
  /** Throttled (~4 Hz) crowd aggregate. */
  crowd: (frame: CrowdFrame) => void;
  /** Per listener (carries myVote). */
  fork: (fork: ForkState | null) => void;
  note: (note: LinerNote) => void;
  /** Per listener: own cards + public decided ones. */
  requests: (cards: RequestCard[]) => void;
  composer: (status: ComposerStatus) => void;
  /** Rate-limit or validation feedback for this client's last input. */
  nack: (payload: Nack) => void;
}

export const CLIENT_VERSION = '0.2.0';
