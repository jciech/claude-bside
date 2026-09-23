// Server module boundaries. Each interface is implemented by exactly one module and consumed by
// others; tests use fakes of these. Implementations stay free of socket.io/express.
//
// Ownership:  Checker → src/server/check        RoomClock, Crowd → src/server/room
//             Conductor, Ledger, Store, buildTurnContext → src/server/conductor (+ store.ts)
//             Composer drivers → src/server/composer        main/config/log/http/socket → server root, room, http
import type { AuditionInput, FormStep, Knob, Plan } from '../shared/plan.ts';
import type {
  AuditionResult,
  CommitBody,
  CommitResult,
  ComposerApiStatus,
  CrowdSummary,
  DriverName,
  PlanReason,
  PlanRequest,
  TurnContext,
} from '../shared/composer-api.ts';
import type { SectionCheck, SectionFingerprint } from '../shared/analysis.ts';
import type { Descriptors, PartRole, SectionRole } from '../shared/music.ts';
import type {
  ComposerStatus,
  CrowdFrame,
  ForkState,
  Heartbeat,
  Hello,
  KeepInput,
  LinerNote,
  PadInput,
  PadPoint,
  ReactInput,
  RequestCard,
  RequestInput,
  RequestStatus,
  ServerToClientEvents,
  Telemetry,
  VoteInput,
} from '../shared/protocol.ts';
import type { Timeline } from '../shared/timeline.ts';
import type { MixerState, MovementInfo, SectionProgram } from '../shared/program.ts';
import type { Catalog } from '../shared/catalog.ts';

// ─── Checker (src/server/check) ─────────────────────────────────────────────────────────────────
// validate → evaluate → analyze in worker threads (never the main thread: evaluation executes code
// and pathological patterns can hang). Must work under plain `node` AND under vitest: each worker
// calls registerStrudelHooks() itself and imports Strudel dynamically; never pass explicit execArgv.
// Pool: size max(2, cores-1), maxQueue 64, commit jobs ahead of audition jobs, per-job timeout
// (default 1500 ms → Issue{rule:'timeout'} and the worker is respawned), full queue → Issue{rule:'busy'},
// workers recycled after 500 jobs, resourceLimits.maxOldGenerationSizeMb 256, fresh global Strudel
// state per job (resetVoicings, reset_state, useRNG('legacy'), calculateSteps default).
// The catalog reaches workers via workerData.

export interface CheckPartInput {
  id: string;
  role: PartRole;
  code: string;
  /** Complete declarations (inherited included); knob("x") must name one of these. */
  knobs: Knob[];
  chromatic: boolean;
  level: number;
  enterBar: number;
  exitBar: number | null;
  /** Pattern bar at the section's bar 0: 0 for fresh parts; for continuing parts, where they are. */
  patternBarAtStart: number;
}

export interface CheckSectionInput {
  parts: CheckPartInput[];
  bpm: number;
  /** Scale name or per-bar alternation ("<D:dorian G:mixolydian>"); null skips key fit. */
  scale: string | null;
  /** Composed bars; the checker analyses bars + one vamp loop (≤ 72 bars). */
  bars: number;
  /** The section's `vamp.loopBars`, which decides the score bars the vamp repeats; default min(8, bars). */
  vampLoopBars?: 4 | 8;
}

export interface CheckOptions {
  signal?: AbortSignal;
  priority?: 'commit' | 'audition';
  timeoutMs?: number;
}

export interface Checker {
  /** Checks parts as they will sound together: per-part checks, mix analysis, fingerprint. */
  checkSection(input: CheckSectionInput, opts?: CheckOptions): Promise<SectionCheck>;
  audition(input: AuditionInput, opts?: CheckOptions): Promise<AuditionResult>;
  close(): Promise<void>;
}

// ─── Composer (src/server/composer) ─────────────────────────────────────────────────────────────

/**
 * Operations the conductor lends a composer for ONE PlanRequest. After the request's signal aborts,
 * or after one accepted commit, `commit` resolves {accepted:false, errors:[{rule:'request-closed'}]}.
 */
