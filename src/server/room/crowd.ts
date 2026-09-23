// The crowd (docs/ARCHITECTURE.md §8): listener identity and weight, rate limits, the pull pad,
// Stay/Move-on ballots, reactions, requests, fork votes and telemetry. It never calls the
// conductor: the conductor polls tick() once per bar, reads summary()/pull() and reports which
// requests a composer saw (markShown). The crowd emits `crowd` frames (4 Hz) and per-listener
// `fork`, `requests` and system notes through the Broadcaster; main.ts drives its lifecycle.
import type { CrowdSummary } from '../../shared/composer-api.ts';
import { RATE_LIMITS, REACTIONS, type EtchType, type Reaction, HEARTBEAT_STALE_MS } from '../../shared/music.ts';
import {
  HEARD_CYCLE_WINDOW,
  type CrowdFrame,
  type ForkState,
  type KeepPending,
  type NackReason,
  type PadPoint,
  type RequestAck,
  type RequestError,
} from '../../shared/protocol.ts';
import { sanitizeRequestText } from '../../shared/text.ts';
import type { Broadcaster, CrowdRuntime, CrowdSignal, CrowdSource, Logger, Nack, ServerConfig, Store } from '../types.ts';
import { STORE_KEYS } from '../types.ts';
import { aggregateKeep, aggregatePad, capByNetwork, type KeepAggregate, type PadAggregate, type Voice } from './aggregate.ts';
import { createBucket, KeyedBuckets, take, type Bucket, type Rate } from './buckets.ts';
import { serverNow } from './clock.ts';
import { createIdentity, hueOf, networkKey } from './identity.ts';
import { CROWD, roomSlewPerSec, roomTauSec } from './params.ts';
import { RequestBook, type RequestRecord } from './requests.ts';
import { TelemetryStore } from './telemetry.ts';

export interface CrowdTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

type BucketName = 'pad' | 'keep' | 'reaction' | 'request' | 'vote' | 'telemetry' | 'heartbeat';
const RATES: Record<BucketName, Rate> = {
  pad: RATE_LIMITS.pad,
  keep: RATE_LIMITS.keep,
  reaction: RATE_LIMITS.reaction,
  request: RATE_LIMITS.request,
  vote: RATE_LIMITS.vote,
  telemetry: RATE_LIMITS.telemetry,
  heartbeat: CROWD.heartbeatRate,
};

interface SocketBeat {
  audible: boolean;
  visible: boolean;
  at: number;
}

interface Listener {
  id: string;
  hue: number;
  network: string;
  sockets: Map<string, SocketBeat>;
  /** Audible listening accrued up to accruedAt. */
  audibleMs: number;
  accruedAt: number;
  disconnectedAt: number | null;
  pad: { point: PadPoint; at: number } | null;
  ballot: { v: 1 | -1; sectionId: string; at: number } | null;
  buckets: Record<BucketName, Bucket>;
  /** Last counted reaction window per type (one per type per 4-bar window). */
  counted: Map<Reaction, number>;
  sampled: boolean;
}

interface ReactionRecord {
  type: Reaction;
  etch: EtchType;
  cycle: number;
  at: number;
  listenerId: string;
  network: string;
  weight: number;
  hue: number;
}

interface SectionMark {
  id: string;
  startCycle: number;
}

interface Fork {
  id: string;
  prompt: string;
  options: (ForkState['options'][number] & { requestId: string | null })[];
  defaultOption: 'A' | 'B' | 'C';
  opensAtCycle: number;
  closesAtCycle: number;
  ballots: Map<string, 'A' | 'B' | 'C'>;
  result: ForkState['result'];
  closed: { tally: Record<string, number>; turnout: number } | null;
  resolvesForSectionId: string | null;
  landsAtCycle: number | null;
}

interface PersistedIdentity {
  version: 1;
  listeners: [id: string, audibleMs: number, seenAt: number][];
}

const nack = (event: string, reason: NackReason): Nack => ({ event, reason });
const refuse = (error: RequestError): RequestAck => ({ ok: false, error });
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
const MAX_REACTIONS = 50_000;
const REACTION_KEEP_MS = 30 * 60_000;
const MAX_SECTION_MARKS = 32;
const MAX_BAR_MARKS = 4096;
const HOUSEKEEPING_MS = 5_000;
const MAX_SMOOTHING_GAP_S = 120;
const SMOOTHING_STEP_S = 0.25;
const DEFAULT_BAR_MS = 2000;

