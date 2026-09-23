// The Conductor (src/server/types.ts; ARCHITECTURE §4–9, §13): owns the schedule. It boots or
// warm-restores an epoch, accepts plans through ONE serial queue (schema → rules → checker →
// musical/tempo/novelty/dramaturgy → placement under the lock → compile → timeline → persist →
// broadcast), runs the single-flight planning loop with soft/hard deadlines and the scripted
// fallback, applies the crowd each bar (Stay/Move on, replans, safety, forks) and drives the mixer.
import { randomBytes } from 'node:crypto';
import type { Issue, SectionCheck, SectionFingerprint } from '../../shared/analysis.ts';
import type { AuditionResult, CommitBody, CommitResult, ComposerApiStatus, DriverName, PlanReason, PlanRequest, TurnContext } from '../../shared/composer-api.ts';
import { bpmToCps, cpsToBpm, DEFAULT_BPM, type SectionRole } from '../../shared/music.ts';
import { PlanSchema, type AuditionInput, type Plan, type RequestDecision } from '../../shared/plan.ts';
import { EMPTY_MIXER, type MixerState, type MovementInfo, type SectionProgram } from '../../shared/program.ts';
import { namesScheduledPart, type ComposerStatus, type LinerNote, type LinerNoteKind, type PadPoint, type RequestStatus, type ScheduleUpdate } from '../../shared/protocol.ts';
import {
  HORIZON_TRIGGER_MIN_S,
  MIN_CHANGE_LEAD_S,
  nextPhraseLine,
  PHRASE_BARS,
  plannedPlayBars,
  PRELOAD_BARS,
  publishDeadlineMs,
  SECTION_PRELOAD_S,
  sectionExtents,
} from '../../shared/schedule.ts';
import { cpsAtCycle, createTimeline, cycleAtMs, msAtCycle, pruneTimeline, type Timeline } from '../../shared/timeline.ts';
import {
  STORE_KEYS,
  type Broadcaster,
  type Catalog,
  type Checker,
  type Composer,
  type ComposerTools,
  type ComposeOutcome,
  type Conductor,
  type ConductorEvents,
  type Crowd,
  type CrowdSignal,
  type Ledger,
  type LedgerRow,
  type Logger,
  type PersistedSession,
  type RoomClock,
  type ScriptedComposer,
  type ServerConfig,
  type SnapshotBase,
  type Store,
} from '../types.ts';
import {
  checkIssues,
  dramaturgyIssues,
  isBeatless,
  MOVEMENT_MAX_AGE_MIN,
  musicalIssues,
  noveltyIssues,
  planIssues,
  relax,
  resolvedIssues,
  tempoIssues,
  type DramaturgyEntry,
} from './accept.ts';
import { ARC_AMPLITUDE, bendBaseline, isAmbient, isPeakSpan, peakThreshold, type Arc, type Baseline, type BudgetSpan } from './arc.ts';
import { balanceTrims, carryPlan, checkInputFor, compileSection, continuingPatternBars, resolveSection, withCarriedKnobs, type ResolvedPart } from './compile.ts';
import { buildTurnContext, planBarBounds, type MovementState } from './context.ts';
import { decideKeep } from './keep.ts';
import { createLedger, LEDGER_WINDOW_MS } from './ledger.ts';
import { mixerTick, needlePoint, withSafety } from './mixer.ts';
import { ACCEPT_BUDGET_MS, ACCEPT_MARGIN_MS, barMsAt, isHardLocked, patternBarAt, place, plannedEnd, rebuildTimeline, type PlaceMode, type Placement } from './placement.ts';

const MIN = 60_000;
const DEFAULT_BASELINE: Baseline = { intensity: 0.5, brightness: 0.5 };
/** Assumed p90 compose time until Claude has been measured. */
const DEFAULT_P90_MS = 60_000;
const HORIZON_SLACK_MS = 20_000;
/** An event-triggered plan waits for the horizon when this much music beyond the trigger is committed. */
const EVENT_HORIZON_MAX_S = 100;
/** A composer that can't vamp its way out gets at least this long, else the autopilot fills first. */
const MIN_COMPOSE_MS = 20_000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 5 * MIN;
const FORK_INTERVAL_MS = 3 * MIN;
const FORK_CLOSE_LEAD_MS = 10_000;
const MOVEMENT_AGE_MIN = 12;
const LOVED_Z = 2;
const KEEP_HOLD_BARS = 8;
const NOTES_MAX = 50;
/** Tracks kept per side for late joiners' spiral (a side normally ends long before). */
const TRACKS_MAX = 64;
const PLAYED_KEEP_MS = 30 * MIN;
const REPRISE_WINDOW_MS = 30 * MIN;
const STUCK_REQUEST_MS = 5_000;
/** After a request fails, wait this long (at least 2 bars) before asking again. */
const RETRY_AFTER_MS = 5_000;
const BOOT_ATTEMPTS = 3;
/** The checker times out its own jobs; this only guards the commit queue against a checker that never answers. */
const CHECK_TIMEOUT_MS = 8_000;
const TIMELINE_KEEP_MS = 2 * MIN;
const BASELINE_NOTE_STEP = 0.1;

const REPLAN_REASONS: ReadonlySet<PlanReason> = new Set(['crowd-pressure', 'fork-closed', 'request', 'guardrail', 'move-on', 'manual']);
const URGENT_REASONS: ReadonlySet<PlanReason> = new Set(['manual', 'move-on', 'handoff']);
const DECISION_STATUS: Record<RequestDecision['decision'], RequestStatus> = {
  'this-plan': 'planned',
  'next-movement': 'next-movement',
  'fork-option': 'fork-option',
  merged: 'merged',
  declined: 'declined',
};

export interface ConductorDeps {
  clock: RoomClock;
  crowd: Crowd;
  checker: Checker;
  store: Store;
  log: Logger;
  config: ServerConfig;
  catalog: Catalog;
  composers: { claude?: Composer; external: Composer; scripted: ScriptedComposer };
  broadcaster: Broadcaster;
  ledger?: Ledger;
  /** Wall clock for ledger windows and restart rebasing (default Date.now). */
  wallNow?: () => number;
  /** Epoch id factory (default: 4 random base-36 characters). */
  newEpoch?: () => string;
}

interface SectionMeta {
  fingerprint: SectionFingerprint | null;
  /** Request decisions this section realises (for its liner note and for revokes). */
  decisions: { requestId: string; publicReply: string }[];
  announcement: string | null;
}

interface Played {
  sectionId: string;
  role: SectionRole;
  span: BudgetSpan;
  tension: { start: number; end: number };
  ended: boolean;
}

interface Inflight {
  request: PlanRequest;
  author: DriverName;
  controller: AbortController;
  replaces: string[];
  startedAtMs: number;
  closed: boolean;
  closedAtMs: number;
  accepted: boolean;
  /** Accepted through the HTTP API rather than the composer's own tools. */
  fulfilledExternally: boolean;
  committing: number;
  rejected: number;
  /** When the deadline passed while a commit was being checked (0 = it hasn't). */
  expiredAtMs: number;
  abortReason: string | null;
  /** The section the plan follows and where it ended when the deadlines were last set. */
  anchorEnd: { id: string; cycle: number; ms: number } | null;
  /** The hard deadline it was issued with, before any Stay or Move on moved it. */
  issuedHardDeadlineMs: number;
  /** The deadline it missed was the room's: a replan's, or one a Move on pulled in (see expire). */
  roomDeadline: boolean;
}

interface CommitOptions {
  plan: unknown;
  mode: PlaceMode;
  author: DriverName;
  request: Inflight | null;
  replaces: readonly string[];
}

interface Prepared {
  placement: Placement;
  starts: number[];
  resolved: { parts: ResolvedPart[] }[];
  inputs: ReturnType<typeof checkInputFor>[];
  issues: Issue[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const errorsIn = (issues: readonly Issue[]) => issues.filter((i) => i.severity === 'error');
const warningsIn = (issues: readonly Issue[]) => issues.filter((i) => i.severity === 'warning');
const pad4 = (n: number) => String(n).padStart(4, '0');
const firstScale = (scale: string) => scale.replace(/[<>[\]]/g, ' ').trim().split(/\s+/)[0]!.slice(0, 40);
const defaultEpoch = () => {
  let id = '';
  for (const b of randomBytes(4)) id += (b % 36).toString(36);
  return id;
};

function closedResult(): CommitResult {
  return {
    accepted: false,
    errors: [{ severity: 'error', rule: 'request-closed', message: 'This planning request is closed: its deadline passed, another plan fulfilled it, or a plan was already accepted.' }],
    warnings: [],
    sections: [],
  };
}

export function createConductor(deps: ConductorDeps): Conductor {
  const { clock, crowd, checker, store, log, config, catalog, composers, broadcaster } = deps;
  const wallNow = deps.wallNow ?? Date.now;
  const ledger = deps.ledger ?? createLedger({ store, log, now: wallNow });
  const catalogIds = new Set(catalog.sounds.flatMap((s) => [s.id, ...(s.aliases ?? [])]));

  let epoch = '';
  let rev = 0;
  let sectionSeq = 0;
  let movementSeq = 0;
  let side = 0;
  let requestSeq = 0;
  let noteSeq = 0;
  let forkSeq = 0;
  let gridOrigin = 0;
  let timeline: Timeline = clock.timeline();
  let sections: SectionProgram[] = [];
  let movements: MovementState[] = [];
  let mixer: MixerState = EMPTY_MIXER;
  let notes: LinerNote[] = [];
  const meta = new Map<string, SectionMeta>();
  const started = new Set<string>();
  const sectionKeep = new Map<string, number>();
  const movementStartMs = new Map<string, number>();
  let played: Played[] = [];

  let driver: DriverName = config.driver;
  let inflight: Inflight | null = null;
  let lastAuthor: DriverName | null = null;
  let fallbackBusy = false;
  let retryNotBeforeMs = 0;
  /** A retry after a composer failure keeps the failed request's hard deadline (relative to its anchor's end). */
  let retryCap: { anchorId: string; afterEndMs: number } | null = null;
  const pendingReasons = new Set<PlanReason>();
  let lastPlanAt: number | null = null;
  let lastPlanHealth: TurnContext['health']['lastPlan'] = null;
  const healthNotes: { text: string; atMs: number }[] = [];
  const composeMs: number[] = [];
  const composeStarts: number[] = [];
  const breaker = { failures: 0, openUntil: null as number | null };
  let statusNote: string | null = null;
  let lastStatusKey = '';

  let fork: { id: string; closesAtCycle: number } | null = null;
  let lastForkAtMs: number | null = null;
  let forkAwaitingLanding: string | null = null;
  const seenClientErrors = new Set<string>();
  let boredAtMs: number | null = null;
  const crossReprises: number[] = [];
  let crate: { movementId: string; items: ReturnType<Ledger['drawCrate']> } | null = null;
  let baselineDrift = { intensity: 0, brightness: 0 };

  let queue: Promise<unknown> = Promise.resolve();
  let unsubscribeBar: (() => void) | null = null;
  let stopped = false;
  const listeners: { [E in keyof ConductorEvents]: Set<ConductorEvents[E]> } = {
    request: new Set(),
    status: new Set(),
    section: new Set(),
    revoke: new Set(),
    started: new Set(),
  };

  function emit<E extends keyof ConductorEvents>(event: E, ...args: Parameters<ConductorEvents[E]>): void {
    for (const fn of listeners[event]) {
      try {
        (fn as (...a: Parameters<ConductorEvents[E]>) => void)(...args);
      } catch (e) {
        log.error('conductor: event listener failed', { event, error: (e as Error).message });
      }
    }
  }

  function safely<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (e) {
      log.error(`conductor: ${what} failed`, { error: (e as Error).stack ?? String(e) });
      return undefined;
    }
  }

  /** Serialises every schedule-changing commit (they await the checker in between). */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  }