export interface ComposerTools {
  readonly request: PlanRequest;
  audition(input: AuditionInput): Promise<AuditionResult>;
  commit(plan: Plan): Promise<CommitResult>;
}

export type ComposeOutcome =
  | { status: 'committed'; result: CommitResult; attempts: number; usage?: ComposerUsage }
  | { status: 'failed'; reason: string; attempts: number; usage?: ComposerUsage };

export interface ComposerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Messages API calls made for this plan (≤ ServerConfig.maxApiCallsPerPlan). */
  calls: number;
  ms: number;
}

export interface Composer {
  readonly driver: DriverName;
  /**
   * Resolves when the plan is committed, the composer gives up, or `signal` aborts. The abort reason
   * is 'deadline', 'driver-switch', 'superseded' or 'fulfilled' (an HTTP commit carrying this
   * request's id was accepted — the external driver simply awaits that).
   */
  compose(request: PlanRequest, tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome>;
}

/** The scripted driver additionally fills gaps synchronously from a boot-validated library. */
export interface ScriptedComposer extends Composer {
  /** A pre-validated section plan continuing the current material (carry-vamp or library pick). */
  fallbackPlan(context: TurnContext): Plan;
}

// ─── Clock (src/server/room/clock.ts) ───────────────────────────────────────────────────────────
// Factory: createRoomClock({ timeline, now?, timers? }): RoomClock  (now defaults to the server clock)

export interface RoomClock {
  /** Server clock in ms (performance.timeOrigin + performance.now()). */
  now(): number;
  /** Current fractional cycle. */
  cycle(): number;
  bpm(): number;
  timeline(): Timeline;
  /** Replaces the tempo map (the conductor derives it with buildTimeline and respects the lock). */
  setTimeline(timeline: Timeline): void;
  /** Called at every integer cycle boundary (drift-corrected), with the new bar number. */
  onBar(listener: (bar: number) => void): () => void;
  start(): void;
  stop(): void;
}

// ─── Crowd (src/server/room/crowd.ts) ───────────────────────────────────────────────────────────
// Owns listener identity/weights (trust, presence, per-network caps), rate limits, pad aggregation,
// keep ballots, reactions, requests and forks. Emits `crowd` (4 Hz), and per-listener `fork` and
// `requests` through the Broadcaster. Never calls the conductor; the conductor polls tick().

export type CrowdSignal =
  | { type: 'replan-pressure'; axis: 'brightness' | 'intensity'; pressure: number }
  | { type: 'keep'; direction: 1 | -1; sectionId: string }
  | { type: 'harsh' }
  | { type: 'bored' }
  | { type: 'request-surge'; requestId: string };

export interface Nack {
  event: string;
  reason: string;
}

export interface JoinResult {
  listenerId: string;
  hue: number;
  token: string;
}

export interface Crowd {
  join(socketId: string, hello: Hello, address: string, nowMs: number): JoinResult | Nack;
  leave(socketId: string, nowMs: number): void;
  heartbeat(socketId: string, hb: Heartbeat, nowMs: number): Nack | null;
  pad(socketId: string, p: PadInput, nowMs: number): Nack | null;
  keep(socketId: string, k: KeepInput, cycle: number, nowMs: number): Nack | null;
  react(socketId: string, r: ReactInput, cycle: number, nowMs: number): Nack | null;
  request(socketId: string, r: RequestInput, nowMs: number): { ok: true; id: string } | { ok: false; error: string };
  vote(socketId: string, v: VoteInput, nowMs: number): Nack | null;
  telemetry(socketId: string, t: Telemetry, nowMs: number): Nack | null;