export function createCrowd(opts: {
  broadcaster: Broadcaster;
  config: ServerConfig;
  store: Store;
  log: Logger;
  now?: () => number;
  timers?: CrowdTimers;
}): CrowdRuntime {
  const { broadcaster, config, store, log } = opts;
  const now = opts.now ?? serverNow;
  const timers: CrowdTimers = opts.timers ?? { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const identity = createIdentity(config.secret);
  const listeners = new Map<string, Listener>();
  const socketOwner = new Map<string, string>();
  /** Ids of listeners with no socket left, per network, in the order they left. */
  const detached = new Map<string, Set<string>>();
  const book = new RequestBook();
  const telemetryStore = new TelemetryStore();
  const roomRequests = createBucket(CROWD.requests.roomRate, now());
  const networkRequests = new KeyedBuckets(CROWD.requests.networkRate);
  const known = loadIdentities();

  let reactions: ReactionRecord[] = [];
  const baselines = Object.fromEntries(
    REACTIONS.map((r) => [r, { mean: CROWD.reactionPrior.mean, variance: CROWD.reactionPrior.sd ** 2 }]),
  ) as Record<Reaction, { mean: number; variance: number }>;
  const sections: SectionMark[] = [];
  let current: SectionMark | null = null;
  const barMarks = new Map<number, { ms: number; weight: number }>();
  let lastTick: { bar: number; ms: number } | null = null;
  let barMs = DEFAULT_BAR_MS;

  // Smoothed state and hysteresis.
  let pull: PadPoint = { x: 0, y: 0 };
  let keep = 0;
  let smoothedAt = now();
  let lastPad: PadAggregate = aggregatePad([]);
  let lastKeep: KeepAggregate = { value: 0, effectiveVoices: 0 };
  let lastListeners = 0;
  /** Present listeners with each network counted as at most networkWeightCap (the n_eff quorums' N). */
  let lastVoices = 0;
  let lastNetworks = 0;
  /** Σ w over present listeners: the audience reactions are measured against. */
  let lastWeight = 0;
  let pressureHeld = 0;
  let lastReplanBar = -Infinity;
  let keepHeld = 0;
  let keepPending: KeepPending | null = null;
  let lastHarshBar = -Infinity;
  let lastHarshAt = -Infinity;
  let boredSignalled = false;

  let fork: Fork | null = null;
  let forkDirty = false;
  let lastForkEmit = -Infinity;

  let source: CrowdSource | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastFrameKey = '';
  let lastFrameAt = -Infinity;
  let lastHousekeeping = -Infinity;
  let lastPersist = now();
  let identitiesDirty = false;

  // Weight cache: invalidated whenever listener state changes or time moves.
  let stateVersion = 0;
  let weightCache: { at: number; version: number; weights: Map<Listener, number> } | null = null;

  // ─── Identity persistence ─────────────────────────────────────────────────────────────────────

  function loadIdentities(): Map<string, { audibleMs: number; seenAt: number }> {
    const out = new Map<string, { audibleMs: number; seenAt: number }>();
    try {
      const data = store.readJson<PersistedIdentity>(STORE_KEYS.identity);
      if (data?.version === 1 && Array.isArray(data.listeners)) {
        for (const row of data.listeners) {
          if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]) && Number.isFinite(row[2])) {
            out.set(row[0], { audibleMs: clamp(row[1], 0, CROWD.trustRampMs), seenAt: row[2] });
          }
        }
      }
    } catch (err) {
      log.warn('could not read listener identities; starting fresh', { err });
    }
    return out;
  }

  /** Keeps a listener's trust for their return. Identities that never warmed up aren't kept, so churn can't push out those that did. */
  function remember(l: Listener, t: number): boolean {
    const audibleMs = Math.min(audibleMsAt(l, t), CROWD.trustRampMs);
    if (audibleMs < CROWD.warmupMs) return false;
    known.set(l.id, { audibleMs, seenAt: t });
    return true;
  }

  function persist(): void {
    const t = now();
    for (const l of listeners.values()) remember(l, t);
    const rows = [...known.entries()]
      .filter(([, v]) => t - v.seenAt <= CROWD.identity.maxAgeMs)
      .sort((a, b) => b[1].seenAt - a[1].seenAt)
      .slice(0, CROWD.identity.keep);
    known.clear();
    for (const [id, v] of rows) known.set(id, v);
    try {
      store.writeJson<PersistedIdentity>(STORE_KEYS.identity, {
        version: 1,
        listeners: rows.map(([id, v]) => [id, Math.round(v.audibleMs), Math.round(v.seenAt)]),
      });
      identitiesDirty = false;
      lastPersist = t;
    } catch (err) {
      log.warn('could not persist listener identities', { err });
    }
  }

  // ─── Listener weight ──────────────────────────────────────────────────────────────────────────

  function audibleUntil(l: Listener): number {
    let until = -Infinity;
    for (const b of l.sockets.values()) if (b.audible) until = Math.max(until, b.at + HEARTBEAT_STALE_MS);
    return until;
  }

  function audibleMsAt(l: Listener, t: number): number {
    return l.audibleMs + Math.max(0, Math.min(t, audibleUntil(l)) - l.accruedAt);
  }

  /** Folds audible time up to `t`; call before changing a listener's sockets or heartbeats. */
  function accrue(l: Listener, t: number): void {
    l.audibleMs = audibleMsAt(l, t);
    l.accruedAt = Math.max(l.accruedAt, t);
  }

  function presence(l: Listener, t: number): number {
    let p = 0;
    for (const b of l.sockets.values()) {
      if (b.audible && t - b.at <= HEARTBEAT_STALE_MS) p = Math.max(p, b.visible ? 1 : CROWD.hiddenPresence);
    }
    return p;
  }

  function trust(l: Listener, t: number): number {
    return Math.min(1, CROWD.trustStart + ((1 - CROWD.trustStart) * audibleMsAt(l, t)) / CROWD.trustRampMs);
  }

  const eligible = (l: Listener, t: number) => audibleMsAt(l, t) >= CROWD.warmupMs;

  /** w = trust × presence, capped per network. Only listeners with w > 0 are present. */
  function weights(t: number): Map<Listener, number> {
    if (weightCache && weightCache.at === t && weightCache.version === stateVersion) return weightCache.weights;
    const raw = new Map<Listener, number>();
    for (const l of listeners.values()) {
      const p = presence(l, t);
      if (p > 0) raw.set(l, trust(l, t) * p);
    }
    const capped = capByNetwork(raw, (l) => l.network, CROWD.networkWeightCap);
    weightCache = { at: t, version: stateVersion, weights: capped };
    return capped;
  }

  const weightOfId = (t: number) => {
    const w = weights(t);
    return (listenerId: string) => {
      const l = listeners.get(listenerId);
      return l ? (w.get(l) ?? 0) : 0;
    };
  };

  // ─── Aggregation and smoothing ────────────────────────────────────────────────────────────────

  function livePad(l: Listener, t: number): PadPoint | null {
    return l.pad && t - l.pad.at < CROWD.padRelaxMs && eligible(l, t) ? l.pad.point : null;
  }

  function advance(t: number): void {
    const w = weights(t);
    const padVoices: Voice<PadPoint>[] = [];
    const keepVoices: Voice<1 | -1>[] = [];
    const heads = new Map<string, number>();
    let present = 0;
    for (const [l, weight] of w) {
      const point = livePad(l, t);
      padVoices.push({ weight, value: point, freshness: point ? Math.exp(-(t - l.pad!.at) / CROWD.padFreshMs) : 0, network: l.network });
      const ballot = l.ballot && current && l.ballot.sectionId === current.id && eligible(l, t) ? l.ballot : null;
      keepVoices.push({ weight, value: ballot?.v ?? null, freshness: ballot ? Math.exp(-(t - ballot.at) / CROWD.keepFreshMs) : 0, network: l.network });
      heads.set(l.network, (heads.get(l.network) ?? 0) + 1);
      present += weight;
    }
    lastVoices = 0;
    for (const n of heads.values()) lastVoices += Math.min(n, CROWD.networkWeightCap);
    lastNetworks = heads.size;
    lastWeight = present;
    const pad = aggregatePad(padVoices);
    const ballots = aggregateKeep(keepVoices);
    if (t > smoothedAt) {
      const dt = Math.min(MAX_SMOOTHING_GAP_S, (t - smoothedAt) / 1000);
      const tau = roomTauSec(w.size);
      const slew = roomSlewPerSec(w.size);
      for (let left = dt; left > 1e-9; left -= SMOOTHING_STEP_S) {
        const h = Math.min(SMOOTHING_STEP_S, left);
        const a = 1 - Math.exp(-h / tau);
        pull = {
          x: pull.x + clamp(a * (pad.target.x - pull.x), -slew * h, slew * h),
          y: pull.y + clamp(a * (pad.target.y - pull.y), -slew * h, slew * h),
        };
      }
      keep += (1 - Math.exp(-dt / (CROWD.keepTauMs / 1000))) * (ballots.value - keep);
    }
    smoothedAt = Math.max(smoothedAt, t);
    lastPad = pad;
    lastKeep = ballots;
    lastListeners = w.size;
  }

  function confidence(): number {
    return lastPad.participants.length ? Math.sqrt(lastPad.turnout) * lastPad.consensus : 0;
  }

  // ─── Bars, sections, reactions ────────────────────────────────────────────────────────────────

  function msAtBar(bar: number): number {
    const mark = barMarks.get(bar);
    if (mark) return mark.ms;
    return lastTick ? lastTick.ms + (bar - lastTick.bar) * barMs : bar * barMs;
  }

  /** Mean present weight over [from, to): sockets crowding in from one network add at most its cap. */
  function audienceOver(from: number, to: number): number {
    let sum = 0;
    let n = 0;
    for (let bar = Math.ceil(from); bar < to; bar++) {
      const mark = barMarks.get(bar);
      if (mark) {
        sum += mark.weight;
        n++;
      }
    }
    return n ? sum / n : lastWeight;
  }

  function sectionAt(cycle: number): SectionMark | null {
    for (let i = sections.length - 1; i >= 0; i--) if (sections[i]!.startCycle <= cycle) return sections[i]!;
    return null;
  }

  /**
   * Weighted reactions per listener per minute over [from, to), against the room's present weight
   * (a room of full-weight listeners: its head count). Beyond the one-per-4-bar-window rule, one
   * listener contributes at most one reaction per minute, so a single enthusiast can't manufacture
   * a loved moment (or a safety trim) on their own.
   */
  function rates(from: number, to: number) {
    const minutes = Math.max(0, msAtBar(to) - msAtBar(from)) / 60_000;
    const audience = audienceOver(from, to);
    const perListener = new Map<string, { type: Reaction; listenerId: string; network: string; count: number; weight: number }>();
    for (const r of reactions) {
      if (r.cycle < from || r.cycle >= to) continue;
      const key = `${r.type}\u0000${r.listenerId}`;
      const entry = perListener.get(key) ?? { type: r.type, listenerId: r.listenerId, network: r.network, count: 0, weight: 0 };
      entry.count++;
      entry.weight += r.weight;
      perListener.set(key, entry);
    }
    const cap = Math.max(1, minutes * CROWD.reactionMaxPerListenerPerMin);
    const sums = Object.fromEntries(REACTIONS.map((r) => [r, 0])) as Record<Reaction, number>;
    const reporters = Object.fromEntries(REACTIONS.map((r) => [r, { listeners: new Set<string>(), networks: new Set<string>() }])) as Record<
      Reaction,
      { listeners: Set<string>; networks: Set<string> }
    >;
    for (const e of perListener.values()) {
      sums[e.type] += e.weight * Math.min(1, cap / e.count);
      reporters[e.type].listeners.add(e.listenerId);
      reporters[e.type].networks.add(e.network);
    }
    const perMin = (type: Reaction) => sums[type] / Math.max(1, audience) / Math.max(minutes, CROWD.reactionMinMinutes);
    return { minutes, audience, perMin, reporters };
  }

  const zOf = (type: Reaction, rate: number) =>
    (rate - baselines[type].mean) / Math.max(Math.sqrt(baselines[type].variance), CROWD.reactionMinSd);

  function reactionStats(fromCycle: number, toCycle: number): CrowdSummary['reactions'] {
    const r = rates(fromCycle, toCycle);
    return Object.fromEntries(
      REACTIONS.map((type) => {
        const rate = r.perMin(type);
        return [type, { perListenerPerMin: round(rate), z: round(zOf(type, rate), 2) }];
      }),
    ) as CrowdSummary['reactions'];
  }

  /** Folds a finished section's reaction rates into the 15-minute EW baseline. */
  function closeSection(section: SectionMark, endCycle: number): void {
    const r = rates(section.startCycle, endCycle);
    if (r.minutes <= 0 || r.audience <= 0) return;
    const a = 1 - Math.exp(-(r.minutes * 60_000) / CROWD.reactionBaselineMs);
    for (const type of REACTIONS) {
      const b = baselines[type];
      const d = r.perMin(type) - b.mean;
      b.mean += a * d;
      b.variance = (1 - a) * (b.variance + a * d * d);
    }
  }

  function inHeardWindow(heard: number, cycle: number): boolean {
    return heard >= cycle - HEARD_CYCLE_WINDOW.behind && heard <= cycle + HEARD_CYCLE_WINDOW.ahead;
  }

  /** Counts a reaction (≤ 1 per type per listener per 4-bar window) from a listener who may steer. */
  function count(l: Listener, type: Reaction, etch: EtchType, heardCycle: number, t: number): void {
    if (!eligible(l, t)) return;
    const weight = weights(t).get(l) ?? 0;
    if (weight <= 0) return;
    const window = Math.floor(heardCycle / CROWD.reactionWindowBars);
    if ((l.counted.get(type) ?? -Infinity) >= window) return;
    l.counted.set(type, window);
    reactions.push({ type, etch, cycle: heardCycle, at: t, listenerId: l.id, network: l.network, weight, hue: l.hue });
    if (reactions.length > MAX_REACTIONS) reactions.splice(0, reactions.length - MAX_REACTIONS);
  }

  // ─── Emission ─────────────────────────────────────────────────────────────────────────────────

  const connected = () => [...listeners.values()].filter((l) => l.sockets.size > 0);

  function sendCards(listenerIds: Iterable<string>): void {
    for (const id of new Set(listenerIds)) {
      if (listeners.get(id)?.sockets.size) broadcaster.toListener(id, 'requests', book.cardsFor(id));
    }
  }

  const sendCardsToSupporters = (records: RequestRecord[]) => sendCards(records.flatMap((r) => [...r.supporters.keys()]));
  const sendCardsToAll = () => sendCards(connected().map((l) => l.id));

  function forkTally(f: Fork, t: number): { tally: Record<string, number>; turnout: number } {
    if (f.closed) return f.closed;
    const w = weights(t);
    let total = 0;
    for (const weight of w.values()) total += weight;
    const shares: Record<string, number> = Object.fromEntries(f.options.map((o) => [o.id, 0]));
    let cast = 0;
    for (const [listenerId, option] of f.ballots) {
      const l = listeners.get(listenerId);
      if (!l || !eligible(l, t)) continue;
      const weight = w.get(l) ?? 0;
      shares[option] = (shares[option] ?? 0) + weight;
      cast += weight;
    }
    for (const id of Object.keys(shares)) shares[id] = cast > 0 ? round(shares[id]! / cast) : 0;
    return { tally: shares, turnout: total > 0 ? round(cast / total) : 0 };
  }

  function forkView(f: Fork, listenerId: string, tally: { tally: Record<string, number>; turnout: number }): ForkState {
    return {
      id: f.id,
      prompt: f.prompt,
      options: f.options.map(({ id, label, description, kind }) => ({ id, label, description, kind })),
      opensAtCycle: f.opensAtCycle,
      closesAtCycle: f.closesAtCycle,
      tally: tally.tally,
      turnout: tally.turnout,
      myVote: f.ballots.get(listenerId) ?? null,
      result: f.result,
      resolvesForSectionId: f.resolvesForSectionId,
      landsAtCycle: f.landsAtCycle,
    };
  }

  function sendForkToAll(): void {
    const t = now();
    const tally = fork ? forkTally(fork, t) : null;
    for (const l of connected()) broadcaster.toListener(l.id, 'fork', fork && tally ? forkView(fork, l.id, tally) : null);
    forkDirty = false;
    lastForkEmit = t;
  }

  function cycleNow(): number | null {
    if (source) {
      try {
        return source.cycle();
      } catch {
        // fall through to the last bar the conductor reported
      }
    }
    return lastTick?.bar ?? null;
  }

  function keepPendingView(): KeepPending | null {
    if (keepPending) return keepPending.atCycle !== null ? keepPending : { ...keepPending, heldBars: Math.max(keepPending.heldBars, keepHeld) };
    if (keepHeld > 0) {
      return { kind: keep > 0 ? 'extend' : 'shorten', heldBars: keepHeld, needBars: CROWD.keepHoldBars, atCycle: null, blocked: null };
    }
    return null;
  }

  function frame(cycle: number, needle: PadPoint): CrowdFrame {
    const t = now();
    advance(t);
    const w = weights(t);
    const ghosts = [...w.keys()]
      .filter((l) => livePad(l, t))
      .sort((a, b) => b.pad!.at - a.pad!.at)
      .slice(0, CROWD.maxGhosts)
      .map((l) => ({ x: quantize(l.pad!.point.x), y: quantize(l.pad!.point.y), hue: l.hue }));
    const etches: CrowdFrame['etches'] = [];
    // Reactions are stored in arrival order and heardCycle lies within the heard window of its
    // arrival, so once one is this far back, every earlier one is older than the etch window.
    const horizon = cycle - CROWD.etchBars - HEARD_CYCLE_WINDOW.behind - HEARD_CYCLE_WINDOW.ahead;
    for (let i = reactions.length - 1; i >= 0 && etches.length < CROWD.maxEtches && reactions[i]!.cycle >= horizon; i--) {
      const r = reactions[i]!;
      if (r.cycle >= cycle - CROWD.etchBars && r.cycle <= cycle + HEARD_CYCLE_WINDOW.ahead) etches.push({ type: r.etch, cycle: round(r.cycle, 2), hue: r.hue });
    }
    const split = lastPad.split;
    return {
      cycle,
      listeners: lastListeners,
      pull: { x: round(pull.x), y: round(pull.y) },
      needle: { x: round(needle.x), y: round(needle.y) },
      turnout: round(lastPad.turnout),
      consensus: round(lastPad.consensus),
      split: split ? { axis: split.axis, low: round(split.low), high: round(split.high) } : null,
      keep: round(keep),
      keepPending: keepPendingView(),
      ghosts,
      etches: etches.reverse(),
      requestsWaiting: book.waiting(),
    };
  }

  const quantize = (v: number) => round(Math.round(v / CROWD.ghostStep) * CROWD.ghostStep, 2);

  // ─── Housekeeping ─────────────────────────────────────────────────────────────────────────────

  function housekeeping(t: number): void {
    lastHousekeeping = t;
    const expired = book.expire(t);
    if (expired.length) sendCardsToSupporters(expired);
    const cycle = cycleNow() ?? 0;
    for (const r of book.unseen(t)) {
      for (const listenerId of r.supporters.keys()) {
        if (!listeners.get(listenerId)?.sockets.size) continue;
        broadcaster.toListener(listenerId, 'note', {
          id: `sys-${r.id}`,
          cycle,
          kind: 'system',
          text: "Your request hasn't reached the composer yet. It stays open until it expires.",
          sectionId: null,
          answering: [r.id],
          author: 'room',
        });
      }
    }
    for (const l of listeners.values()) {
      if (l.sockets.size === 0 && l.disconnectedAt !== null && t - l.disconnectedAt > CROWD.forgetAfterMs) forget(l, t);
    }
    const cutoff = t - REACTION_KEEP_MS;
    if (reactions.length && reactions[0]!.at < cutoff) reactions = reactions.filter((r) => r.at >= cutoff);
    telemetryStore.prune(t);
    if (fork?.result && cycleNow() !== null && (fork.landsAtCycle ?? fork.closesAtCycle) + 32 < cycle) {
      fork = null;
      sendForkToAll();
    }
    if ((identitiesDirty || listeners.size) && t - lastPersist >= CROWD.identity.persistEveryMs) persist();
  }

  function pump(): void {
    try {
      const t = now();
      if (source) {
        const next = frame(source.cycle(), source.needle());
        const key = JSON.stringify({ ...next, cycle: 0 });
        if (key !== lastFrameKey || t - lastFrameAt >= CROWD.frameKeepaliveMs) {
          broadcaster.emit('crowd', next);
          lastFrameKey = key;
          lastFrameAt = t;
        }
      } else advance(t);
      if (forkDirty && t - lastForkEmit >= CROWD.forkTallyMs) sendForkToAll();
      if (t - lastHousekeeping >= HOUSEKEEPING_MS) housekeeping(t);
    } catch (err) {
      log.error('crowd pump failed', { err });
    }
  }

  function owner(socketId: string): Listener | null {
    const id = socketOwner.get(socketId);
    return id ? (listeners.get(id) ?? null) : null;
  }

  function newListener(id: string, network: string, t: number): Listener {
    const restored = known.get(id);
    return {
      id,
      hue: hueOf(id),
      network,
      sockets: new Map(),
      audibleMs: restored?.audibleMs ?? 0,
      accruedAt: t,
      disconnectedAt: null,
      pad: null,
      ballot: null,
      buckets: Object.fromEntries(Object.entries(RATES).map(([k, rate]) => [k, createBucket(rate, t)])) as Record<BucketName, Bucket>,
      counted: new Map(),
      sampled: false,
    };
  }

  function canSample(l: Listener): boolean {
    let total = 0;
    let sameNetwork = 0;
    for (const other of listeners.values()) {
      if (!other.sampled || other.sockets.size === 0) continue;
      total++;
      if (other.network === l.network) sameNetwork++;
    }
    return total < CROWD.telemetry.maxSampled && sameNetwork < CROWD.telemetry.maxSampledPerNetwork;
  }

  function detach(socketId: string, t: number): void {
    const l = owner(socketId);
    socketOwner.delete(socketId);
    if (!l) return;
    accrue(l, t);
    l.sockets.delete(socketId);
    if (l.sockets.size === 0) {
      l.disconnectedAt = t;
      l.sampled = false;
      park(l, t);
    }
    stateVersion++;
  }

  /**
   * A listener who left keeps their identity for forgetAfterMs, but one network keeps at most
   * maxDetachedPerNetwork of them (the longest gone are forgotten first): reconnecting over and over
   * without a token can't fill the room.
   */
  function park(l: Listener, t: number): void {
    const parked = detached.get(l.network) ?? new Set<string>();
    parked.add(l.id);
    detached.set(l.network, parked);
    for (const id of parked) {
      if (parked.size <= CROWD.maxDetachedPerNetwork) break;
      const gone = listeners.get(id);
      if (gone) forget(gone, t);
      else parked.delete(id);
    }
  }

  function unpark(l: Listener): void {
    const parked = detached.get(l.network);
    if (parked?.delete(l.id) && parked.size === 0) detached.delete(l.network);
  }

  function forget(l: Listener, t: number): void {
    if (remember(l, t)) identitiesDirty = true;
    unpark(l);
    listeners.delete(l.id);
    telemetryStore.forget(l.id);
    book.forget(l.id);
    stateVersion++;
  }

  const limited = (l: Listener, bucket: BucketName, t: number) => !take(l.buckets[bucket], RATES[bucket], t);

  // ─── The Crowd ────────────────────────────────────────────────────────────────────────────────

  return {
    join(socketId, hello, address, nowMs) {
      const bound = owner(socketId);
      // One socket is one listener: a repeated hello (a resync) gets the listener it already has.
      if (bound) return { listenerId: bound.id, hue: bound.hue, token: identity.issue(hello.anonId, bound.id, nowMs), telemetry: bound.sampled };
      const verified = identity.verify(hello.anonId, hello.token, nowMs);
      const existing = verified ? listeners.get(verified) : undefined;
      if (!existing && listeners.size >= CROWD.maxListeners) return nack('hello', 'room-full');
      if (existing && existing.sockets.size >= CROWD.maxSocketsPerListener) return nack('hello', 'too-many-tabs');
      const network = networkKey(address, config.ipv6Prefix);
      const listenerId = verified ?? identity.newListenerId();
      const l = existing ?? newListener(listenerId, network, nowMs);
      unpark(l);
      listeners.set(l.id, l);
      accrue(l, nowMs);
      l.network = network;
      l.disconnectedAt = null;
      l.sockets.set(socketId, { audible: false, visible: true, at: -Infinity });
      socketOwner.set(socketId, l.id);
      if (!l.sampled) l.sampled = canSample(l);
      stateVersion++;
      return { listenerId: l.id, hue: l.hue, token: identity.issue(hello.anonId, l.id, nowMs), telemetry: l.sampled };
    },

    leave(socketId, nowMs) {
      detach(socketId, nowMs);
    },

    heartbeat(socketId, hb, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('heartbeat', 'hello-first');
      if (limited(l, 'heartbeat', nowMs)) return nack('heartbeat', 'rate-limited');
      accrue(l, nowMs);
      l.sockets.set(socketId, { audible: hb.audible, visible: hb.visible, at: nowMs });
      stateVersion++;
      return null;
    },

    pad(socketId, p, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('pad', 'hello-first');
      if (limited(l, 'pad', nowMs)) return nack('pad', 'rate-limited');
      // A released puck at dead centre withdraws the listener's pull (the puck relaxed home).
      l.pad = !p.active && p.x === 0 && p.y === 0 ? null : { point: { x: p.x, y: p.y }, at: nowMs };
      return null;
    },

    keep(socketId, k, cycle, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('keep', 'hello-first');
      if (!inHeardWindow(k.heardCycle, cycle)) return nack('keep', 'heard-cycle');
      if (limited(l, 'keep', nowMs)) return nack('keep', 'rate-limited');
      if (sectionAt(k.heardCycle)?.id !== k.sectionId) return nack('keep', 'wrong-section');
      if (current?.id !== k.sectionId) return nack('keep', 'section-ended');
      l.ballot = { v: k.v, sectionId: k.sectionId, at: nowMs };
      if (k.v > 0) count(l, 'vibe', 'stay', k.heardCycle, nowMs);
      else count(l, 'bored', 'move', k.heardCycle, nowMs);
      return null;
    },

    react(socketId, r, cycle, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('react', 'hello-first');
      if (!inHeardWindow(r.heardCycle, cycle)) return nack('react', 'heard-cycle');
      if (limited(l, 'reaction', nowMs)) return nack('react', 'rate-limited');
      count(l, r.type, r.type, r.heardCycle, nowMs);
      return null;
    },

    request(socketId, r, nowMs) {
      const l = owner(socketId);
      if (!l) return refuse('hello-first');
      const text = sanitizeRequestText(r.text);
      if (!text) return refuse('empty');
      if (!eligible(l, nowMs)) return refuse('too-early');
      if (limited(l, 'request', nowMs)) return refuse('rate-limited');
      if (!networkRequests.take(l.network, nowMs)) return refuse('room-busy');
      if (!take(roomRequests, CROWD.requests.roomRate, nowMs)) return refuse('room-busy');
      const { record } = book.submit(l.id, text, nowMs);
      sendCardsToSupporters([record]);
      return { ok: true, id: record.id };
    },

    vote(socketId, v, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('vote', 'hello-first');
      if (limited(l, 'vote', nowMs)) return nack('vote', 'rate-limited');
      if (!fork || fork.id !== v.forkId) return nack('vote', 'no-fork');
      if (fork.result) return nack('vote', 'closed');
      if (!fork.options.some((o) => o.id === v.option)) return nack('vote', 'invalid-option');
      fork.ballots.set(l.id, v.option);
      broadcaster.toListener(l.id, 'fork', forkView(fork, l.id, forkTally(fork, nowMs)));
      forkDirty = true;
      return null;
    },

    telemetry(socketId, t, nowMs) {
      const l = owner(socketId);
      if (!l) return nack('telemetry', 'hello-first');
      if (!l.sampled) return nack('telemetry', 'not-sampled');
      if (limited(l, 'telemetry', nowMs)) return nack('telemetry', 'rate-limited');
      const cycle = cycleNow();
      if (cycle !== null && (t.cycle < cycle - 2 * CROWD.etchBars || t.cycle > cycle + 2)) return nack('telemetry', 'heard-cycle');
      telemetryStore.add(l.id, l.network, t, nowMs);
      return null;
    },

    tick(bar, nowMs, baseline) {
      if (lastTick && bar <= lastTick.bar) return [];
      if (lastTick && bar === lastTick.bar + 1 && nowMs > lastTick.ms) barMs += 0.2 * (nowMs - lastTick.ms - barMs);
      lastTick = { bar, ms: nowMs };
      advance(nowMs);
      barMarks.set(bar, { ms: nowMs, weight: lastWeight });
      if (barMarks.size > MAX_BAR_MARKS) barMarks.delete(barMarks.keys().next().value!);

      const signals: CrowdSignal[] = [];
      const n = lastListeners;

      // Early replan: strong, sustained pressure against the movement baseline.
      const dx = pull.x - (2 * baseline.brightness - 1);
      const dy = pull.y - (2 * baseline.intensity - 1);
      const magnitude = Math.max(Math.abs(dx), Math.abs(dy));
      const quorum = (q: number) => Math.max(1, Math.min(q, lastVoices));
      if (n > 0 && magnitude > CROWD.pressureOn && lastPad.effectiveVoices >= quorum(CROWD.pressureQuorum)) pressureHeld++;
      else if (magnitude < CROWD.pressureOff) pressureHeld = 0;
      if (pressureHeld >= CROWD.pressureHoldBars && bar - lastReplanBar >= CROWD.replanCooldownBars) {
        const axis = Math.abs(dx) >= Math.abs(dy) ? 'brightness' : 'intensity';
        signals.push({ type: 'replan-pressure', axis, pressure: round(clamp(axis === 'brightness' ? dx : dy, -1, 1)) });
        lastReplanBar = bar;
        pressureHeld = 0;
      }

      // Stay / Move on: repeats every bar while the lean holds, until consumeKeep() or the next section.
      if (current && Math.abs(keep) > CROWD.keepOn && lastKeep.effectiveVoices >= quorum(CROWD.keepQuorum)) keepHeld++;
      else keepHeld = 0;
      if (current && keepHeld >= CROWD.keepHoldBars) signals.push({ type: 'keep', direction: keep > 0 ? 1 : -1, sectionId: current.id });

      if (current) {
        const r = rates(current.startCycle, bar + 1);
        // Distinct reporters, and on distinct networks unless the whole room shares one.
        const enoughReporters = (type: Reaction) =>
          r.reporters[type].listeners.size >= Math.min(2, Math.max(1, n)) && r.reporters[type].networks.size >= Math.min(2, Math.max(1, lastNetworks));
        // A repeat trim needs fresh evidence: at least one Too much since the last one.
        const harsh = reactions.filter((x) => x.type === 'harsh' && x.at > lastHarshAt);
        if (harsh.length && bar - lastHarshBar >= CROWD.harshCooldownBars) {
          const recent = new Set(harsh.filter((x) => x.cycle >= bar - CROWD.harshWindowBars).map((x) => x.listenerId));
          // A share of the room's (network-capped) weight, not of heads.
          const w = weights(nowMs);
          let reported = 0;
          for (const id of recent) {
            const l = listeners.get(id);
            if (l) reported += w.get(l) ?? 0;
          }
          const share = lastWeight > 0 ? reported / lastWeight : 0;
          if (share >= CROWD.harshShare || (enoughReporters('harsh') && zOf('harsh', r.perMin('harsh')) >= CROWD.reactionZ)) {
            signals.push({ type: 'harsh' });
            lastHarshBar = bar;
            lastHarshAt = nowMs;
          }
        }
        if (!boredSignalled && enoughReporters('bored') && zOf('bored', r.perMin('bored')) >= CROWD.reactionZ) {
          signals.push({ type: 'bored' });
          boredSignalled = true;
        }
      }

      const weightOf = weightOfId(nowMs);
      for (const record of book.undecided()) {
        if (!record.surged && book.support(record, weightOf, nowMs) >= CROWD.requests.surgeSupport) {
          record.surged = true;
          signals.push({ type: 'request-surge', requestId: record.id });
        }
      }
      return signals;
    },

    frame,

    summary(baseline, nowMs) {
      advance(nowMs);
      const split = lastPad.split;
      const toUnit = (v: number) => round((v + 1) / 2);
      return {
        listeners: lastListeners,
        pad: {
          brightness: toUnit(pull.x),
          intensity: toUnit(pull.y),
          turnout: round(lastPad.turnout),
          consensus: round(lastPad.consensus),
          effectiveVoices: round(lastPad.effectiveVoices, 1),
          split: split ? { axis: split.axis === 'x' ? 'brightness' : 'intensity', low: toUnit(split.low), high: toUnit(split.high) } : null,
        },
        pressure: {
          brightness: round(clamp(pull.x - (2 * baseline.brightness - 1), -1, 1)),
          intensity: round(clamp(pull.y - (2 * baseline.intensity - 1), -1, 1)),
        },
        keepVsMoveOn: round(keep),
        reactions: reactionStats(current?.startCycle ?? lastTick?.bar ?? 0, (lastTick?.bar ?? 0) + 1),
        requests: book.top(weightOfId(nowMs), nowMs),
        promises: book.promises(nowMs),
        forkResult: fork?.result && fork.closed && !fork.resolvesForSectionId ? forkResultOf(fork) : null,
      };
    },

    markShown(requestIds) {
      const changed = book.markShown(requestIds, now());
      if (changed.length) sendCardsToSupporters(changed);
    },

    pull() {
      advance(now());
      return { point: { ...pull }, confidence: confidence(), listeners: lastListeners };
    },

    audibleListeners(nowMs) {
      let n = 0;
      for (const l of listeners.values()) if (presence(l, nowMs) > 0) n++;
      return n;
    },

    telemetryDigest(fromCycle, toCycle) {
      return telemetryStore.digest(fromCycle, toCycle);
    },

    corroboratedErrors(sinceCycle) {
      const t = now();
      const isTrusted = (id: string) => {
        const l = listeners.get(id);
        return Boolean(l && trust(l, t) >= CROWD.telemetry.trustedTrust);
      };
      return telemetryStore.corroborated(sinceCycle, isTrusted);
    },

    reactionStats,

    sectionStarted(section) {
      if (current?.id === section.id) return;
      if (current) closeSection(current, section.startCycle);
      current = { id: section.id, startCycle: section.startCycle };
      sections.push(current);
      if (sections.length > MAX_SECTION_MARKS) sections.shift();
      for (const l of listeners.values()) l.ballot = null;
      keep = 0;
      keepHeld = 0;
      keepPending = null;
      boredSignalled = false;
    },

    setKeepPending(p) {
      keepPending = p;
    },

    consumeKeep() {
      for (const l of listeners.values()) l.ballot = null;
      keep = 0;
      keepHeld = 0;
    },

    hasRequest: (id) => book.has(id),

    applyDecisions(decisions) {
      const t = now();
      let changed = false;
      for (const d of decisions) {
        if (book.decide(d, t)) changed = true;
        else log.debug('decision for an unknown request', { requestId: d.requestId });
      }
      if (changed) sendCardsToAll();
    },

    markSectionPlaying(sectionId) {
      if (book.markSection(sectionId, 'playing').length) sendCardsToAll();
    },

    markSectionPlayed(sectionId) {
      if (book.markSection(sectionId, 'played').length) sendCardsToAll();
    },

    openFork(f) {
      fork = { ...f, options: f.options.map((o) => ({ ...o })), ballots: new Map(), result: null, closed: null, resolvesForSectionId: null, landsAtCycle: null };
      sendForkToAll();
    },

    closeFork() {
      if (!fork || fork.result) return null;
      const t = now();
      const { tally, turnout } = forkTally(fork, t);
      const ranked = fork.options.map((o) => ({ id: o.id, share: tally[o.id] ?? 0 })).sort((a, b) => b.share - a.share);
      const top = ranked[0]!;
      const tied = ranked.length > 1 && ranked[1]!.share === top.share;
      const F = CROWD.fork;
      const binding = !tied && top.share >= F.bindingShare && turnout >= F.bindingTurnout;
      const advisory = !tied && top.share >= F.advisoryShare && turnout >= F.advisoryTurnout;
      fork.result = { option: binding || advisory ? top.id : fork.defaultOption, binding };
      fork.closed = { tally, turnout };
      sendForkToAll();
      return forkResultOf(fork);
    },

    setForkLanding(forkId, sectionId, landsAtCycle) {
      if (fork?.id !== forkId) return;
      fork.resolvesForSectionId = sectionId;
      fork.landsAtCycle = landsAtCycle;
      sendForkToAll();
    },

    requestCardsFor: (listenerId) => book.cardsFor(listenerId),

    forkFor(listenerId) {
      return fork ? forkView(fork, listenerId, forkTally(fork, now())) : null;
    },

    listenerIdOf: (socketId) => socketOwner.get(socketId) ?? null,

    start(s) {
      source = s;
      if (timer) return;
      timer = timers.setInterval(pump, CROWD.frameMs);
      (timer as { unref?: () => void } | null)?.unref?.();
    },

    stop() {
      if (timer) timers.clearInterval(timer);
      timer = null;
    },

    persist,
  };

  function forkResultOf(f: Fork): NonNullable<CrowdSummary['forkResult']> {
    const option = f.options.find((o) => o.id === f.result!.option);
    return {
      forkId: f.id,
      option: f.result!.option,
      label: option?.label ?? f.result!.option,
      binding: f.result!.binding,
      turnout: f.closed?.turnout ?? 0,
      requestId: option?.requestId ?? null,
    };
  }
}