  // ─── Schedule queries ─────────────────────────────────────────────────────────────────────────

  const nowMs = () => clock.now();
  const nowCycle = () => cycleAtMs(timeline, nowMs());
  const movementById = (id: string | undefined) => movements.find((m) => m.id === id) ?? null;
  const sectionAt = (cycle: number) => [...sections].reverse().find((s) => s.startCycle <= cycle) ?? null;
  const currentSection = () => sectionAt(nowCycle());
  const successorOf = (s: SectionProgram) => sections[sections.indexOf(s) + 1] ?? null;
  const currentMovement = () => movementById((currentSection() ?? sections[0])?.movementId) ?? movements[0] ?? null;
  const baseline = () => currentMovement()?.baseline ?? DEFAULT_BASELINE;
  const ageMin = (m: MovementState) => {
    const at = movementStartMs.get(m.id);
    return at === undefined ? 0 : Math.max(0, (nowMs() - at) / MIN);
  };
  const barMs = () => barMsAt(timeline, nowCycle());
  const softFor = (cycle: number) => publishDeadlineMs(timeline, { startCycle: cycle, transitionIn: { type: 'cut', bars: 0 }, parts: [] }) - ACCEPT_BUDGET_MS;

  function planningLocked(): Set<string> {
    const cur = currentSection();
    const out = new Set<string>();
    if (cur) {
      out.add(cur.id);
      const next = successorOf(cur);
      if (next) out.add(next.id);
    }
    return out;
  }

  /** Provisional sections a replan may take the slot of: only the trailing run, since placement revokes everything after the first. */
  function replaceableIds(): string[] {
    const locked = planningLocked();
    const now = nowMs();
    const firm = sections.findLastIndex((s) => !s.provisional);
    return sections
      .filter((s, i) => i > firm && !locked.has(s.id) && !isHardLocked(timeline, s, now) && s.startCycle > nowCycle())
      .map((s) => s.id);
  }

  function keptFor(replaces: readonly string[]): SectionProgram[] {
    const replaceable = new Set(replaceableIds());
    const i = sections.findIndex((s) => replaces.includes(s.id) && replaceable.has(s.id));
    return i < 0 ? sections : sections.slice(0, i);
  }

  const secondsUntil = (cycle: number) => Math.max(0, (msAtCycle(timeline, cycle) - nowMs()) / 1000);

  /** Music ahead that is no longer replaceable: up to the end of the last non-provisional section. */
  function lockedHorizonSec(): number {
    const cur = currentSection();
    const locked = sections.filter((s) => !s.provisional || s === cur);
    const last = locked[locked.length - 1];
    return last ? secondsUntil(plannedEnd(last)) : 0;
  }

  function committedHorizonSec(): number {
    const last = sections[sections.length - 1];
    return last ? secondsUntil(plannedEnd(last)) : 0;
  }

  function p90ComposeMs(): number {
    if (!composeMs.length) return DEFAULT_P90_MS;
    const sorted = [...composeMs].sort((a, b) => a - b);
    return sorted[Math.floor(0.9 * (sorted.length - 1))]!;
  }

  function horizonThresholdSec(): number {
    return Math.max(HORIZON_TRIGGER_MIN_S, (p90ComposeMs() + SECTION_PRELOAD_S * 1000 + PRELOAD_BARS * barMs() + HORIZON_SLACK_MS) / 1000);
  }

  function liveMovements(): MovementInfo[] {
    const cut = nowCycle();
    const ids = new Set(sections.filter((s) => plannedEnd(s) > cut || s === sections[sections.length - 1]).map((s) => s.movementId));
    return movements
      .filter((m) => ids.has(m.id))
      .map(({ id, side: sd, name, bpm, scale, groove, arcShape, blurb, startCycle, plannedBars, tracks }) => ({ id, side: sd, name, bpm, scale, groove, arcShape, blurb, startCycle, plannedBars, tracks }));
  }

  // ─── Persistence and broadcast ────────────────────────────────────────────────────────────────

  function persist(): void {
    const session: PersistedSession = {
      version: 1,
      epoch,
      rev,
      sectionSeq,
      movementSeq,
      side,
      lastCycle: nowCycle(),
      savedAtServerMs: nowMs(),
      savedAtWallMs: wallNow(),
      timeline,
      movements,
      sections,
      mixer,
      notes,
    };
    store.writeJson(STORE_KEYS.session, session);
  }

  /** Installs a rebuilt tempo map, keeping history back to the oldest live section (tails, late joiners). */
  function setTimeline(next: Timeline): void {
    const oldest = sections[0] ? msAtCycle(next, sections[0].startCycle) : Infinity;
    timeline = pruneTimeline(next, Math.min(nowMs() - TIMELINE_KEEP_MS, oldest));
    clock.setTimeline(timeline);
  }

  /** One atomic schedule change: new rev, persisted, broadcast, and mirrored to SSE listeners. */
  function publish(upserts: SectionProgram[], revokes: string[]): void {
    rev++;
    persist();
    const update: ScheduleUpdate = { epoch, rev, timeline, movements: liveMovements(), upserts, revokes };
    broadcaster.emit('schedule', update);
    for (const s of upserts) emit('section', s);
    for (const id of revokes) emit('revoke', id);
  }

  function addNote(kind: LinerNoteKind, text: string, section: SectionProgram | null, answering: string[] = [], author: LinerNote['author'] = section?.author ?? 'room'): void {
    if (!text.trim()) return;
    const note: LinerNote = {
      id: `${epoch}-n${++noteSeq}`,
      cycle: section?.startCycle ?? Math.floor(nowCycle()),
      kind,
      text,
      sectionId: section?.id ?? null,
      answering,
      author,
    };
    notes.push(note);
    if (notes.length > NOTES_MAX) notes = notes.slice(-NOTES_MAX);
    broadcaster.emit('note', note);
  }

  function addHealthNote(text: string): void {
    healthNotes.push({ text, atMs: nowMs() });
    if (healthNotes.length > 4) healthNotes.shift();
  }

  // ─── Composer status ──────────────────────────────────────────────────────────────────────────

  const audible = () => crowd.audibleListeners(nowMs());
  const breakerOpen = () => breaker.openUntil !== null && nowMs() < breaker.openUntil;

  function composerStatus(): ComposerStatus {
    const pending = inflight && !inflight.closed ? inflight : null;
    const state: ComposerStatus['state'] = pending
      ? pending.author === 'external'
        ? 'waiting'
        : 'planning'
      : driver === 'claude' && breakerOpen()
        ? 'failed'
        : driver === 'claude' && audible() === 0
          ? 'paused'
          : 'idle';
    const next = pending ? pending.request.softDeadlineMs : nowMs() + Math.max(0, lockedHorizonSec() - horizonThresholdSec()) * 1000;
    return { driver, state, horizonSec: Math.round(lockedHorizonSec()), lastPlanAt, nextDecisionAtMs: Math.round(next), note: statusNote };
  }

  function apiStatus(): ComposerApiStatus {
    const cur = currentSection();
    const c = nowCycle();
    return {
      serverTime: nowMs(),
      epoch,
      driver,
      pending: inflight && !inflight.closed ? inflight.request : null,
      cycle: round2(c),
      bpm: round2(cpsToBpm(cpsAtCycle(timeline, c))),
      horizonSec: Math.round(lockedHorizonSec()),
      now: cur ? { id: cur.id, name: cur.name, role: cur.role, barsLeft: Math.max(0, Math.round(plannedEnd(cur) - c)) } : null,
      committed: sections.filter((s) => s.startCycle > c).map((s) => ({ id: s.id, name: s.name, startCycle: s.startCycle, provisional: s.provisional })),
    };
  }

  function emitStatus(force = false): void {
    const status = composerStatus();
    const key = JSON.stringify([status.driver, status.state, status.note, status.lastPlanAt, inflight?.request.id ?? null]);
    if (!force && key === lastStatusKey) return;
    lastStatusKey = key;
    broadcaster.emit('composer', status);
    emit('status', apiStatus());
  }

  // ─── History for budgets and dramaturgy ───────────────────────────────────────────────────────

  function spanOf(s: SectionProgram, tl: Timeline): BudgetSpan {
    const m = movementById(s.movementId);
    return {
      startMs: msAtCycle(tl, s.startCycle),
      endMs: msAtCycle(tl, plannedEnd(s)),
      bars: plannedPlayBars(s),
      intensity: s.targets.intensity,
      peakAt: peakThreshold(m?.baseline ?? DEFAULT_BASELINE),
      floorExempt: m ? isAmbient(m) : false,
    };
  }