  /** Once per bar: smoothing, ballots, replan hysteresis. Returns signals for the conductor. */
  tick(bar: number, nowMs: number, baseline: { intensity: number; brightness: number }): CrowdSignal[];
  frame(cycle: number, needle: PadPoint): CrowdFrame;
  summary(baseline: { intensity: number; brightness: number }, nowMs: number): CrowdSummary;
  /** Smoothed room pull (-1..1 per axis) and how confidently it is held (for macros). */
  pull(): { point: PadPoint; confidence: number; listeners: number };
  audibleListeners(nowMs: number): number;
  /** Median of sampled clients' telemetry over the window, for descriptor refinement. */
  telemetryDigest(fromCycle: number, toCycle: number): { rmsDb: number; centroidHz: number; clipPct: number; clients: number } | null;
  /** Corroborated client errors (≥ 2 distinct trusted listeners, or ≥ 20 % of sampled ones). */
  corroboratedErrors(sinceCycle: number): { sectionId: string; partId: string; code: Telemetry['errors'][number]['code']; clients: number }[];
  /** Per-section reaction rates as z-scores against the room's 15-min baseline. */
  reactionStats(fromCycle: number, toCycle: number): CrowdSummary['reactions'];

  sectionStarted(section: { id: string; startCycle: number; bars: number; role: SectionRole }): void;
  setKeepPending(p: CrowdFrame['keepPending']): void;
  consumeKeep(): void;
  hasRequest(id: string): boolean;
  applyDecisions(d: { requestId: string; status: RequestStatus; publicReply: string; sectionId: string | null }[]): void;
  markSectionPlaying(sectionId: string): void;
  markSectionPlayed(sectionId: string): void;
  openFork(f: {
    id: string;
    prompt: string;
    options: (ForkState['options'][number] & { requestId: string | null })[];
    defaultOption: 'A' | 'B' | 'C';
    opensAtCycle: number;
    closesAtCycle: number;
  }): void;
  closeFork(): NonNullable<CrowdSummary['forkResult']> | null;
  setForkLanding(forkId: string, sectionId: string, landsAtCycle: number): void;
  /** Snapshot pieces for one listener. */
  requestCardsFor(listenerId: string): RequestCard[];
  forkFor(listenerId: string): ForkState | null;
  listenerIdOf(socketId: string): string | null;
}

// ─── Ledger (src/server/conductor/ledger.ts) ────────────────────────────────────────────────────
// Append-only JSONL of sections recorded at their bar 0 (revoked sections never enter it), with an
// in-memory window of the last 2 h. Rows authored by 'scripted' or with audible = 0 are excluded from
// cooldown and similarity windows. Wall-clock (Date.now()) stamps for time windows.

export interface LedgerRow {
  sectionId: string;
  epoch: string;
  movementId: string;
  name: string;
  role: SectionRole;
  startedAtWallMs: number;
  endedAtWallMs: number | null;
  startCycle: number;
  bpm: number;
  scale: string;
  sounds: { id: string; share: number }[];
  fingerprint: SectionFingerprint;
  measured: Descriptors;
  parts: { id: string; role: PartRole; code: string }[];
  crowd: { fireZ: number; boredZ: number; harshZ: number; keep: number } | null;
  author: DriverName;
  audible: number;
}

export interface CrateItem {
  id: string;
  family: string;
  tags: string;
}

export interface Ledger {
  record(row: LedgerRow): void;
  close(sectionId: string, endedAtWallMs: number, crowd: LedgerRow['crowd']): void;
  recent(sinceWallMs: number): LedgerRow[];
  /** Sounds that may not be introduced into a new movement (loudness share ≥ 0.25 in 3 of the last 6 rows). */
  cooldown(nowWallMs: number): string[];
  /** Nearest section of a PREVIOUS movement within 20 min, if closer than 0.15. */
  similar(fp: SectionFingerprint, currentMovementId: string, nowWallMs: number): { sectionId: string; distance: number } | null;
  flags(currentMovementId: string, nowWallMs: number): string[];
  /** Deterministic stratified crate from the catalog (seed = movement id), biased by brightness and freshness. */
  drawCrate(seed: string, catalog: Catalog, prefs: { brightness: number }, nowWallMs: number): CrateItem[];
  lovedMoments(nowWallMs: number): { sectionId: string; what: string; fireZ: number }[];
}

// ─── Conductor (src/server/conductor/conductor.ts) ──────────────────────────────────────────────
// Owns time decisions, the arc, planning, acceptance, compilation, schedule broadcast, mixer and
// persistence. Emits schedule, mixer, note and composer events through the Broadcaster.
// Concurrency: commits are serialised through one queue; placement, carry resolution and
// novelty/dramaturgy checks run under that lock against the then-current schedule, after the
// checker results. At most one PlanRequest is in flight. setDriver() aborts it.
// Boot: start() restores or begins an epoch and commits a scripted section synchronously before
// accepting listeners, whatever the configured driver.

export interface ConductorEvents {
  request(r: PlanRequest): void;
  status(s: ComposerApiStatus): void;
  section(s: SectionProgram): void;
  revoke(sectionId: string): void;
  started(sectionId: string): void;
}

export interface SnapshotBase {
  epoch: string;
  rev: number;
  timeline: Timeline;
  movements: MovementInfo[];
  sections: SectionProgram[];
  mixer: MixerState;
  notes: LinerNote[];
  composer: ComposerStatus;
}

export interface Conductor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Shared part of every welcome (serialised once per rev by the socket layer). */
  snapshot(): SnapshotBase;
  apiStatus(): ComposerApiStatus;
  /** The pending request's context, or a fresh preview. */
  previewContext(): TurnContext;
  audition(input: AuditionInput): Promise<AuditionResult>;
  commit(body: CommitBody, author: DriverName): Promise<CommitResult>;
  setDriver(driver: DriverName): Promise<ComposerApiStatus>;
  requestPlan(reason: PlanReason): void;
  /** Where the music is heading, in pad space (for CrowdFrame.needle). */
  needle(): PadPoint;
  on<E extends keyof ConductorEvents>(event: E, listener: ConductorEvents[E]): () => void;
}

