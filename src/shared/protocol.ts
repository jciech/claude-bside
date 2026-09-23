// Socket.io protocol between the room server and listeners' browsers.
// Every client→server payload is validated with these zod schemas before it touches state.
import { z } from 'zod';
import { REACTIONS, type Reaction } from './music.ts';
import type { Timeline } from './timeline.ts';
import type { MixerState, MovementInfo, SectionProgram } from './program.ts';

// ─── Crowd state as seen by listeners ────────────────────────────────────────────────────────────

/** Pad coordinates: x = dark(-1)…bright(+1), y = calm(-1)…intense(+1). */
export interface PadPoint {
  x: number;
  y: number;
}

export interface CrowdFrame {
  cycle: number;
  listeners: number;
  /** Where the room collectively leans (smoothed aggregate of everyone's pads). */
  pull: PadPoint;
  /** Where the music currently is (measured descriptors mapped to pad space). */
  needle: PadPoint;
  /** Fraction of listeners actively steering (0..1). */
  turnout: number;
  /** 1 = everyone agrees, 0 = scattered. */
  consensus: number;
  split: null | { axis: 'x' | 'y'; low: number; high: number };
  /** Keep (+1) vs move on (-1) for the current section, smoothed. */
  keep: number;
  /** A sample of other listeners' pucks (anonymous), for the "school of fish" on the pad. */
  ghosts: { x: number; y: number; hue: number }[];
  /** Recent reactions for etching into the record rim. */
  etches: { type: Reaction; cycle: number; hue: number }[];
}

export type RequestStatus =
  | 'received'
  | 'considered'
  | 'now'
  | 'next-section'
  | 'next-movement'
  | 'fork-option'
  | 'merged'
  | 'declined'
  | 'playing'
  | 'played'
  | 'expired';

/**
 * A listener request. Raw text is only ever sent back to its author; everyone else sees the
 * composer's paraphrase (publicReply) once decided — requests are data, never markup.
 */
export interface RequestCard {
  id: string;
  mine: boolean;
  /** Author's own text (only when mine), otherwise null. */
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
}

export type LinerNoteKind = 'section' | 'movement' | 'announce' | 'reply' | 'system';

/** Claude's (or the autopilot's) voice. Rendered as text only. */
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
  state: 'idle' | 'planning' | 'waiting' | 'failed';
  /** Seconds of music committed ahead of now. */
  horizonSec: number;
  lastPlanAt: number | null;
  note: string | null;
}

export interface RoomSnapshot {
  serverTime: number;
  timeline: Timeline;
  movement: MovementInfo | null;
  /** Sections from the one before the current (for crossfade tails) through all committed ones. */
  sections: SectionProgram[];
  mixer: MixerState;
  crowd: CrowdFrame;
  fork: ForkState | null;
  notes: LinerNote[];
  requests: RequestCard[];
  composer: ComposerStatus;
  /** Whether this client should send audio telemetry (the server samples a subset). */
  telemetry: boolean;
  /** Public source URL (AGPL §13). */
  sourceUrl: string;
}

// ─── Telemetry ──────────────────────────────────────────────────────────────────────────────────

export const TelemetrySchema = z
  .object({
    cycle: z.number(),
    rmsDb: z.number().min(-120).max(12),
    peakDb: z.number().min(-120).max(12),
    centroidHz: z.number().min(0).max(24000),
    clipPct: z.number().min(0).max(100),
    errors: z
      .array(z.object({ partId: z.string().max(16), sectionId: z.string().max(16), message: z.string().max(200) }).strict())
      .max(8),
  })
  .strict();
export type Telemetry = z.infer<typeof TelemetrySchema>;

// ─── Client → server ────────────────────────────────────────────────────────────────────────────

const finite = z.number().refine(Number.isFinite, 'must be finite');
const padCoord = finite.min(-1).max(1);

export const HelloSchema = z
  .object({
    anonId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    clientVersion: z.string().max(32),
  })
  .strict();
export const HeartbeatSchema = z
  .object({ audible: z.boolean(), visible: z.boolean(), heardCycle: finite.nullable() })
  .strict();
export const PadSchema = z.object({ x: padCoord, y: padCoord }).strict();
export const KeepSchema = z.object({ v: z.union([z.literal(1), z.literal(-1)]) }).strict();
export const ReactSchema = z.object({ type: z.enum(REACTIONS), heardCycle: finite }).strict();
export const RequestSchema = z.object({ text: z.string().min(1).max(140) }).strict();
export const VoteSchema = z.object({ forkId: z.string().max(32), option: z.enum(['A', 'B', 'C']) }).strict();

export type Hello = z.infer<typeof HelloSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
export type PadInput = z.infer<typeof PadSchema>;
export type KeepInput = z.infer<typeof KeepSchema>;
export type ReactInput = z.infer<typeof ReactSchema>;
export type RequestInput = z.infer<typeof RequestSchema>;
export type VoteInput = z.infer<typeof VoteSchema>;

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
  request: (payload: RequestInput, ack: (res: { ok: boolean; id?: string; error?: string }) => void) => void;
  vote: (payload: VoteInput) => void;
  telemetry: (payload: Telemetry) => void;
  /** NTP-style clock probe; the ack carries the server clock in ms. */
  clock: (ack: (serverMs: number) => void) => void;
}

// ─── Server → client ────────────────────────────────────────────────────────────────────────────

export interface ServerToClientEvents {
  /** Full state on connect and after reconnects. */
  welcome: (snapshot: RoomSnapshot) => void;
  timeline: (timeline: Timeline) => void;
  movement: (movement: MovementInfo) => void;
  /** A newly committed future section (clients preload its sounds and schedule it). */
  section: (section: SectionProgram) => void;
  /** A committed-but-unplayed section was withdrawn (replan). */
  revoke: (payload: { sectionId: string }) => void;
  mixer: (mixer: MixerState) => void;
  /** Throttled (~4 Hz) crowd aggregate. */
  crowd: (frame: CrowdFrame) => void;
  fork: (fork: ForkState | null) => void;
  note: (note: LinerNote) => void;
  /** Request list for this client (their own cards + public decided ones). */
  requests: (cards: RequestCard[]) => void;
  composer: (status: ComposerStatus) => void;
  /** Rate-limit or validation feedback for this client's last input. */
  nack: (payload: { event: string; reason: string }) => void;
}

/** Server clock: performance.timeOrigin + performance.now() — monotonic, unlike Date.now(). */
export const CLIENT_VERSION = '0.2.0';