  /** Played sections, then kept sections that haven't started, in playing order. */
  function historyEntries(kept: readonly SectionProgram[], tl: Timeline): DramaturgyEntry[] {
    const out: DramaturgyEntry[] = played.map((p) => {
      const live = kept.find((s) => s.id === p.sectionId);
      return { role: p.role, span: p.ended || !live ? p.span : { ...p.span, endMs: msAtCycle(tl, plannedEnd(live)), bars: plannedPlayBars(live) }, tension: p.tension };
    });
    for (const s of kept) if (!started.has(s.id)) out.push({ role: s.role, span: spanOf(s, tl), tension: s.targets.tension });
    return out;
  }

  const peakRunOf = (entries: readonly DramaturgyEntry[]) => {
    let n = 0;
    for (let i = entries.length - 1; i >= 0 && isPeakSpan(entries[i]!.span); i--) n++;
    return n;
  };

  // ─── Turn context ─────────────────────────────────────────────────────────────────────────────

  function crateFor(movementId: string) {
    if (crate?.movementId !== movementId) {
      crate = { movementId, items: ledger.drawCrate(movementId, catalog, { brightness: baseline().brightness }, wallNow()) };
    }
    return crate.items;
  }

  const nextMovementId = () => `${epoch}-m${movementSeq + 1}`;

  function newMovementArc(movement: MovementState | null): Arc {
    const pull = crowd.pull();
    const base = movement?.baseline ?? DEFAULT_BASELINE;
    const groove = movement?.groove ?? 'four-on-floor';
    return {
      baseline: pull.listeners > 0 ? bendBaseline(base, pull.point, pull.confidence, groove) : base,
      amplitude: ARC_AMPLITUDE.wave,
      arcShape: 'wave',
      groove,
    };
  }

  interface RequestShape {
    id: string;
    kind: 'section' | 'movement';
    reasons: PlanReason[];
    softDeadlineMs: number;
    hardDeadlineMs: number;
    targetCycle: number;
    sectionsWanted: 1 | 2;
    replaces: string[];
    vamping: boolean;
  }

  function contextFor(r: RequestShape): TurnContext {
    const now = nowMs();
    const wall = wallNow();
    const kept = keptFor(r.replaces);
    const anchor = kept[kept.length - 1] ?? null;
    const movement = anchor ? movementById(anchor.movementId) : null;
    const entries = historyEntries(kept, timeline);
    const prev = sections[0];
    return buildTurnContext({
      nowMs: now,
      timeline,
      scheduleRev: rev,
      request: r,
      sections,
      movement,
      movementAgeMin: movement ? ageMin(movement) : 0,
      newMovementArc: newMovementArc(movement),
      crowd: crowd.summary(movement?.baseline ?? DEFAULT_BASELINE, now),
      history: ledger.recent(wall - LEDGER_WINDOW_MS),
      lovedMoments: ledger.lovedMoments(wall),
      cooldown: ledger.cooldown(wall),
      flags: [
        ...ledger.flags(movement?.id ?? '', wall),
        ...(boredAtMs !== null && now - boredAtMs < 5 * MIN ? ['The room is signalling boredom: bring something new.'] : []),
      ],
      crate: crateFor(nextMovementId()),
      health: {
        lastPlan: lastPlanHealth,
        clientErrors: crowd.corroboratedErrors(prev?.startCycle ?? 0),
        notes: healthNotes.filter((n) => now - n.atMs < 10 * MIN).map((n) => n.text),
      },
      forkAllowed: forkAllowed(),
      budget: entries.map((e) => e.span),
      lastRoles: entries.map((e) => e.role).slice(-8),
      peakRun: peakRunOf(entries),
    });
  }

  /** Where the plan after `anchor` should start, and its deadlines. */
  function targetFor(anchor: SectionProgram | null, replacing: boolean) {
    const now = nowMs();
    const end = anchor ? plannedEnd(anchor) : nextPhraseLine(nowCycle() + 1, gridOrigin);
    let target = end;
    if (!replacing && (anchor?.vamp.allowed ?? true)) {
      for (let i = 0; i < 64 && softFor(target) < now + p90ComposeMs(); i++) target += PHRASE_BARS;
    }
    const soft = softFor(target);
    const hard = replacing ? soft : soft + 2 * PHRASE_BARS * barMsAt(timeline, target);
    return { target, soft, hard, vamping: anchor ? nowCycle() >= plannedEnd(anchor) : false };
  }

  // ─── Commit pipeline ──────────────────────────────────────────────────────────────────────────

  function prepare(plan: Plan, o: CommitOptions): Prepared | { error: string } {
    const placement = place({
      mode: o.mode,
      sections,
      replaces: o.replaces,
      planningLocked: planningLocked(),
      timeline,
      nowMs: nowMs(),
      shapes: plan.sections.map((s) => ({ transitionIn: s.transitionIn, parts: s.parts, bars: s.bars })),
      gridOrigin,
    });
    if ('error' in placement) return placement;
    const anchor = placement.anchor;
    const s0 = plan.sections[0]!;
    const s1 = plan.sections[1];
    const r0 = resolveSection(s0, anchor, 'sections[0]');
    const r1 = s1 ? resolveSection(s1, { name: s0.name, parts: r0.parts }, 'sections[1]') : null;
    const starts = [placement.startCycle, placement.startCycle + s0.bars];
    const bars0 = continuingPatternBars(r0.parts, anchor, starts[0]!);
    const bars1 = new Map((r1?.parts ?? []).filter((p) => p.continues).map((p) => [p.id, (bars0.get(p.id) ?? 0) + s0.bars]));
    const issues: Issue[] = [...r0.errors, ...(r1?.errors ?? [])];
    issues.push(...resolvedIssues(s0, r0.parts, 'sections[0]', anchor ? starts[0]! - anchor.startCycle : null));
    if (s1 && r1) issues.push(...resolvedIssues(s1, r1.parts, 'sections[1]', s0.bars));
    if (placement.lateBars > 0) {
      issues.push({ severity: 'warning', rule: 'lead-time', message: `Arrived late: it starts at cycle ${placement.startCycle}, ${placement.lateBars} bars after the section before it was planned to end (that section vamped meanwhile).` });
    }
    if (!placement.preload) issues.push({ severity: 'warning', rule: 'lead-time', message: 'Placed as soon as possible; listeners may not have preloaded its sounds.' });
    if (placement.lockedReplaces.length) {
      issues.push({ severity: 'warning', rule: 'stale-context', message: `Already locked, so kept: ${placement.lockedReplaces.join(', ')}; the plan follows them.` });
    }
    return {
      placement,
      starts,
      resolved: [r0, ...(r1 ? [r1] : [])],
      inputs: plan.sections.map((s, i) => checkInputFor(s, [r0, r1][i]!.parts, [bars0, bars1][i]!)),
      issues,
    };
  }

  function movementLayout(plan: Plan, anchor: SectionProgram | null) {
    const current = anchor ? movementById(anchor.movementId) : null;
    const newId = plan.movement ? nextMovementId() : null;
    return plan.sections.map((_, i) => {
      const inNew = !!plan.movement && i >= plan.movement.startsAtSection;
      return {
        movementId: inNew ? newId! : (current?.id ?? ''),
        opens: !!plan.movement && i === plan.movement.startsAtSection,
        movementBpm: inNew ? plan.movement!.bpm : (current?.bpm ?? plan.sections[i]!.bpm),
        arc: inNew ? { baseline: newMovementArc(current).baseline, groove: plan.movement!.groove } : current,
      };
    });
  }

  function evaluate(plan: Plan, prep: Prepared, checks: SectionCheck[], o: CommitOptions): Issue[] {
    const issues: Issue[] = [];
    const anchor = prep.placement.anchor;
    const layout = movementLayout(plan, anchor);
    if (layout.some((l) => !l.movementId)) {
      return [{ severity: 'error', rule: 'schema', message: 'Nothing is playing yet, so the first plan must open a movement.', path: 'movement' }];
    }
    checks.forEach((c, i) => {
      issues.push(...checkIssues(c, prep.resolved[i]!.parts, `sections[${i}]`), ...musicalIssues(plan.sections[i]!, c, `sections[${i}]`));
    });
    const current = anchor ? movementById(anchor.movementId) : null;
    issues.push(
      ...tempoIssues({
        sections: plan.sections.map((s, i) => ({
          plan: s,
          movementBpm: layout[i]!.movementBpm,
          // A cut-in (next/now) can start inside a ramp: compare with the tempo playing there.
          fromBpm: i === 0 ? (anchor ? round2(cpsToBpm(cpsAtCycle(prep.placement.timeline, prep.starts[0]! - 1e-6))) : s.bpm) : plan.sections[0]!.bpm,
          opensMovement: layout[i]!.opens,
          prevBeatless: i === 0 ? (anchor ? isBeatless(anchor.parts) : true) : isBeatless(prep.resolved[0]!.parts),
        })),
        oldMovementBpm: plan.movement && current ? current.bpm : null,
      }),
    );

    const wall = wallNow();
    const kept = prep.placement.kept;
    const recentRows = ledger.recent(wall - LEDGER_WINDOW_MS);
    const keptFingerprints = (mid: string) => kept.filter((s) => s.movementId === mid && !started.has(s.id)).map((s) => meta.get(s.id)?.fingerprint).filter((f): f is SectionFingerprint => !!f);
    while (crossReprises.length && crossReprises[0]! < wall - REPRISE_WINDOW_MS) crossReprises.shift();
    const novelty = noveltyIssues({
      sections: plan.sections.map((s, i) => ({ plan: s, fingerprint: checks[i]!.fingerprint, movementId: layout[i]!.movementId, opensMovement: layout[i]!.opens })),
      similar: (fp, mid) => ledger.similar(fp, mid, wall),
      crossReprisesRecent: crossReprises.length,
      movementFingerprints: (mid) => [...recentRows.filter((r) => r.movementId === mid).map((r) => r.fingerprint), ...keptFingerprints(mid)],
      movementSounds: (mid) =>
        new Set([
          ...recentRows.filter((r) => r.movementId === mid).flatMap((r) => r.sounds.filter((x) => x.share >= 0.02).map((x) => x.id)),
          ...keptFingerprints(mid).flatMap((f) => Object.keys(f.soundShares)),
        ]),
      cooldown: new Set(ledger.cooldown(wall)),
      signature: (mid) => (plan.movement && mid === nextMovementId() ? plan.movement.signature : (movementById(mid)?.signature ?? [])),
      crate: plan.movement ? crateFor(nextMovementId()).map((c) => c.id) : null,
    });

    plan.sections.forEach((s, i) => {
      if (s.reprise && !recentRows.some((r) => r.sectionId === s.reprise) && !sections.some((x) => x.id === s.reprise)) {
        issues.push({ severity: 'warning', rule: 'reprise', message: `reprise names "${s.reprise}", which is not a recent section.`, path: `sections[${i}].reprise` });
      }
    });
    const tlKept = prep.placement.timeline;
    const secondsPerBar = barMsAt(tlKept, prep.starts[0]!) / 1000;
    const dramaturgy = dramaturgyIssues({
      before: historyEntries(kept, tlKept),
      sections: plan.sections.map((s, i) => {
        const arc = layout[i]!.arc;
        const start = prep.starts[i]!;
        const spans = checks[i]!.mix?.spans ?? s.targets;
        return {
          role: s.role,
          span: {
            startMs: msAtCycle(tlKept, start),
            endMs: msAtCycle(tlKept, start + s.bars),
            bars: s.bars,
            intensity: s.targets.intensity,
            peakAt: peakThreshold(arc?.baseline ?? DEFAULT_BASELINE),
            floorExempt: arc ? isAmbient(arc) : false,
          },
          tension: s.targets.tension,
          plan: s,
          parts: prep.resolved[i]!.parts,
          measured: { intensity: spans.intensity, tension: spans.tension },
        };
      }),
      movementAgeMin: current ? ageMin(current) : null,
      opensMovement: !!plan.movement,
      planBars: planBarBounds(secondsPerBar),
    });
    const relaxed = o.author === 'scripted';
    issues.push(...(relaxed ? relax(novelty) : novelty), ...(relaxed ? relax(dramaturgy) : dramaturgy));
    return issues;
  }

