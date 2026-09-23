// Test doubles for the conductor: a manual clock that fires bars, a deterministic checker, a
// scriptable crowd, controllable composers, a recording broadcaster, and plan builders.
import { readFileSync } from 'node:fs';
import type { PartAnalysis, SectionCheck, SectionFingerprint } from '../../src/shared/analysis.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import type { AuditionResult, CommitResult, CrowdSummary, PlanRequest, TurnContext } from '../../src/shared/composer-api.ts';
import { bpmToCps, cpsToBpm, type PartRole, type SectionRole } from '../../src/shared/music.ts';
import type { PartPlan, Plan, SectionPlan } from '../../src/shared/plan.ts';
import type { CrowdFrame, PadPoint, ServerToClientEvents } from '../../src/shared/protocol.ts';
import { cpsAtCycle, cpsAtMs, createTimeline, cycleAtMs, msAtCycle, type Timeline } from '../../src/shared/timeline.ts';
import type {
  Broadcaster,
  CheckSectionInput,
  Checker,
  ComposeOutcome,
  Composer,
  ComposerTools,
  Crowd,
  CrowdSignal,
  Logger,
  RoomClock,
  ScriptedComposer,
  ServerConfig,
} from '../../src/server/types.ts';
import { createConductor, type ConductorDeps } from '../../src/server/conductor/conductor.ts';
import { createMemoryStore } from '../../src/server/conductor/store.ts';

export const catalog: Catalog = JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'));

export const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
};

// ─── Clock ─────────────────────────────────────────────────────────────────────────────────────

export interface FakeClock extends RoomClock {
  set(ms: number): void;
  /** Advances time, firing every bar boundary crossed (and letting promises settle between bars). */
  advance(ms: number): Promise<void>;
  /** Advances to just after the given cycle's boundary. */
  toCycle(cycle: number): Promise<void>;
}

export function createFakeClock(startMs = 1_000_000, bpm = 120): FakeClock {
  let t = startMs;
  let tl: Timeline = createTimeline(t, bpmToCps(bpm));
  const listeners = new Set<(bar: number) => void>();
  let running = false;
  let lastBar = 0;
  const inProgress = () => Math.ceil(cycleAtMs(tl, t) - 1e-6) - 1;
  const clock: FakeClock = {
    now: () => t,
    cycle: () => cycleAtMs(tl, t),
    bpm: () => cpsToBpm(cpsAtMs(tl, t)),
    timeline: () => tl,
    setTimeline(next) {
      const before = cycleAtMs(tl, t);
      tl = next;
      if (running && Math.abs(cycleAtMs(tl, t) - before) > 1e-3) lastBar = Math.max(lastBar, inProgress());
    },
    onBar(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    start() {
      if (running) return;
      running = true;
      lastBar = inProgress();
    },
    stop() {
      running = false;
    },
    set(ms) {
      t = ms;
    },
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const nextMs = msAtCycle(tl, lastBar + 1);
        if (!running || nextMs > target) break;
        t = Math.max(t, nextMs);
        lastBar++;
        for (const fn of [...listeners]) fn(lastBar);
        await flush();
      }
      t = target;
      await flush();
    },
    async toCycle(cycle) {
      await clock.advance(Math.max(0, msAtCycle(tl, cycle) - t + 1));
    },
  };
  return clock;
}

// ─── Checker ───────────────────────────────────────────────────────────────────────────────────