// ─── Broadcast + persistence ────────────────────────────────────────────────────────────────────

export type EventArgs<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>;

export interface Broadcaster {
  /** To every live listener (sockets that have been welcomed). */
  emit<E extends keyof ServerToClientEvents>(event: E, ...args: EventArgs<E>): void;
  /** To every socket of one listener. */
  toListener<E extends keyof ServerToClientEvents>(listenerId: string, event: E, ...args: EventArgs<E>): void;
}

export const STORE_KEYS = { session: 'session.v1', ledger: 'ledger.v1', identity: 'identity.v1' } as const;

export interface Store {
  readJson<T>(key: string): T | undefined;
  /** Immediate atomic write (temp file + rename). Used for the session on every schedule change. */
  writeJson<T>(key: string, value: T): void;
  append<T>(stream: string, record: T): void;
  readJsonl<T>(stream: string): T[];
  flush(): Promise<void>;
}

/** Persisted on every schedule change; used to warm-restore the same epoch after a quick restart. */
export interface PersistedSession {
  version: 1;
  epoch: string;
  rev: number;
  sectionSeq: number;
  movementSeq: number;
  side: number;
  lastCycle: number;
  savedAtServerMs: number;
  savedAtWallMs: number;
  timeline: Timeline;
  movements: (MovementInfo & {
    baseline: { intensity: number; brightness: number };
    amplitude: number;
    signature: string[];
    palette: string[];
    crate: string[];
    form: FormStep[];
    motifs: { id: string; role: PartRole; code: string; fromSectionId: string }[];
    lastRationale: string | null;
  })[];
  sections: SectionProgram[];
  mixer: MixerState;
  notes: LinerNote[];
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ServerConfig {
  port: number;
  dev: boolean;
  dataDir: string;
  catalogPath: string;
  /** Initial composer driver: claude if ANTHROPIC_API_KEY is set, else scripted (BSIDE_COMPOSER overrides). */
  driver: DriverName;
  model: string;
  effort: { section: 'low' | 'medium' | 'high'; movement: 'medium' | 'high' | 'xhigh' };
  /** Hard ceiling on compose() invocations per hour (not API messages). */
  maxPlansPerHour: number;
  maxApiCallsPerPlan: number;
  adminToken: string | null;
  /** HMAC secret for listener tokens (BSIDE_SECRET, else generated and persisted in dataDir). */
  secret: string;
  /** Reverse-proxy hops to trust for client addresses (0 = use the socket peer). */
  trustProxy: number;
  ipv6Prefix: number;
  maxSocketsPerNetwork: number;
  sourceUrl: string;
}

export type { Catalog };