  function rejected(issues: Issue[], o: CommitOptions): CommitResult {
    const errors = errorsIn(issues);
    if (o.request && o.request.request.scheduleRev !== rev) {
      const now = nowCycle();
      const committed = sections.filter((s) => s.startCycle > now).map((s) => `${s.id} "${s.name}" at ${s.startCycle}${s.provisional ? ' (provisional)' : ''}`);
      errors.push({
        severity: 'error',
        rule: 'stale-context',
        message: `The schedule changed since your context (rev ${o.request.request.scheduleRev} → ${rev}); committed now: ${committed.join('; ') || 'nothing after the playing section'}.`,
        hint: 'Fix the issues above against the current schedule.',
      });
    }
    return { accepted: false, errors, warnings: warningsIn(issues), sections: [] };
  }

  async function checkWithTimeout(input: Prepared['inputs'][number]): Promise<SectionCheck> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SectionCheck>((resolve) => {
      timer = setTimeout(() => {
        controller.abort('timeout');
        const issue: Issue = { severity: 'error', rule: 'timeout', message: 'Checking the section took too long; try again or simplify it.' };
        resolve({ ok: false, errors: [issue], warnings: [], parts: [], mix: null, fingerprint: null });
      }, CHECK_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([checker.checkSection(input, { priority: 'commit', signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function normalize(plan: Plan, mode: PlaceMode): Plan {
    if (mode !== 'now') return plan;
    const [first, ...rest] = plan.sections;
    return { ...plan, sections: [{ ...first!, transitionIn: { type: 'cut', bars: 0 } }, ...rest] };
  }

  async function runCommit(o: CommitOptions): Promise<CommitResult> {
    try {
      if (o.request?.closed) return closedResult();
      const parsed = PlanSchema.safeParse(o.plan);
      if (!parsed.success) {
        return rejected(parsed.error.issues.slice(0, 12).map((i) => ({ severity: 'error', rule: 'schema', message: i.message, path: i.path.join('.') })), o);
      }
      const plan = normalize(parsed.data, o.mode);
      const relaxed = o.author === 'scripted';
      const base = planIssues(plan, {
        hasRequest: (id) => crowd.hasRequest(id),
        requiredRequestIds: relaxed || !o.request ? [] : o.request.request.context.crowd.requests.map((r) => r.id),
        requestsRelaxed: relaxed,
        forkAllowed: forkAllowed(),
        catalogIds,
      });
      if (errorsIn(base).length) return rejected(base, o);

      let prep = prepare(plan, o);
      if ('error' in prep) return rejected([...base, { severity: 'error', rule: 'lead-time', message: prep.error }], o);
      if (errorsIn(prep.issues).length) return rejected([...base, ...prep.issues], o);
      const check = (p: Prepared) => Promise.all(p.inputs.map((input) => checkWithTimeout(input)));
      let checks = await check(prep);
      if (o.request?.closed) return closedResult();
      // The schedule may have moved while the checker ran (bars, Stay/Move on): place again.
      for (let attempt = 0; ; attempt++) {
        const again = prepare(plan, o);
        if ('error' in again) return rejected([...base, { severity: 'error', rule: 'lead-time', message: again.error }], o);
        if (errorsIn(again.issues).length) return rejected([...base, ...again.issues], o);
        const same = JSON.stringify(again.inputs) === JSON.stringify(prep.inputs);
        prep = again;
        if (same) break;
        if (attempt >= 1) return rejected([...base, { severity: 'error', rule: 'stale-context', message: 'The schedule kept changing while the plan was checked; commit again.' }], o);
        checks = await check(prep);
        if (o.request?.closed) return closedResult();
      }
      const issues = [...base, ...prep.issues, ...evaluate(plan, prep, checks, o)];
      if (errorsIn(issues).length) return rejected(issues, o);
      return apply(plan, prep, checks, issues, o);
    } catch (e) {
      log.error('conductor: commit failed', { error: (e as Error).stack ?? String(e) });
      return { accepted: false, errors: [{ severity: 'error', rule: 'internal', message: `The conductor failed to accept the plan: ${(e as Error).message}` }], warnings: [], sections: [] };
    }
  }

  function apply(plan: Plan, prep: Prepared, checks: SectionCheck[], issues: Issue[], o: CommitOptions): CommitResult {
    const now = nowMs();
    const { placement } = prep;
    const anchor = placement.anchor;
    const layout = movementLayout(plan, anchor);
    const author = o.author;

    let opened: MovementState | null = null;
    if (plan.movement) {
      const mp = plan.movement;
      movementSeq++;
      // Sides follow the record as it stands: one revoked before it played gives its number back.
      const keptMovements = new Set(placement.kept.map((s) => s.movementId));
      side = Math.max(0, ...movements.filter((m) => keptMovements.has(m.id)).map((m) => m.side)) + 1;
      const id = `${epoch}-m${movementSeq}`;
      const formBars = mp.form.reduce((a, f) => a + f.bars, 0);
      opened = {
        id,
        side,
        name: mp.name,
        bpm: mp.bpm,
        scale: mp.scale,
        groove: mp.groove,
        arcShape: mp.arcShape,
        blurb: mp.blurb,
        startCycle: prep.starts[mp.startsAtSection]!,
        plannedBars: mp.form.length >= 2 ? formBars : Math.round(14 * 60 * bpmToCps(mp.bpm)),
        tracks: [],
        baseline: layout[mp.startsAtSection]!.arc!.baseline,
        amplitude: ARC_AMPLITUDE[mp.arcShape],
        signature: [...mp.signature],
        palette: [...mp.palette],
        crate: crateFor(id).map((c) => c.id),
        form: [...mp.form],
        motifs: [],
        lastRationale: null,
      };
    }

    const programs: SectionProgram[] = [];
    let prev = anchor;
    plan.sections.forEach((s, i) => {
      sectionSeq++;
      const movementId = layout[i]!.movementId;
      const program = compileSection({
        id: `${epoch}-${pad4(sectionSeq)}`,
        index: (prev?.index ?? 0) + 1,
        track: prev && prev.movementId === movementId ? prev.track + 1 : (movementById(movementId)?.tracks.length ?? 0) + 1,
        movementId,
        author,
        startCycle: prep.starts[i]!,
        plan: s,
        parts: prep.resolved[i]!.parts,
        provisional: i === 1,
        prev,
        earlier: [...placement.kept, ...programs].slice(0, -1),
        check: checks[i]!,
      });
      const decisions = plan.requestDecisions.filter((d) => d.decision === 'this-plan' && d.sectionIndex === i && crowd.hasRequest(d.requestId));
      meta.set(program.id, {
        fingerprint: checks[i]!.fingerprint,
        decisions: decisions.map((d) => ({ requestId: d.requestId, publicReply: d.publicReply })),
        announcement: i === 0 ? plan.announcement : null,
      });
      if (s.reprise && checks[i]!.fingerprint && ledger.similar(checks[i]!.fingerprint!, movementId, wallNow())) crossReprises.push(wallNow());
      programs.push(program);
      prev = program;
    });

    for (const id of placement.revokes) {
      const m = meta.get(id);
      if (m?.decisions.length) crowd.applyDecisions(m.decisions.map((d) => ({ requestId: d.requestId, status: 'considered', publicReply: d.publicReply, sectionId: null })));
      meta.delete(id);
    }
    // A provisional section that now has a successor is no longer replaceable (the successor was written to follow it).
    const kept = [...placement.kept];
    const flipped: SectionProgram[] = [];
    if (anchor?.provisional && !isHardLocked(timeline, anchor, now)) {
      flipped.push({ ...anchor, provisional: false, rev: anchor.rev + 1 });
      kept[kept.length - 1] = flipped[0]!;
    }
    sections = [...kept, ...programs];
    if (opened) movements.push(opened);
    const referenced = new Set(sections.map((s) => s.movementId));
    movements = movements.filter((m) => referenced.has(m.id));

    const last = movementById(programs[programs.length - 1]!.movementId);
    if (last) {
      const ids = new Set(plan.motifs.map((m) => m.id));
      last.motifs = [...last.motifs.filter((m) => !ids.has(m.id)), ...plan.motifs.map((m) => ({ ...m, fromSectionId: programs[0]!.id }))].slice(-6);
      if (author !== 'scripted' || !last.lastRationale) last.lastRationale = plan.rationale;
    }

    setTimeline(rebuildTimeline(timeline, now, sections));
    for (const p of programs) p.tempo.fromBpm = round2(cpsToBpm(cpsAtCycle(timeline, p.startCycle - 1e-6)));
    publish([...flipped, ...programs], placement.revokes);

    const decisions = plan.requestDecisions
      .filter((d) => crowd.hasRequest(d.requestId))
      .map((d) => ({
        requestId: d.requestId,
        status: DECISION_STATUS[d.decision],
        publicReply: d.publicReply,
        sectionId: d.decision === 'this-plan' ? (programs[d.sectionIndex ?? 0]?.id ?? null) : null,
      }));
    if (decisions.length) crowd.applyDecisions(decisions);
    if (plan.fork && forkAllowed()) openFork(plan.fork);
    if (forkAwaitingLanding && author !== 'scripted') {
      crowd.setForkLanding(forkAwaitingLanding, programs[0]!.id, programs[0]!.startCycle);
      forkAwaitingLanding = null;
    }
    if (o.request) {
      o.request.closed = true;
      o.request.closedAtMs = now;
      o.request.accepted = true;
    }
    lastPlanAt = now;
    log.info('conductor: plan accepted', {
      author,
      sections: programs.map((p) => `${p.id} ${p.role} @${p.startCycle}+${p.bars}`),
      revokes: placement.revokes,
      warnings: warningsIn(issues).length,
    });
    emitStatus(true);
    return {
      accepted: true,
      errors: [],
      warnings: warningsIn(issues),
      sections: programs.map((p) => ({ id: p.id, name: p.name, startCycle: p.startCycle, bars: p.bars })),
    };
  }

  // ─── Forks ────────────────────────────────────────────────────────────────────────────────────

  function forkAllowed(): boolean {
    const now = nowMs();
    return !fork && (lastForkAtMs === null || now - lastForkAtMs >= FORK_INTERVAL_MS) && audible() > 0;
  }

  function openFork(f: NonNullable<Plan['fork']>): void {
    const opens = Math.ceil(nowCycle()) + 1;
    const triggerMs = msAtCycle(timeline, plannedEnd(sections[sections.length - 1]!)) - horizonThresholdSec() * 1000 - FORK_CLOSE_LEAD_MS;
    const closes = Math.min(opens + 64, Math.max(opens + 16, Math.round(cycleAtMs(timeline, triggerMs))));
    const id = `${epoch}-f${++forkSeq}`;
    crowd.openFork({
      id,
      prompt: f.prompt,
      options: f.options.map((o) => ({ id: o.id, label: o.label, description: o.description, kind: o.kind, requestId: o.requestId })),
      defaultOption: f.defaultOption,
      opensAtCycle: opens,
      closesAtCycle: closes,
    });
    fork = { id, closesAtCycle: closes };
    lastForkAtMs = nowMs();
  }

  // ─── Planning loop ────────────────────────────────────────────────────────────────────────────

  function plansInLastHour(): number {
    const since = nowMs() - 60 * MIN;
    while (composeStarts.length && composeStarts[0]! < since) composeStarts.shift();
    return composeStarts.length;
  }

  function chooseComposer(): { composer: Composer; author: DriverName; note: string | null } {
    const scripted = (note: string | null) => ({ composer: composers.scripted as Composer, author: 'scripted' as const, note });
    if (driver === 'external') return { composer: composers.external, author: 'external', note: 'Waiting for a composer at the terminal.' };
    if (driver === 'scripted') return scripted(null);
    if (!composers.claude) return scripted('No Claude API key: the autopilot is composing.');
    if (audible() === 0) return scripted('Claude rests while nobody is listening; the autopilot keeps the room warm.');
    if (breakerOpen()) return scripted('Claude hit trouble; the band vamps on autopilot for a few minutes.');
    if (plansInLastHour() >= config.maxPlansPerHour) return scripted('Claude is pacing itself this hour; the autopilot fills in.');
    return { composer: composers.claude, author: 'claude', note: null };
  }

  function lovedNow(): boolean {
    const cur = currentSection();
    if (cur && sectionKeep.get(cur.id) === 1) return true;
    const rows = ledger.recent(wallNow() - 15 * MIN).filter((r) => r.crowd);
    return rows.slice(-2).some((r) => r.crowd!.fireZ >= LOVED_Z);
  }

  function movementKind(anchor: SectionProgram | null): { kind: 'section' | 'movement'; aged: boolean } {
    const m = anchor ? movementById(anchor.movementId) : null;
    if (!m) return { kind: 'movement', aged: false };
    if (!movementStartMs.has(m.id)) return { kind: 'section', aged: false };
    const age = ageMin(m);
    const aged = age >= MOVEMENT_MAX_AGE_MIN || (age >= MOVEMENT_AGE_MIN && !lovedNow());
    return { kind: aged ? 'movement' : 'section', aged };
  }

  function bendForPlan(movement: MovementState | null): void {
    const pull = crowd.pull();
    if (!movement || pull.listeners === 0) return;
    const before = movement.baseline;
    movement.baseline = bendBaseline(before, pull.point, pull.confidence, movement.groove);
    baselineDrift = {
      intensity: baselineDrift.intensity + movement.baseline.intensity - before.intensity,
      brightness: baselineDrift.brightness + movement.baseline.brightness - before.brightness,
    };
    const say = (axis: 'brightness' | 'intensity', up: string, down: string) => {
      const d = baselineDrift[axis];
      if (Math.abs(d) < BASELINE_NOTE_STEP) return;
      addNote('system', `The room pulled it ${d > 0 ? up : down}.`, null, [], 'room');
      baselineDrift[axis] = 0;
    };
    say('brightness', 'brighter', 'darker');
    say('intensity', 'harder', 'calmer');
  }

  function maybePlan(): void {
    if (stopped || !sections.length) return;
    const now = nowMs();
    if (inflight) {
      if (inflight.closed && now - inflight.closedAtMs > STUCK_REQUEST_MS) {
        log.warn('conductor: a composer ignored its abort; dropping the request', { request: inflight.request.id });
        inflight = null;
      } else return;
    }
    if (fallbackBusy || now < retryNotBeforeMs) return;
    const cur = currentSection();
    // Move on asks for a successor; once one is committed, the reason is answered.
    if (cur && successorOf(cur)) pendingReasons.delete('move-on');
    const threshold = horizonThresholdSec();
    const committedSec = committedHorizonSec();
    const replaceable = replaceableIds();
    const events = [...pendingReasons];
    // Provisional sections don't count: they may still be replaced.
    const horizonDue = lockedHorizonSec() < threshold;
    const eventDue = (canReplace: boolean) =>
      events.length > 0 && (events.some((r) => URGENT_REASONS.has(r)) || canReplace || committedSec < threshold + EVENT_HORIZON_MAX_S);
    if (!horizonDue && !eventDue(replaceable.length > 0)) return;

    const choice = chooseComposer();
    let replaces = eventDue(replaceable.length > 0) && events.some((r) => REPLAN_REASONS.has(r)) ? replaceable : [];
    if (replaces.length && choice.author !== 'scripted') {
      const before = keptFor(replaces).at(-1);
      // A replan must land by the replaced slot's deadline; without time to compose it, the reasons wait for the next request.
      if (before && softFor(plannedEnd(before)) - barMs() < now + Math.max(MIN_COMPOSE_MS, p90ComposeMs())) {
        replaces = [];
        if (!horizonDue && !eventDue(false)) return;
      }
    }
    const kept = keptFor(replaces);
    const anchor = kept[kept.length - 1] ?? null;
    if (choice.author !== 'scripted' && anchor && !anchor.vamp.allowed && !replaces.length && softFor(plannedEnd(anchor)) < now + MIN_COMPOSE_MS) {
      void fallbackCommit(['guardrail']);
      return;
    }
    pendingReasons.clear();
    const { kind, aged } = movementKind(anchor);
    const reasons = [...new Set<PlanReason>([...(horizonDue ? (['horizon'] as const) : []), ...events, ...(aged ? (['movement-age'] as const) : [])])];
    if (choice.author === 'claude' && lastAuthor !== null && lastAuthor !== 'claude') reasons.push('handoff');
    issueRequest(reasons, kind, replaces, choice);
  }

  function issueRequest(reasons: PlanReason[], kind: 'section' | 'movement', replaces: string[], choice: ReturnType<typeof chooseComposer>): void {
    const now = nowMs();
    const kept = keptFor(replaces);
    const anchor = kept[kept.length - 1] ?? null;
    bendForPlan(anchor ? movementById(anchor.movementId) : null);
    const t = targetFor(anchor, replaces.length > 0);
    // A failure never lengthens the vamp: the retry has what was left of the failed request's slot.
    if (retryCap && anchor?.id === retryCap.anchorId && !replaces.length) {
      t.hard = Math.min(t.hard, msAtCycle(timeline, plannedEnd(anchor)) + retryCap.afterEndMs);
      t.soft = Math.min(t.soft, t.hard);
    }
    retryCap = null;
    const oneSectionSec = 32 * (barMsAt(timeline, t.target) / 1000);
    const sectionsWanted: 1 | 2 = kind === 'movement' || secondsUntil(t.target) + oneSectionSec < horizonThresholdSec() ? 2 : 1;
    const id = `${epoch}-r${++requestSeq}`;
    const context = contextFor({ id, kind, reasons, softDeadlineMs: t.soft, hardDeadlineMs: t.hard, targetCycle: t.target, sectionsWanted, replaces, vamping: t.vamping });
    const request: PlanRequest = { id, kind, createdAt: now, softDeadlineMs: t.soft, hardDeadlineMs: t.hard, targetCycle: t.target, scheduleRev: rev, context };
    const inf: Inflight = {
      request,
      author: choice.author,
      controller: new AbortController(),
      replaces,
      startedAtMs: now,
      closed: false,
      closedAtMs: 0,
      accepted: false,
      fulfilledExternally: false,
      committing: 0,
      rejected: 0,
      expiredAtMs: 0,
      abortReason: null,
      anchorEnd: anchor ? { id: anchor.id, cycle: plannedEnd(anchor), ms: msAtCycle(timeline, plannedEnd(anchor)) } : null,
      issuedHardDeadlineMs: t.hard,
      roomDeadline: false,
    };
    inflight = inf;
    lastAuthor = choice.author;
    statusNote = choice.note;
    if (choice.author === 'claude') composeStarts.push(now);
    // Only a real composer's turn counts as the room's requests reaching the composer.
    if (choice.author !== 'scripted') crowd.markShown(context.crowd.requests.map((r) => r.id));
    log.info('conductor: planning', { request: id, author: choice.author, kind, reasons, target: t.target, softInSec: Math.round((t.soft - now) / 1000) });
    emit('request', request);
    emitStatus(true);
    const tools = toolsFor(inf);
    void Promise.resolve()
      .then(() => choice.composer.compose(request, tools, inf.controller.signal))
      .then(
        (outcome) => finishRequest(inf, outcome),
        (e: unknown) => finishRequest(inf, { status: 'failed', reason: e instanceof Error ? e.message : String(e), attempts: 0 }),
      );
  }

  function toolsFor(inf: Inflight): ComposerTools {
    return {
      request: inf.request,
      audition: (input: AuditionInput): Promise<AuditionResult> => checker.audition(input, { priority: 'audition', signal: inf.controller.signal }),
      commit: async (plan: Plan): Promise<CommitResult> => {
        if (inf.closed) return closedResult();
        inf.committing++;
        try {
          const result = await enqueue(() => runCommit({ plan, mode: 'horizon', author: inf.author, request: inf, replaces: inf.replaces }));
          if (!result.accepted) inf.rejected++;
          return result;
        } finally {
          inf.committing--;
          if (inf.expiredAtMs && !inf.accepted && inf.committing === 0) expire(inf);
        }
      },
    };
  }

  function abortRequest(inf: Inflight, reason: 'deadline' | 'driver-switch' | 'superseded' | 'fulfilled'): void {
    if (!inf.closed) {
      inf.closed = true;
      inf.closedAtMs = nowMs();
    }
    if (inf.abortReason === null) {
      inf.abortReason = reason;
      inf.controller.abort(reason);
    }
  }

  /**
   * The deadline passed: close the request and let the autopilot fill the slot it was for. A commit
   * already being checked gets the accept budget to land first.
   */
  function expire(inf: Inflight, force = false): void {
    if (inf.accepted || inf.abortReason) return;
    if (inf.committing > 0 && !force) {
      inf.expiredAtMs ||= nowMs();
      return;
    }
    // A Move on that left less than the usual compose time made the deadline the room's, like a replan's.
    const hadMs = (inf.expiredAtMs || nowMs()) - inf.startedAtMs;
    const movedOn = inf.request.hardDeadlineMs < inf.issuedHardDeadlineMs && hadMs < p90ComposeMs();
    inf.roomDeadline = inf.replaces.length > 0 || movedOn;
    log.warn('conductor: planning request missed its deadline', { request: inf.request.id, author: inf.author, movedOn });
    abortRequest(inf, 'deadline');
    if (inf.author !== 'scripted') {
      addHealthNote(
        inf.replaces.length
          ? `Replan ${inf.request.id} missed its deadline; the provisional section stands.`
          : movedOn
            ? `Request ${inf.request.id} ran out of time after the room moved on; the autopilot filled the slot.`
            : `Request ${inf.request.id} missed its deadline; the autopilot filled the slot.`,
      );
    }
    if (!inf.replaces.length) void fallbackCommit(inf.request.context.request.reasons);
    emitStatus(true);
  }

  function finishRequest(inf: Inflight, outcome: ComposeOutcome): void {
    const now = nowMs();
    if (inf.author === 'claude') {
      // Only Claude's own finishes time a compose; one cut off by its own deadline took at least the p90 so far.
      const elapsed = outcome.usage?.ms ?? now - inf.startedAtMs;
      if (inf.abortReason === null) composeMs.push(elapsed);
      else if (inf.abortReason === 'deadline' && !inf.roomDeadline) composeMs.push(Math.max(elapsed, p90ComposeMs()));
      if (composeMs.length > 20) composeMs.shift();
      // A deadline the room set (a replan's, or one a Move on pulled in) is not a sign that Claude is failing.
      const attributable = inf.accepted ? !inf.fulfilledExternally : inf.abortReason === null || (inf.abortReason === 'deadline' && !inf.roomDeadline);
      if (attributable && inf.accepted) {
        breaker.failures = 0;
        breaker.openUntil = null;
      } else if (attributable) {
        breaker.failures++;
        if (breaker.failures >= BREAKER_FAILURES || breaker.openUntil !== null) {
          breaker.openUntil = now + BREAKER_OPEN_MS;
          breaker.failures = 0;
          addHealthNote('Claude failed repeatedly; the autopilot played for five minutes.');
          log.warn('conductor: composer breaker open', { until: breaker.openUntil });
        }
      }
    }
    if (inf.accepted) lastPlanHealth = inf.rejected > 0 ? 'repaired' : 'ok';
    else if (inf.abortReason === null || inf.abortReason === 'deadline') {
      lastPlanHealth = 'failed';
      if (outcome.status === 'failed') log.warn('conductor: composer gave up', { request: inf.request.id, author: inf.author, reason: outcome.reason });
      // The room's reasons still stand; ask again after a short pause rather than in a tight loop.
      for (const r of inf.request.context.request.reasons) if (REPLAN_REASONS.has(r)) pendingReasons.add(r);
      retryNotBeforeMs = now + Math.max(RETRY_AFTER_MS, 2 * barMs());
      const reasons = inf.request.context.request.reasons;
      if (inf.abortReason === null && !inf.replaces.length) {
        followAnchor(inf);
        const tail = sections.at(-1);
        // When the autopilot itself fails, fall through to its last resort (carrying the tail).
        if (inf.author === 'scripted') void fallbackCommit(reasons);
        else if (tail?.id === inf.anchorEnd?.id && tail?.vamp.allowed && retryNotBeforeMs + p90ComposeMs() > inf.request.hardDeadlineMs) {
          // A retry would no longer land in this slot: the autopilot takes it, the retry plans the next one.
          addHealthNote(`Request ${inf.request.id} failed with too little time left to try again; the autopilot filled the slot.`);
          void fallbackCommit(reasons);
        } else if (inf.anchorEnd) {
          retryCap = { anchorId: inf.anchorEnd.id, afterEndMs: inf.request.hardDeadlineMs - inf.anchorEnd.ms };
        }
      }
    }
    if (!inf.closed) abortRequest(inf, 'superseded');
    if (inflight === inf) inflight = null;
    emitStatus(true);
    safely('plan', maybePlan);
  }

  async function fallbackCommit(reasons: PlanReason[]): Promise<void> {
    if (fallbackBusy || stopped) return;
    fallbackBusy = true;
    try {
      const anchor = sections[sections.length - 1] ?? null;
      const t = targetFor(anchor, false);
      const ctx = contextFor({
        id: `${epoch}-fb${++requestSeq}`,
        kind: 'section',
        reasons,
        softDeadlineMs: t.soft,
        hardDeadlineMs: t.hard,
        targetCycle: t.target,
        sectionsWanted: 1,
        replaces: [],
        vamping: t.vamping,
      });
      let result: CommitResult | null = null;
      const plan = safely('fallback plan', () => composers.scripted.fallbackPlan(ctx));
      if (plan) result = await enqueue(() => runCommit({ plan, mode: 'fill', author: 'scripted', request: null, replaces: [] }));
      if (!result?.accepted && anchor) {
        log.warn('conductor: fallback plan rejected; carrying the tail', { errors: result?.errors.map((e) => `${e.rule}: ${e.message}`).slice(0, 5) });
        result = await enqueue(() => runCommit({ plan: carryPlan(anchor), mode: 'fill', author: 'scripted', request: null, replaces: [] }));
      }
      if (!result?.accepted) log.error('conductor: nothing could be committed; the tail keeps looping', { errors: result?.errors.slice(0, 5) });
      else lastAuthor = 'scripted';
    } finally {
      fallbackBusy = false;
    }
  }

  /** Stay / Move on moved the end of the section the request follows: its slot and deadlines move with it. */
  function followAnchor(inf: Inflight): void {
    const was = inf.anchorEnd;
    const anchor = was && sections.find((s) => s.id === was.id);
    if (!was || !anchor) return;
    const cycle = plannedEnd(anchor);
    const ms = msAtCycle(timeline, cycle);
    if (cycle === was.cycle && ms === was.ms) return;
    inf.request.softDeadlineMs += ms - was.ms;
    inf.request.hardDeadlineMs += ms - was.ms;
    inf.request.targetCycle += cycle - was.cycle;
    inf.anchorEnd = { id: was.id, cycle, ms };
  }

  function checkDeadlines(): void {
    const now = nowMs();
    const inf = inflight;
    if (inf && !inf.closed) {
      followAnchor(inf);
      if (inf.expiredAtMs) {
        if (now >= inf.expiredAtMs + ACCEPT_BUDGET_MS) expire(inf, true);
        return;
      }
      const kept = keptFor(inf.replaces);
      const anchor = kept[kept.length - 1] ?? null;
      const replacing = inf.replaces.length > 0;
      const vampOk = !replacing && (anchor?.vamp.allowed ?? true);
      const soft = anchor && !replacing ? Math.min(inf.request.softDeadlineMs, softFor(plannedEnd(anchor))) : inf.request.softDeadlineMs;
      if (vampOk ? now >= inf.request.hardDeadlineMs : now + barMs() >= soft) expire(inf);
      return;
    }
    if (inf || fallbackBusy) return;
    const tail = sections[sections.length - 1];
    if (tail && !tail.vamp.allowed && now + barMs() >= softFor(plannedEnd(tail))) void fallbackCommit(['guardrail']);
  }

  // ─── The bar loop ─────────────────────────────────────────────────────────────────────────────

  function fallbackFingerprint(s: SectionProgram): SectionFingerprint {
    const mean = (k: 'intensity' | 'brightness' | 'density' | 'tension') => round2((s.measured[k].start + s.measured[k].end) / 2);
    return {
      descriptors: { intensity: mean('intensity'), brightness: mean('brightness'), density: mean('density'), tension: mean('tension') },
      soundShares: {},
      kickGrid16: new Array(16).fill(0),
      backbeatGrid16: new Array(16).fill(0),
      scale: s.scale,
      bpm: s.tempo.toBpm,
      chordHash: null,
    };
  }

  function closeSection(s: SectionProgram, endCycle: number): void {
    const stats = crowd.reactionStats(s.startCycle, endCycle);
    ledger.close(s.id, wallNow(), { fireZ: stats.fire.z, boredZ: stats.bored.z, harshZ: stats.harsh.z, keep: sectionKeep.get(s.id) ?? 0 });
    crowd.markSectionPlayed(s.id);
    const p = played.find((x) => x.sectionId === s.id);
    if (p) {
      p.ended = true;
      p.span = { ...p.span, endMs: msAtCycle(timeline, endCycle), bars: Math.max(1, endCycle - s.startCycle) };
    }
  }

  function ledgerRow(s: SectionProgram, startedAtWallMs: number): LedgerRow {
    const fp = meta.get(s.id)?.fingerprint ?? fallbackFingerprint(s);
    return {
      sectionId: s.id,
      epoch,
      movementId: s.movementId,
      name: s.name,
      role: s.role,
      startedAtWallMs,
      endedAtWallMs: null,
      startCycle: s.startCycle,
      bpm: s.tempo.toBpm,
      scale: s.scale,
      sounds: Object.entries(fp.soundShares)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([id, share]) => ({ id, share })),
      fingerprint: fp,
      measured: fp.descriptors,
      parts: s.parts.map((p) => ({ id: p.id, role: p.role, code: p.code })),
      crowd: null,
      author: s.author,
      audible: audible(),
    };
  }

  function startSection(s: SectionProgram): void {
    started.add(s.id);
    const now = nowMs();
    const idx = sections.indexOf(s);
    const prev = idx > 0 ? sections[idx - 1]! : null;
    if (prev && started.has(prev.id)) closeSection(prev, s.startCycle);
    const m = meta.get(s.id);
    ledger.record(ledgerRow(s, wallNow()));
    crowd.markSectionPlaying(s.id);
    crowd.sectionStarted({ id: s.id, startCycle: s.startCycle, bars: s.bars, role: s.role });
    played.push({ sectionId: s.id, role: s.role, span: spanOf(s, timeline), tension: s.targets.tension, ended: false });
    played = played.filter((p) => !p.ended || p.span.endMs > now - PLAYED_KEEP_MS);

    const movement = movementById(s.movementId);
    if (movement) {
      if (!movementStartMs.has(movement.id)) {
        movementStartMs.set(movement.id, msAtCycle(timeline, s.startCycle));
        if (prev?.movementId !== movement.id) addNote('movement', `${movement.name}: ${movement.blurb}`, s);
      }
      movement.tracks.push({ id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: s.bars });
      if (movement.tracks.length > TRACKS_MAX) movement.tracks.splice(0, movement.tracks.length - TRACKS_MAX);
    }
    if (m?.announcement) addNote('announce', m.announcement, s);
    addNote('section', s.publicNote, s, m?.decisions.map((d) => d.requestId) ?? []);

    const upserts: SectionProgram[] = [];
    const next = sections[idx + 1];
    if (next?.provisional && !isHardLocked(timeline, next, now)) {
      const flipped = { ...next, provisional: false, rev: next.rev + 1 };
      sections[idx + 1] = flipped;
      upserts.push(flipped);
    }
    const dropped = sections.slice(0, Math.max(0, idx - 1));
    for (const d of dropped) {
      meta.delete(d.id);
      started.delete(d.id);
      sectionKeep.delete(d.id);
    }
    sections = sections.slice(Math.max(0, idx - 1));
    const referenced = new Set(sections.map((x) => x.movementId));
    movements = movements.filter((mv) => referenced.has(mv.id));
    for (const id of movementStartMs.keys()) if (!referenced.has(id)) movementStartMs.delete(id);
    publish(upserts, []);
    emit('started', s.id);
    emitStatus(true);
  }

  function processStarts(bar: number): void {
    for (const s of [...sections]) if (s.startCycle <= bar && !started.has(s.id) && sections.includes(s)) startSection(s);
  }

  /** Moves every section after `s` by `shift` bars; continuing parts re-derive where they pick up, carried knobs where they start. */
  function shiftAfter(s: SectionProgram, shift: number): SectionProgram[] {
    const idx = sections.indexOf(s);
    const moved: SectionProgram[] = [];
    let prev = s;
    for (let i = idx + 1; i < sections.length; i++) {
      const x = sections[i]!;
      const start = x.startCycle + shift;
      const parts = x.parts.map((p) => {
        const before = p.continues ? prev.parts.find((q) => q.id === p.id) : undefined;
        return { ...p, originCycle: before ? start - patternBarAt(prev, before, start) : p.originCycle + shift };
      });
      const y = withCarriedKnobs({ ...x, startCycle: start, rev: x.rev + 1, parts }, prev);
      sections[i] = y;
      moved.push(y);
      prev = y;
    }
    for (const m of movements) {
      const first = sections.find((x) => x.movementId === m.id);
      if (first && !started.has(first.id)) m.startCycle = first.startCycle;
    }
    return moved;
  }

  function handleKeep(sig: Extract<CrowdSignal, { type: 'keep' }>): void {
    const cur = currentSection();
    if (!cur || cur.id !== sig.sectionId) return;
    const outcome = decideKeep({ current: cur, next: successorOf(cur), direction: sig.direction, timeline, nowMs: nowMs(), nowCycle: nowCycle() });
    if (!outcome.ok) {
      crowd.setKeepPending({ kind: outcome.kind, heldBars: KEEP_HOLD_BARS, needBars: KEEP_HOLD_BARS, atCycle: null, blocked: outcome.blocked });
      return;
    }
    const upserts: SectionProgram[] = [];
    if (outcome.jumps !== cur.jumps) {
      const updated = { ...cur, jumps: outcome.jumps, rev: cur.rev + 1 };
      sections[sections.indexOf(cur)] = updated;
      upserts.push(updated, ...shiftAfter(updated, outcome.shift));
      setTimeline(rebuildTimeline(timeline, nowMs(), sections));
      publish(upserts, []);
    }
    if (inflight && !inflight.closed) followAnchor(inflight);
    crowd.setKeepPending({ kind: outcome.kind, heldBars: KEEP_HOLD_BARS, needBars: KEEP_HOLD_BARS, atCycle: outcome.atCycle, blocked: null });
    crowd.consumeKeep();
    sectionKeep.set(cur.id, sig.direction);
    const text =
      outcome.kind === 'extend'
        ? 'The room wants more of this: one more phrase before it ends.'
        : outcome.atCycle === null
          ? 'The room is ready to move on: the next track comes in as soon as it is written.'
          : "The room is ready to move on: heading for this track's final phrase.";
    addNote('system', text, null, [], 'room');
    log.info('conductor: keep', { section: cur.id, kind: outcome.kind, at: outcome.atCycle, shift: outcome.shift });
    if (outcome.needsPlan) pendingReasons.add('move-on');
  }

  function handleSignal(sig: CrowdSignal): void {
    switch (sig.type) {
      case 'replan-pressure':
        pendingReasons.add('crowd-pressure');
        return;
      case 'request-surge':
        pendingReasons.add('request');
        return;
      case 'bored':
        boredAtMs = nowMs();
        return;
      case 'harsh': {
        const fresh = !mixer.safety || mixer.safety.untilCycle <= nowCycle();
        mixer = withSafety(mixer, Math.ceil(cycleAtMs(timeline, nowMs() + MIN_CHANGE_LEAD_S * 1000 + ACCEPT_MARGIN_MS)));
        broadcaster.emit('mixer', mixer);
        if (fresh) addNote('system', 'Easing off for a moment: the room found that a bit much.', null, [], 'room');
        addHealthNote('Listeners flagged the sound as harsh; a safety trim was applied.');
        return;
      }
      case 'keep':
        handleKeep(sig);
        return;
    }
  }

  function mixerStep(): void {
    const now = nowMs();
    const earliest = Math.ceil(cycleAtMs(timeline, now + MIN_CHANGE_LEAD_S * 1000 + ACCEPT_MARGIN_MS));
    const next = mixerTick({ state: mixer, nowCycle: nowCycle(), earliestCycle: earliest, pull: crowd.pull() });
    if (!next) return;
    mixer = next;
    broadcaster.emit('mixer', mixer);
  }

  function forkTick(bar: number): void {
    if (!fork || bar < fork.closesAtCycle) return;
    const result = crowd.closeFork();
    fork = null;
    if (result) {
      forkAwaitingLanding = result.forkId;
      pendingReasons.add('fork-closed');
    }
  }

  function guardrailTick(): void {
    const since = sections[0]?.startCycle ?? 0;
    const live = new Set(sections.map((s) => s.id));
    for (const key of seenClientErrors) if (!live.has(key.split('|')[0]!)) seenClientErrors.delete(key);
    for (const e of crowd.corroboratedErrors(since)) {
      // Live ids only: the prune above drops any other key, which would then fire on every tick.
      if (!namesScheduledPart(sections, e)) continue;
      const key = `${e.sectionId}|${e.partId}|${e.code}`;
      if (seenClientErrors.has(key)) continue;
      seenClientErrors.add(key);
      pendingReasons.add('guardrail');
      addHealthNote(`Listeners' browsers report "${e.code}" for part ${e.partId} of ${e.sectionId}.`);
    }
  }

  function onBar(bar: number): void {
    if (stopped) return;
    safely('section start', () => processStarts(bar));
    const signals = safely('crowd tick', () => crowd.tick(bar, nowMs(), baseline())) ?? [];
    for (const sig of signals) safely(`signal ${sig.type}`, () => handleSignal(sig));
    safely('fork', () => forkTick(bar));
    if (bar % 4 === 0) safely('guardrails', guardrailTick);
    safely('mixer', mixerStep);
    safely('deadlines', checkDeadlines);
    safely('planning', maybePlan);
    safely('status', () => emitStatus());
  }

  // ─── Boot and restore ─────────────────────────────────────────────────────────────────────────

  function restoredCheckInput(s: SectionProgram) {
    return {
      parts: s.parts.map((p) => ({
        id: p.id,
        role: p.role,
        code: p.code,
        knobs: p.knobs,
        chromatic: p.chromatic,
        level: p.level,
        enterBar: p.enterBar,
        exitBar: p.exitBar,
        patternBarAtStart: s.startCycle - p.originCycle,
      })),
      bpm: s.tempo.toBpm,
      scale: s.scale,
      bars: s.bars,
    };
  }

  /** Warm restore when the committed horizon still covers downtime + preload; returns the last cycle otherwise. */
  async function tryRestore(): Promise<{ restored: true } | { restored: false; lastCycle: number | null }> {
    const saved = store.readJson<PersistedSession>(STORE_KEYS.session);
    if (saved?.version !== 1 || !Array.isArray(saved.sections) || !saved.timeline?.segments?.length) return { restored: false, lastCycle: null };
    const now = nowMs();
    const shift = now - wallNow() - (saved.savedAtServerMs - saved.savedAtWallMs);
    const tl: Timeline = { segments: saved.timeline.segments.map((s) => ({ ...s, startMs: s.startMs + shift })) };
    const c = cycleAtMs(tl, now);
    const lastCycle = Math.max(saved.lastCycle, Number.isFinite(c) ? c : 0);
    const ordered = [...saved.sections].sort((a, b) => a.startCycle - b.startCycle);
    const tail = ordered[ordered.length - 1];
    const need = now + SECTION_PRELOAD_S * 1000 + PRELOAD_BARS * barMsAt(tl, c) + ACCEPT_BUDGET_MS;
    // A new epoch never closes the rows of what was playing when the last one stopped.
    const closeStopped = () => {
      for (const s of saved.sections) if (s.startCycle <= saved.lastCycle) ledger.close(s.id, saved.savedAtWallMs, null);
    };
    if (!tail || !(c >= saved.lastCycle - 1e-6) || msAtCycle(tl, plannedEnd(tail)) < need) {
      log.info('conductor: previous session too old to resume', { epoch: saved.epoch });
      closeStopped();
      return { restored: false, lastCycle };
    }
    const extents = sectionExtents(ordered);
    const currentIdx = extents.findIndex((e) => e.section.startCycle <= c && c < e.endCycle);
    const current = currentIdx >= 0 ? ordered[currentIdx]! : null;
    const live = ordered.slice(Math.max(0, currentIdx - 1));
    const kept: SectionProgram[] = [];
    const checks = new Map<string, SectionCheck>();
    for (const s of live) {
      const result = await checkWithTimeout(restoredCheckInput(s));
      if (!result.ok) {
        log.warn('conductor: a restored section failed re-validation; dropping it and what follows', { section: s.id, errors: result.errors.slice(0, 3) });
        break;
      }
      kept.push(s);
      checks.set(s.id, result);
    }
    if (current ? !kept.includes(current) : !kept.length) {
      closeStopped();
      return { restored: false, lastCycle };
    }

    epoch = saved.epoch;
    rev = saved.rev;
    sectionSeq = saved.sectionSeq;
    movementSeq = saved.movementSeq;
    side = saved.side;
    sections = kept.map((s) => {
      const check = checks.get(s.id)!;
      const trims = balanceTrims(s.parts, s.parts.map((p) => check.parts.find((x) => x.id === p.id)));
      // Programs persisted before trims moved onto their parts get them from the re-check.
      return { ...s, parts: s.parts.map((p) => ({ ...p, trimDb: p.trimDb ?? trims[p.id] ?? 0 })) };
    });
    const referenced = new Set(kept.map((s) => s.movementId));
    movements = saved.movements.filter((m) => referenced.has(m.id));
    mixer = saved.mixer ?? EMPTY_MIXER;
    notes = (saved.notes ?? []).slice(-NOTES_MAX);
    noteSeq = notes.reduce((n, x) => Math.max(n, Number(/-n(\d+)$/.exec(x.id)?.[1] ?? 0)), 0);
    gridOrigin = ordered[0]!.startCycle;
    timeline = tl;
    for (const s of sections) {
      meta.set(s.id, { fingerprint: checks.get(s.id)!.fingerprint, decisions: [], announcement: null });
      if (s.startCycle <= c) {
        started.add(s.id);
        played.push({ sectionId: s.id, role: s.role, span: spanOf(s, tl), tension: s.targets.tension, ended: s.id !== current?.id });
      }
    }
    for (const m of movements) if (m.startCycle <= c) movementStartMs.set(m.id, msAtCycle(tl, m.startCycle));
    // Sections that started during the downtime get their rows (closing the one playing at the stop).
    for (const s of ordered) if (s.startCycle <= c) ledger.record(ledgerRow(s, wallNow() - (now - msAtCycle(tl, s.startCycle))));
    setTimeline(rebuildTimeline(tl, now, sections));
    log.info('conductor: warm restore', { epoch, sections: sections.length, shiftMs: Math.round(shift) });
    return { restored: true };
  }

  function withMovement(plan: Plan): Plan {
    if (plan.movement) return plan;
    const s = plan.sections[0]!;
    return {
      ...plan,
      movement: {
        name: s.name,
        startsAtSection: 0,
        bpm: s.bpm,
        scale: firstScale(s.scale),
        groove: s.parts.some((p) => p.role === 'kick') ? 'four-on-floor' : 'free',
        arcShape: 'wave',
        form: [],
        palette: [],
        signature: [],
        blurb: s.publicNote.slice(0, 200),
      },
    };
  }

  async function bootFresh(lastCycle: number | null): Promise<void> {
    epoch = (deps.newEpoch ?? defaultEpoch)();
    rev = 0;
    sectionSeq = 0;
    movementSeq = 0;
    side = 0;
    gridOrigin = lastCycle === null ? 0 : Math.ceil(lastCycle) + 8;
    timeline = createTimeline(nowMs(), bpmToCps(DEFAULT_BPM), gridOrigin);
    clock.setTimeline(timeline);
    sections = [];
    movements = [];
    mixer = { ...EMPTY_MIXER, next: { ...EMPTY_MIXER.next, atCycle: gridOrigin } };
    notes = [];
    let last: CommitResult | null = null;
    for (let attempt = 1; attempt <= BOOT_ATTEMPTS && !last?.accepted; attempt++) {
      const target = nextPhraseLine(nowCycle() + 1, gridOrigin);
      const ctx = contextFor({
        id: `${epoch}-boot${attempt}`,
        kind: 'movement',
        reasons: ['boot'],
        softDeadlineMs: nowMs(),
        hardDeadlineMs: nowMs(),
        targetCycle: target,
        sectionsWanted: 1,
        replaces: [],
        vamping: false,
      });
      const plan = safely('boot plan', () => withMovement(composers.scripted.fallbackPlan(ctx)));
      if (!plan) continue;
      last = await enqueue(() => runCommit({ plan, mode: 'boot', author: 'scripted', request: null, replaces: [] }));
      if (!last.accepted) log.warn('conductor: boot section rejected', { attempt, errors: last.errors.slice(0, 5) });
    }
    if (!last?.accepted) throw new Error(`conductor: no boot section could be committed (${last?.errors.map((e) => `${e.rule}: ${e.message}`).join('; ')})`);
    lastAuthor = 'scripted';
    log.info('conductor: new epoch', { epoch, startCycle: gridOrigin });
  }

  // ─── The Conductor ────────────────────────────────────────────────────────────────────────────

  return {
    async start() {
      stopped = false;
      const restore = await tryRestore();
      if (!restore.restored) await bootFresh(restore.lastCycle);
      else publish([], []);
      clock.setTimeline(timeline);
      unsubscribeBar?.();
      unsubscribeBar = clock.onBar(onBar);
      clock.start();
      const cur = currentSection();
      if (cur && started.has(cur.id)) {
        crowd.markSectionPlaying(cur.id);
        crowd.sectionStarted({ id: cur.id, startCycle: cur.startCycle, bars: cur.bars, role: cur.role });
      }
      emitStatus(true);
    },

    async stop() {
      stopped = true;
      unsubscribeBar?.();
      unsubscribeBar = null;
      if (inflight) abortRequest(inflight, 'superseded');
      await queue.catch(() => undefined);
      if (epoch) persist();
    },

    snapshot(): SnapshotBase {
      return { epoch, rev, timeline, movements: liveMovements(), sections: [...sections], mixer, notes: [...notes], composer: composerStatus() };
    },

    apiStatus,

    previewContext(): TurnContext {
      const now = nowMs();
      if (inflight && !inflight.closed) {
        const r = inflight.request;
        const ctx = r.context;
        return {
          ...ctx,
          request: {
            ...ctx.request,
            softDeadlineSec: Math.max(0, Math.round((r.softDeadlineMs - now) / 1000)),
            hardDeadlineSec: Math.max(0, Math.round((r.hardDeadlineMs - now) / 1000)),
            startCycle: r.targetCycle,
          },
        };
      }
      const anchor = sections[sections.length - 1] ?? null;
      const t = targetFor(anchor, false);
      return contextFor({
        id: 'preview',
        kind: movementKind(anchor).kind,
        reasons: ['manual'],
        softDeadlineMs: t.soft,
        hardDeadlineMs: t.hard,
        targetCycle: t.target,
        sectionsWanted: 1,
        replaces: [],
        vamping: t.vamping,
      });
    },

    audition: (input) => checker.audition(input, { priority: 'audition' }),

    async commit(body: CommitBody, author: DriverName): Promise<CommitResult> {
      const mode = body.mode ?? 'horizon';
      const inf = inflight && !inflight.closed && body.requestId === inflight.request.id ? inflight : null;
      const notes: Issue[] = body.requestId && !inf ? [{ severity: 'warning', rule: 'stale-context', message: `Request ${body.requestId} is not pending; committed as an ad-hoc plan.` }] : [];
      if (inf) inf.committing++;
      let result: CommitResult;
      try {
        result = await enqueue(() => runCommit({ plan: body.plan, mode, author, request: inf, replaces: inf && mode === 'horizon' ? inf.replaces : [] }));
      } finally {
        if (inf) inf.committing--;
      }
      if (inf && result.accepted) {
        inf.fulfilledExternally = true;
        abortRequest(inf, 'fulfilled');
      } else if (inf) {
        inf.rejected++;
        if (inf.expiredAtMs && inf.committing === 0) expire(inf);
      }
      if (result.accepted && !inf && mode !== 'horizon' && inflight && !inflight.closed) abortRequest(inflight, 'superseded');
      if (result.accepted) safely('plan', maybePlan);
      return { ...result, warnings: [...notes, ...result.warnings] };
    },

    async setDriver(next: DriverName): Promise<ComposerApiStatus> {
      if (next === 'claude' && !composers.claude) log.warn('conductor: driver set to claude without an API key; the autopilot composes');
      const changed = next !== driver;
      driver = next;
      if (changed && inflight && !inflight.closed) abortRequest(inflight, 'driver-switch');
      if (changed) pendingReasons.add('handoff');
      statusNote = null;
      emitStatus(true);
      safely('plan', maybePlan);
      return apiStatus();
    },

    requestPlan(reason: PlanReason): void {
      pendingReasons.add(reason);
      safely('plan', maybePlan);
    },

    needle(): PadPoint {
      return needlePoint(currentSection(), nowCycle(), mixer);
    },

    on(event, listener) {
      const set = listeners[event] as Set<typeof listener>;
      set.add(listener);
      return () => void set.delete(listener);
    },
  };
}