const soundOf = (code: string) => /s\("([a-z0-9_]+)/.exec(code)?.[1] ?? 'triangle';

function analysisFor(id: string, role: PartRole, code: string): PartAnalysis {
  const median = Number(/midi(\d+)/.exec(code)?.[1] ?? (role === 'bass' ? 40 : 60));
  return {
    id,
    role,
    onsetsPerBar: 4,
    densityPerBar: { min: 4, mean: 4, max: 4 },
    sounds: [{ id: soundOf(code), kind: 'synth', family: 'synth/basic', known: true, onsets: 64, share: 1 }],
    pitch: role === 'kick' ? null : { minMidi: median, maxMidi: median, medianMidi: median, distinct: 1, register: 'mid', keyFit: 1 },
    syncopation: 0,
    grid16: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    loudness: { meanGain: 0.8, peakOverlapGain: 0.8, score: 0.6, estRmsDb: /rms(-?\d+)/.test(code) ? Number(/rms(-?\d+)/.exec(code)![1]) : null },
    brightness: 0.5,
    lowEndShare: 0,
    percussiveShare: 0,
    random: false,
    period: 1,
    energy: 0.5,
    silent: /silent/.test(code),
    fx: {},
  };
}

export interface FakeChecker extends Checker {
  calls: CheckSectionInput[];
  delayMs: number;
  /** Measured spans per section (default: flat 0.5, or a rise when any part code contains "rise"). */
  spans?: (input: CheckSectionInput) => NonNullable<SectionCheck['mix']>['spans'];
}

export function createFakeChecker(): FakeChecker {
  const checker: FakeChecker = {
    calls: [],
    delayMs: 0,
    async checkSection(input) {
      checker.calls.push(structuredClone(input));
      if (checker.delayMs) await new Promise((r) => setTimeout(r, checker.delayMs));
      const rise = input.parts.some((p) => /rise/.test(p.code));
      const flat = { start: 0.5, end: 0.5 };
      const spans = checker.spans?.(input) ?? {
        intensity: rise ? { start: 0.3, end: 0.7 } : flat,
        brightness: flat,
        density: flat,
        tension: rise ? { start: 0.3, end: 0.7 } : { start: 0.3, end: 0.3 },
      };
      const parts = input.parts.map((p) => {
        const bad = /BAD/.test(p.code);
        return {
          id: p.id,
          ok: !bad,
          errors: bad ? [{ severity: 'error' as const, rule: 'unknown-method', message: 'Unknown method `.BAD`', path: p.id }] : [],
          warnings: [],
          analysis: analysisFor(p.id, p.role, p.code),
          timings: { validateMs: 0, evaluateMs: 0, analyzeMs: 0 },
          digest: { id: p.id, role: p.role, instrument: soundOf(p.code), evPerBar: 4, register: null, sync: 0, bright: 0.5, loud: 0.6, period: 1, keyFit: 1 },
          instrument: soundOf(p.code),
        };
      });
      const shares: Record<string, number> = {};
      for (const p of input.parts) shares[soundOf(p.code)] = (shares[soundOf(p.code)] ?? 0) + 1 / input.parts.length;
      const fingerprint: SectionFingerprint = {
        descriptors: { intensity: 0.5, brightness: 0.5, density: 0.5, tension: 0.3 },
        soundShares: shares,
        kickGrid16: input.parts.some((p) => p.role === 'kick') ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] : new Array(16).fill(0),
        backbeatGrid16: new Array(16).fill(0),
        scale: input.scale ?? '',
        bpm: input.bpm,
        chordHash: null,
      };
      return {
        ok: parts.every((p) => p.ok),
        errors: [],
        warnings: [],
        parts,
        mix: {
          descriptors: fingerprint.descriptors,
          spans,
          onsetsPerBar: 8,
          maxOnsetsPerBar: 8,
          peakOverlapGain: 1,
          audibleParts: parts.length,
          period: 1,
        },
        fingerprint,
      };
    },
    async audition(): Promise<AuditionResult> {
      return { parts: [], mix: null, descriptors: null };
    },
    async close() {},
  };
  return checker;
}

// ─── Crowd ─────────────────────────────────────────────────────────────────────────────────────

export interface FakeCrowd extends Crowd {
  listeners: number;
  pullPoint: PadPoint;
  confidence: number;
  /** Signals returned by the next tick() calls (one array per bar, FIFO). */
  queued: CrowdSignal[][];
  requests: CrowdSummary['requests'];
  known: Set<string>;
  calls: { method: string; args: unknown[] }[];
  called(method: string): unknown[][];
}

export function createFakeCrowd(): FakeCrowd {
  const crowd: FakeCrowd = {
    listeners: 1,
    pullPoint: { x: 0, y: 0 },
    confidence: 0.5,
    queued: [],
    requests: [],
    known: new Set(),
    calls: [],
    called(method) {
      return crowd.calls.filter((c) => c.method === method).map((c) => c.args);
    },
    join: () => ({ listenerId: 'l', hue: 0, token: 't' }),
    leave() {},
    heartbeat: () => null,
    pad: () => null,
    keep: () => null,
    react: () => null,
    request: () => ({ ok: true, id: 'r' }),
    vote: () => null,
    telemetry: () => null,
    tick: () => crowd.queued.shift() ?? [],
    frame: (cycle: number, needle: PadPoint): CrowdFrame => ({
      cycle,
      listeners: crowd.listeners,
      pull: crowd.pullPoint,
      needle,
      turnout: 0,
      consensus: 0,
      split: null,
      keep: 0,
      keepPending: null,
      ghosts: [],
      etches: [],
      requestsWaiting: 0,
    }),
    summary: (): CrowdSummary => ({
      listeners: crowd.listeners,
      pad: { brightness: 0.5, intensity: 0.5, turnout: 0, consensus: 0, effectiveVoices: 0, split: null },
      pressure: { brightness: 0, intensity: 0 },
      keepVsMoveOn: 0,
      reactions: {
        fire: { perListenerPerMin: 0, z: 0 },
        vibe: { perListenerPerMin: 0, z: 0 },
        bored: { perListenerPerMin: 0, z: 0 },
        harsh: { perListenerPerMin: 0, z: 0 },
      },
      requests: crowd.requests,
      promises: [],
      forkResult: null,
    }),
    pull: () => ({ point: crowd.pullPoint, confidence: crowd.confidence, listeners: crowd.listeners }),
    audibleListeners: () => crowd.listeners,
    telemetryDigest: () => null,
    corroboratedErrors: () => [],
    reactionStats: () => ({
      fire: { perListenerPerMin: 0, z: 0 },
      vibe: { perListenerPerMin: 0, z: 0 },
      bored: { perListenerPerMin: 0, z: 0 },
      harsh: { perListenerPerMin: 0, z: 0 },
    }),
    sectionStarted: (...args) => void crowd.calls.push({ method: 'sectionStarted', args }),
    setKeepPending: (...args) => void crowd.calls.push({ method: 'setKeepPending', args }),
    consumeKeep: (...args) => void crowd.calls.push({ method: 'consumeKeep', args }),
    hasRequest: (id) => crowd.known.has(id),
    applyDecisions: (...args) => void crowd.calls.push({ method: 'applyDecisions', args }),
    markSectionPlaying: (...args) => void crowd.calls.push({ method: 'markSectionPlaying', args }),
    markSectionPlayed: (...args) => void crowd.calls.push({ method: 'markSectionPlayed', args }),
    openFork: (...args) => void crowd.calls.push({ method: 'openFork', args }),
    closeFork: () => null,
    setForkLanding: (...args) => void crowd.calls.push({ method: 'setForkLanding', args }),
    requestCardsFor: () => [],
    forkFor: () => null,
    listenerIdOf: () => null,
  };
  return crowd;
}

