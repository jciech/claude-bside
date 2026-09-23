// Server module boundaries. Each interface is implemented by one module and consumed by others;
// tests use fakes of these. Keep implementations free of socket.io/express so they stay testable.
import type { AuditionInput, Plan } from '../shared/plan.ts';
import type { AuditionResult, CommitResult, DriverName, PlanRequest } from '../shared/composer-api.ts';
import type { CodeCheck } from '../shared/analysis.ts';
import type { PartRole } from '../shared/music.ts';
import type { ServerToClientEvents } from '../shared/protocol.ts';
import type { Timeline } from '../shared/timeline.ts';

// ─── Checker (src/server/check) ─────────────────────────────────────────────────────────────────
// Runs validate → evaluate → analyze for Strudel code in worker threads (never the main thread:
// Strudel evaluation executes code and pathological patterns can hang or allocate without bound).

export interface CheckCodeOptions {
  id: string;
  role: PartRole;
  bpm: number;
  /** Scale for key-fit analysis, e.g. "D:dorian"; null skips key fit. */
  scale: string | null;
  /** Bars to analyse (default 16). */
  bars?: number;
}

export interface Checker {
  checkCode(code: string, opts: CheckCodeOptions): Promise<CodeCheck>;
  /** Checks several parts and the mix they make together. */
  audition(input: AuditionInput): Promise<AuditionResult>;
  close(): Promise<void>;
}

// ─── Composer (src/server/composer) ─────────────────────────────────────────────────────────────

/** Operations the conductor lends a composer for one planning request. */
export interface ComposerTools {
  audition(input: AuditionInput): Promise<AuditionResult>;
  /** Validates and, if acceptable, schedules the plan. May be called again after a rejection. */
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
  calls: number;
  ms: number;
}

export interface Composer {
  readonly driver: DriverName;
  /** Resolves when the plan is committed, the composer gives up, or `signal` aborts (deadline). */
  compose(request: PlanRequest, tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome>;
}

// ─── Clock (src/server/room/clock.ts) ───────────────────────────────────────────────────────────

export interface RoomClock {
  /** Server clock in ms (performance.timeOrigin + performance.now()). */
  now(): number;
  /** Current fractional cycle. */
  cycle(): number;
  bpm(): number;
  timeline(): Timeline;
  /** Schedule a tempo change starting at integer cycle `atCycle`, optionally ramping over bars. */
  setTempo(atCycle: number, bpm: number, rampBars?: number): Timeline;
  /** Called at every integer cycle boundary (drift-corrected), with the new bar number. */
  onBar(listener: (bar: number) => void): () => void;
  start(): void;
  stop(): void;
}

// ─── Broadcast + persistence ────────────────────────────────────────────────────────────────────

export type EventArgs<E extends keyof ServerToClientEvents> = Parameters<ServerToClientEvents[E]>;

export interface Broadcaster {
  /** To every connected listener. */
  emit<E extends keyof ServerToClientEvents>(event: E, ...args: EventArgs<E>): void;
  /** To one connected client (socket id). */
  to<E extends keyof ServerToClientEvents>(clientId: string, event: E, ...args: EventArgs<E>): void;
}

export interface Store {
  get<T>(key: string): T | undefined;
  /** Debounced, atomic (write temp + rename) persistence under the data directory. */
  set<T>(key: string, value: T): void;
  flush(): Promise<void>;
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
  /** Initial composer driver: claude if ANTHROPIC_API_KEY is set, else scripted (override with BSIDE_COMPOSER). */
  driver: DriverName;
  model: string;
  effort: { section: 'low' | 'medium' | 'high'; movement: 'medium' | 'high' | 'xhigh' };
  /** Hard ceiling on Claude calls per hour. */
  maxCallsPerHour: number;
  adminToken: string | null;
  sourceUrl: string;
  /** When no listener is audible, stop calling Claude and let the autopilot vamp. */
  pauseWhenEmpty: boolean;
}