// ─── Broadcaster, logger, config ─────────────────────────────────────────────────────────────────

export interface RecordingBroadcaster extends Broadcaster {
  events: { event: keyof ServerToClientEvents; args: unknown[] }[];
  of<E extends keyof ServerToClientEvents>(event: E): Parameters<ServerToClientEvents[E]>[0][];
}

export function createRecordingBroadcaster(): RecordingBroadcaster {
  const b: RecordingBroadcaster = {
    events: [],
    emit(event, ...args) {
      b.events.push({ event, args: structuredClone(args) });
    },
    toListener() {},
    of(event) {
      return b.events.filter((e) => e.event === event).map((e) => e.args[0]) as never;
    },
  };
  return b;
}

export interface MemoryLog extends Logger {
  lines: { level: string; msg: string; data?: Record<string, unknown> }[];
}

export function createMemoryLog(): MemoryLog {
  const lines: MemoryLog['lines'] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => void lines.push({ level, msg, data });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

export const config: ServerConfig = {
  port: 0,
  dev: true,
  dataDir: '/nonexistent',
  catalogPath: '',
  driver: 'scripted',
  model: 'test',
  effort: { section: 'medium', movement: 'high' },
  maxPlansPerHour: 90,
  maxApiCallsPerPlan: 8,
  adminToken: null,
  secret: 'x',
  trustProxy: 0,
  ipv6Prefix: 48,
  maxSocketsPerNetwork: 8,
  sourceUrl: 'https://example.invalid',
};

// ─── Plans ─────────────────────────────────────────────────────────────────────────────────────

export function part(id: string, over: Partial<PartPlan> = {}): PartPlan {
  const role: PartRole = over.role ?? (id === 'kick' ? 'kick' : id === 'bass' ? 'bass' : id === 'hats' ? 'hats' : 'pad');
  return {
    id,
    role,
    code: `s("${id === 'kick' ? 'sbd' : id === 'hats' ? 'white' : 'triangle'}").gain(0.8)`,
    restart: false,
    chromatic: false,
    level: 0.8,
    enterBar: 0,
    exitBar: null,
    knobs: [],
    automation: [],
    duck: null,
    ...over,
  };
}

export function section(over: Partial<SectionPlan> = {}): SectionPlan {
  const flat = { start: 0.5, end: 0.5 };
  return {
    name: 'Tide Line',
    role: 'groove',
    bars: 16,
    bpm: 120,
    tempoRampBars: 0,
    tempoRampAt: 'start',
    scale: 'D:dorian',
    chords: null,
    targets: { intensity: flat, brightness: flat, density: flat, tension: { start: 0.3, end: 0.3 } },
    transitionIn: { type: 'cut', bars: 0 },
    parts: [part('kick'), part('pad')],
    reprise: null,
    publicNote: 'A steady tide.',
    ...over,
  };
}

export function plan(sections: SectionPlan[], over: Partial<Plan> = {}): Plan {
  return { sections, movement: null, fork: null, requestDecisions: [], motifs: [], announcement: null, rationale: 'test', ...over };
}

export function movement(over: Partial<NonNullable<Plan['movement']>> = {}): NonNullable<Plan['movement']> {
  return {
    name: 'Harbour Lights',
    startsAtSection: 0,
    bpm: 120,
    scale: 'D:dorian',
    groove: 'four-on-floor',
    arcShape: 'wave',
    form: [],
    palette: [],
    signature: [],
    blurb: 'A slow tide.',
    ...over,
  };
}

// ─── Composers ─────────────────────────────────────────────────────────────────────────────────

export interface FakeScripted extends ScriptedComposer {
  contexts: TurnContext[];
  /** Override what fallbackPlan returns. */
  make?: (ctx: TurnContext) => Plan;
}

let scriptedSeq = 0;
/** Default autopilot: a fresh groove in the movement's key and tempo (varied sounds so novelty never bites). */
export function scriptedPlanFor(ctx: TurnContext): Plan {
  const bpm = ctx.movement?.bpm ?? 120;
  const scale = ctx.movement?.scale ?? 'D:dorian';
  const n = ++scriptedSeq;
  const s = section({ name: `Autopilot ${n}`, bpm, scale, publicNote: 'The autopilot keeps it moving.' });
  return plan([s], { movement: ctx.movement ? null : movement({ bpm, scale }), rationale: `autopilot ${n}` });
}

export function createFakeScripted(): FakeScripted {
  const s: FakeScripted = {
    driver: 'scripted',
    contexts: [],
    fallbackPlan(ctx) {
      s.contexts.push(ctx);
      return (s.make ?? scriptedPlanFor)(ctx);
    },
    async compose(request, tools): Promise<ComposeOutcome> {
      const result = await tools.commit(s.fallbackPlan(request.context));
      return result.accepted ? { status: 'committed', result, attempts: 1 } : { status: 'failed', reason: result.errors[0]?.message ?? 'rejected', attempts: 1 };
    },
  };
  return s;
}

/** A composer the test drives by hand: it records requests and waits until told to commit or give up. */
export interface ManualComposer extends Composer {
  requests: { request: PlanRequest; tools: ComposerTools; signal: AbortSignal; resolve(o: ComposeOutcome): void }[];
  last(): ManualComposer['requests'][number];
  commit(plan: Plan): Promise<CommitResult>;
}

export function createManualComposer(driver: 'claude' | 'external'): ManualComposer {
  const c: ManualComposer = {
    driver,
    requests: [],
    last() {
      const r = c.requests[c.requests.length - 1];
      if (!r) throw new Error('no request yet');
      return r;
    },
    /** Commits through the tools like a driver would, and returns from compose() once accepted. */
    async commit(p) {
      const req = c.last();
      const result = await req.tools.commit(p);
      if (result.accepted) req.resolve({ status: 'committed', result, attempts: 1 });
      return result;
    },
    compose(request, tools, signal) {
      return new Promise<ComposeOutcome>((resolve) => {
        c.requests.push({ request, tools, signal, resolve });
        signal.addEventListener('abort', () => resolve({ status: 'failed', reason: String(signal.reason), attempts: 0 }));
      });
    },
  };
  return c;
}

// ─── A whole room ────────────────────────────────────────────────────────────────────────────

export function createRoom(over: Partial<ConductorDeps> & { bpm?: number; startMs?: number; wall?: { now: number } } = {}) {
  const clock = (over.clock as FakeClock | undefined) ?? createFakeClock(over.startMs, over.bpm);
  const crowd = (over.crowd as FakeCrowd | undefined) ?? createFakeCrowd();
  const checker = (over.checker as FakeChecker | undefined) ?? createFakeChecker();
  const store = over.store ?? createMemoryStore();
  const log = createMemoryLog();
  const broadcaster = createRecordingBroadcaster();
  const scripted = (over.composers?.scripted as FakeScripted | undefined) ?? createFakeScripted();
  const claude = createManualComposer('claude');
  const external = createManualComposer('external');
  const wall = over.wall ?? { now: 1_700_000_000_000 };
  const t0 = clock.now();
  let epochs = 0;
  const conductor = createConductor({
    clock,
    crowd,
    checker,
    store,
    log,
    config: { ...config, ...(over.config ?? {}) },
    catalog,
    composers: over.composers ?? { claude, external, scripted },
    broadcaster,
    ledger: over.ledger,
    wallNow: () => wall.now + (clock.now() - t0),
    newEpoch: over.newEpoch ?? (() => `ep${++epochs}`),
  });
  return { clock, crowd, checker, store, log, broadcaster, scripted, claude, external, conductor, wall };
}

export type Room = ReturnType<typeof createRoom>;

export const lastSchedule = (room: Room) => room.broadcaster.of('schedule').at(-1)!;
export const bpmsAt = (tl: Timeline, cycles: number[]) => cycles.map((c) => Math.round(cpsToBpm(cpsAtCycle(tl, c)) * 10) / 10);
export type { SectionRole };
