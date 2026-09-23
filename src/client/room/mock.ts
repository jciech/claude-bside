// `?mock`: the whole room without a server. The real engine performs an endless schedule built from
// test/fixtures/snapshot.json on a local clock, and a small simulation stands in for everyone else:
// a drifting crowd on the pad, reactions etched at the rim, a scripted fork vote, requests that move
// through their lifecycle, liner notes at every track, and Stay / Move on that really edit the
// schedule. Outgoing gestures are accepted locally with the feedback the server would give.
import { CATALOG_URL } from '../../shared/catalog.ts';
import { bpmToCps, RATE_LIMITS, type DockReaction, type EtchType } from '../../shared/music.ts';
import type { MixerState, SectionProgram } from '../../shared/program.ts';
import type { ComposerStatus, CrowdFrame, ForkState, KeepPending, LinerNote, PadPoint, RequestCard, RoomSnapshot, ScheduleUpdate } from '../../shared/protocol.ts';
import { KEEP_PHRASE_BARS, plannedPlayBars, scoreBarAt } from '../../shared/schedule.ts';
import { sanitizeRequestText } from '../../shared/text.ts';
import { createTimeline, cycleAtMs, msAtCycle } from '../../shared/timeline.ts';
import { createEngine } from '../engine/engine.ts';
import type { ClockSync, Engine, EngineOptions } from '../engine/types.ts';
import { TokenBucket } from '../ui/cooldown.ts';
import { sideLetter } from '../ui/format.ts';
import { applyScheduleUpdate, applySnapshotToStores, appendNote, pruneSections, recordEtch, sectionAtCycle } from '../ui/stores.ts';
import { MockScore } from './mock-score.ts';
import type { RequestResult, Room, RoomOptions } from './types.ts';

/** Where the mock room is when the page opens: six bars into the second track. */
export const MOCK_START_CYCLE = 22;
const BPM = 120;
const FRAME_MS = 250;
const POLL_MS = 100;
const OTHERS = 18;
const SILENT_PRIOR = 0.25;
const ETCH_BARS = 16;
const NO_STAY = new Set(['intro', 'build', 'transition']);

type Timer = ReturnType<typeof setInterval>;

function localClock(): ClockSync {
  const now = () => performance.timeOrigin + performance.now();
  return {
    serverNow: now,
    offsetMs: () => 0,
    rttMs: () => 0,
    jitterMs: () => 0,
    ready: Promise.resolve(),
    onStep: () => () => {},
    resync: () => {},
    stop: () => {},
  };
}

/** Small seeded PRNG so the mock crowd looks the same on every load (screenshots, tests). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const q05 = (v: number) => Math.round(v * 20) / 20;

interface Other {
  home: PadPoint;
  pos: PadPoint;
  hue: number;
  active: boolean;
  phase: number;
  vote: 'A' | 'B' | 'C' | null;
  leaning: 'A' | 'B' | 'C';
}

export interface MockDeps {
  createEngine: (options: EngineOptions) => Engine;
  fixture: () => Promise<RoomSnapshot>;
}

const defaultDeps: MockDeps = {
  createEngine,
  fixture: async () => (await import('../../../test/fixtures/snapshot.json')).default as unknown as RoomSnapshot,
};

export async function createMockRoom(options: RoomOptions, overrides: Partial<MockDeps> = {}): Promise<Room> {
  const deps: MockDeps = { ...defaultDeps, ...overrides };
  const fixture = await deps.fixture();
  const { stores } = options;
  const rand = prng(7);
  const clock = localClock();
  const cps = bpmToCps(BPM);
  const timeline = createTimeline(clock.serverNow() - (MOCK_START_CYCLE / cps) * 1000, cps, 0);
  const cycleNow = () => cycleAtMs(timeline, clock.serverNow());
  const you = { hue: fixture.you.hue };

  const score = new MockScore(fixture);
  const ensureAhead = (now: number): SectionProgram[] => {
    const added: SectionProgram[] = [];
    while (score.sections.filter((s) => s.startCycle > now).length < 2) added.push(score.append().section);
    // The next track is locked in; the one after stays provisional (replaceable) until it's next.
    const next = score.sections.find((s) => s.startCycle > now);
    const committed = next ? score.commit(next.id) : null;
    if (committed) added.push(committed);
    for (const s of score.sections) if (s.startCycle <= now && s.provisional) added.push(score.commit(s.id)!);
    return dedupeById(added);
  };
  ensureAhead(MOCK_START_CYCLE);

  const engine = deps.createEngine({ catalogUrl: CATALOG_URL, clock });
  let rev = 1;
  let mixer: MixerState = fixture.mixer;

  // ─── Initial state ────────────────────────────────────────────────────────────────────────────

  const current0 = sectionAtCycle(score.sections, MOCK_START_CYCLE)!;
  const publicCards: RequestCard[] = [
    { id: 'mock-p1', mine: false, text: null, status: 'playing', supporters: 3, publicReply: 'More space in the low end: the kick steps back whenever the bass moves', sectionId: current0.id, createdAt: Date.now() - 240_000 },
    { id: 'mock-p2', mine: false, text: null, status: 'declined', supporters: 1, publicReply: 'Keeping 120 BPM for this side — the next one can run faster', sectionId: null, createdAt: Date.now() - 400_000 },
  ];
  const mine: RequestCard[] = [];
  /** The bar each of the listener's own requests was made at. */
  const requestBars = new Map<string, number>();
  let notes: LinerNote[] = score.sections
    .filter((s) => s.startCycle <= MOCK_START_CYCLE)
    .map((s) => ({ id: `mock-n-${s.id}`, cycle: s.startCycle, kind: 'section', text: s.publicNote, sectionId: s.id, answering: s.id === current0.id ? ['mock-p1'] : [], author: 'claude' }));

  const others: Other[] = Array.from({ length: OTHERS }, (_, i) => {
    const home = { x: clamp(0.25 + (rand() - 0.5) * 0.9), y: clamp(0.1 + (rand() - 0.5) * 0.8) };
    const r = rand();
    return { home, pos: { ...home }, hue: ((i * 7) % 12) * 30 + 15, active: rand() > 0.3, phase: rand() * Math.PI * 2, vote: null, leaning: r < 0.45 ? 'A' : r < 0.8 ? 'B' : 'C' };
  });
  let myPad: { point: PadPoint; active: boolean; at: number } | null = null;
  let pull: PadPoint = { x: 0.2, y: -0.05 };
  let needle: PadPoint = { x: -0.1, y: -0.2 };
  let mood: PadPoint = { x: 0, y: 0 };
  let etches: CrowdFrame['etches'] = [];
  let waiting = 3;
  let lastFrameAt = performance.now();

  let ballot: { v: 1 | -1; sectionId: string } | null = null;
  let keepPending: KeepPending | null = null;
  let keep = 0;

  let fork: ForkState | null = null;
  let forkSeq = 0;
  const votes = new TokenBucket(RATE_LIMITS.vote, performance.now());
  let nextForkAt = Math.floor(MOCK_START_CYCLE) - 2;

  const composerState = (state: ComposerStatus['state'], now: number): ComposerStatus => {
    const next = score.sections.find((s) => s.startCycle > now);
    return {
      driver: 'claude',
      state,
      horizonSec: Math.max(0, (score.endCycle() - now) / cps),
      lastPlanAt: Date.now(),
      nextDecisionAtMs: state === 'idle' && next ? msAtCycle(timeline, Math.max(now + 4, next.startCycle - 8)) : null,
      note: null,
    };
  };

  openFork(MOCK_START_CYCLE - 3);
  const snapshot: RoomSnapshot = {
    epoch: 'mock',
    rev,
    serverTime: clock.serverNow(),
    timeline,
    movements: score.movementsAt(MOCK_START_CYCLE),
    sections: pruneSections(score.sections, MOCK_START_CYCLE),
    mixer,
    crowd: frame(MOCK_START_CYCLE),
    fork,
    notes,
    requests: publicCards,
    composer: composerState('idle', MOCK_START_CYCLE),
    telemetry: false,
    you: { hue: you.hue, token: 'mock' },
    sourceUrl: fixture.sourceUrl,
  };
  engine.applySnapshot({ epoch: snapshot.epoch, rev, timeline, sections: score.sections, mixer });
  applySnapshotToStores(stores, snapshot);
  stores.connection.set('live');

  // ─── Schedule changes ─────────────────────────────────────────────────────────────────────────

  function publish(upserts: SectionProgram[], now: number): void {
    rev++;
    const update: ScheduleUpdate = { epoch: 'mock', rev, timeline, movements: score.movementsAt(now), upserts, revokes: [] };
    engine.applySchedule(update);
    stores.schedule.update((state) => {
      const r = applyScheduleUpdate(state, update);
      return { ...r.state, sections: pruneSections(r.state.sections, now) };
    });
  }

  const pushRequests = () => stores.requests.set([...mine].reverse().concat(publicCards));
  const setMine = (id: string, patch: Partial<RequestCard>) => {
    const i = mine.findIndex((c) => c.id === id);
    if (i >= 0) mine[i] = { ...mine[i]!, ...patch };
    pushRequests();
  };

  // ─── The crowd ────────────────────────────────────────────────────────────────────────────────

  function frame(now: number): CrowdFrame {
    const t = performance.now() / 1000;
    const section = sectionAtCycle(score.sections, now);
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let silent = 0;
    let active = 0;
    for (const o of others) {
      if (!o.active) {
        silent += 1;
        continue;
      }
      active++;
      sx += o.pos.x;
      sy += o.pos.y;
      sw += 1;
    }
    if (myPad) {
      const fresh = Math.exp(-(Date.now() - myPad.at) / 120_000);
      const w = myPad.active ? 1.6 : 1;
      sx += myPad.point.x * w * fresh;
      sy += myPad.point.y * w * fresh;
      sw += w * fresh;
      silent += w * (1 - fresh);
      if (fresh > 0.05) active++;
    }
    const target = sw > 0 ? { x: sx / (sw + SILENT_PRIOR * silent), y: sy / (sw + SILENT_PRIOR * silent) } : { x: 0, y: 0 };
    const listeners = OTHERS + 5 + Math.round(2 * Math.sin(t / 37)) + 1;
    let spread = 0;
    for (const o of others) if (o.active) spread += Math.hypot(o.pos.x - target.x, o.pos.y - target.y);
    const consensus = clamp(1 - spread / Math.max(1, active) / 1.2, 0, 1);
    const progress = section ? clamp((now - section.startCycle) / section.bars, 0, 1) : 0;
    const base = section
      ? { x: lerp(section.measured.brightness.start, section.measured.brightness.end, progress) * 2 - 1, y: lerp(section.measured.intensity.start, section.measured.intensity.end, progress) * 2 - 1 }
      : { x: 0, y: -0.6 };
    return {
      cycle: now,
      listeners,
      pull: target,
      needle: { x: clamp(base.x + 0.5 * target.x), y: clamp(base.y + 0.5 * target.y) },
      turnout: active / listeners,
      consensus,
      split: null,
      keep,
      keepPending,
      ghosts: others.filter((o) => o.active).map((o) => ({ x: q05(o.pos.x), y: q05(o.pos.y), hue: o.hue })),
      etches,
      requestsWaiting: waiting,
    };
  }

  function step(): void {
    const now = cycleNow();
    const t = performance.now();
    const dt = Math.min(1, (t - lastFrameAt) / 1000);
    lastFrameAt = t;
    const ts = t / 1000;
    mood = { x: clamp(mood.x + (rand() - 0.5) * 0.02, -0.5, 0.5), y: clamp(mood.y + (rand() - 0.5) * 0.02, -0.5, 0.5) };
    for (const o of others) {
      const tx = clamp(o.home.x + mood.x * 0.5 + Math.sin(ts * 0.31 + o.phase) * 0.08);
      const ty = clamp(o.home.y + mood.y * 0.5 + Math.cos(ts * 0.27 + o.phase) * 0.08);
      o.pos = { x: o.pos.x + (tx - o.pos.x) * 0.2, y: o.pos.y + (ty - o.pos.y) * 0.2 };
      if (rand() < 0.004) o.active = !o.active;
      if (fork && !fork.result && o.vote === null && rand() < 0.03) o.vote = o.leaning;
    }
    const raw = frame(now);
    // The room moves deliberately: an EMA of a few seconds plus a slew limit, like the server.
    const a = 1 - Math.exp(-dt / 6);
    const slew = 0.12 * dt;
    const toward = (from: number, to: number) => from + clamp((to - from) * a, -slew, slew);
    pull = { x: toward(pull.x, raw.pull.x), y: toward(pull.y, raw.pull.y) };
    needle = { x: toward(needle.x, raw.needle.x), y: toward(needle.y, raw.needle.y) };
    keep = ballot && ballot.sectionId === sectionAtCycle(score.sections, now)?.id ? toward(keep, ballot.v * 0.6) : toward(keep, 0);
    if (rand() < 0.035) {
      const r = rand();
      const type: EtchType = r < 0.55 ? 'fire' : r < 0.75 ? 'stay' : r < 0.9 ? 'move' : 'harsh';
      etches = [...etches, { type, cycle: now, hue: others[Math.floor(rand() * OTHERS)]!.hue }];
    }
    etches = etches.filter((e) => e.cycle > now - ETCH_BARS);
    if (rand() < 0.01) waiting = Math.max(1, Math.min(9, waiting + (rand() < 0.5 ? -1 : 1)));
    if (fork && !fork.result) updateTally();
    stores.crowd.set({ ...raw, pull, needle });
  }

  // ─── Forks ────────────────────────────────────────────────────────────────────────────────────

  function updateTally(): void {
    if (!fork) return;
    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    let voters = 0;
    for (const o of others) if (o.vote) (counts[o.vote]!++, voters++);
    if (fork.myVote) (counts[fork.myVote]!++, voters++);
    const total = Math.max(1, voters);
    fork = { ...fork, tally: { A: counts.A! / total, B: counts.B! / total, C: counts.C! / total }, turnout: voters / (OTHERS + 6) };
    stores.fork.set(fork);
  }

  function openFork(now: number): void {
    forkSeq++;
    // A few of the room have already voted by the time anyone looks.
    for (const o of others) o.vote = rand() < 0.3 ? o.leaning : null;
    const opens = Math.floor(now);
    fork = {
      id: `mock-fork-${forkSeq}`,
      prompt: 'Where should the harbour go next?',
      options: [
        { id: 'A', label: 'Strip it back', description: 'Down to bass and pad, then build again from nothing', kind: 'contrast' },
        { id: 'B', label: 'Double-time hats', description: 'Keep the groove, push it: hats double, filters open', kind: 'continue' },
        { id: 'C', label: 'Change the light', description: 'Lift everything a fourth, into G mixolydian', kind: 'surprise' },
      ],
      opensAtCycle: opens,
      closesAtCycle: opens + 16,
      tally: { A: 0, B: 0, C: 0 },
      turnout: 0,
      myVote: null,
      result: null,
      resolvesForSectionId: null,
      landsAtCycle: null,
    };
    updateTally();
  }

  function closeFork(now: number): void {
    if (!fork) return;
    const entries = Object.entries(fork.tally).sort((a, b) => b[1] - a[1]);
    const [winner, share] = entries[0] as ['A' | 'B' | 'C', number];
    const lands = score.sections.find((s) => s.startCycle > now + 4);
    fork = {
      ...fork,
      result: fork.turnout >= 0.1 ? { option: winner, binding: share >= 0.5 && fork.turnout >= 0.2 } : null,
      resolvesForSectionId: lands?.id ?? null,
      landsAtCycle: lands?.startCycle ?? null,
    };
    stores.fork.set(fork);
    nextForkAt = Math.floor(now) + 48;
  }

  // ─── Bars ─────────────────────────────────────────────────────────────────────────────────────

  let lastBar = Math.floor(cycleNow());
  let planningUntil = -1;

  function onBar(b: number): void {
    const starting = score.sections.find((s) => s.startCycle === b);
    if (starting) sectionStarted(starting, b);
    if (planningUntil === b) stores.composer.set(composerState('idle', b));

    if (keepPending && keepPending.atCycle === null && keepPending.blocked === null && ballot) {
      const held = keepPending.heldBars + 1;
      keepPending = held >= keepPending.needBars ? decideKeep(ballot.v, b) : { ...keepPending, heldBars: held };
    }

    if (!fork && b >= nextForkAt) openFork(b);
    else if (fork && !fork.result && b >= fork.closesAtCycle) closeFork(b);
    else if (fork?.landsAtCycle !== null && fork?.landsAtCycle !== undefined && b >= fork.landsAtCycle + 8) {
      fork = null;
      stores.fork.set(null);
    }

    advanceRequests(b);
    updateMixer(b);
  }

  function sectionStarted(section: SectionProgram, b: number): void {
    const movement = score.movements.find((m) => m.startCycle === b && b > 0);
    let list = notes;
    if (movement) {
      list = appendNote(list, { id: `mock-m-${movement.id}`, cycle: b, kind: 'movement', text: `Side ${sideLetter(movement.side)}: ${movement.name}. ${movement.blurb}`, sectionId: section.id, answering: [], author: 'claude' });
    }
    const answering = mine.filter((c) => c.sectionId === section.id && c.status === 'planned').map((c) => c.id);
    notes = appendNote(list, { id: `mock-n-${section.id}`, cycle: b, kind: 'section', text: section.publicNote, sectionId: section.id, answering, author: 'claude' });
    stores.notes.set(notes);
    for (const c of mine) {
      if (c.status === 'playing') setMine(c.id, { status: 'played' });
      if (answering.includes(c.id)) setMine(c.id, { status: 'playing' });
    }
    for (const c of publicCards) if (c.status === 'playing') c.status = 'played';
    pushRequests();
    ballot = null;
    keepPending = null;
    publish(ensureAhead(b), b);
    stores.composer.set(composerState('planning', b));
    planningUntil = b + 4;
  }

  function advanceRequests(b: number): void {
    for (const c of mine) {
      const since = b - (requestBars.get(c.id) ?? b);
      if (c.status === 'received' && since >= 3) setMine(c.id, { status: 'considered' });
      else if (c.status === 'considered' && since >= 6) {
        const target = score.sections.find((s) => s.startCycle > b + 2);
        if (target) setMine(c.id, { status: 'planned', sectionId: target.id, publicReply: `Heard — folding it into “${target.name}”.` });
      }
    }
  }
  function updateMixer(b: number): void {
    const macros = { brightness: Math.round(pull.x * 100) / 100, intensity: Math.round(pull.y * 100) / 100 };
    const cur = mixer.next.macros;
    if (Math.abs(cur.brightness - macros.brightness) < 0.05 && Math.abs(cur.intensity - macros.intensity) < 0.05) return;
    mixer = { rev: mixer.rev + 1, prev: mixer.next, next: { atCycle: b + 1, rampBars: 1, macros }, safety: null };
    engine.setMixer(mixer);
    stores.mixer.set(mixer);
  }

  // Stay / Move on, decided like the conductor (src/server/conductor/keep.ts), simplified.
  function decideKeep(v: 1 | -1, now: number): KeepPending {
    const kind = v > 0 ? 'extend' : 'shorten';
    const s = sectionAtCycle(score.sections, now);
    const blocked = (reason: KeepPending['blocked']): KeepPending => ({ kind, heldBars: 8, needBars: 8, atCycle: null, blocked: reason });
    if (!s) return blocked('locked');
    const played = now - s.startCycle;
    if (v > 0) {
      if (s.jumps.length || s.bars < 2 * KEEP_PHRASE_BARS) return blocked('locked');
      const at = s.startCycle + s.bars - KEEP_PHRASE_BARS;
      if (at < now + 2) return blocked('locked');
      publish(score.jump(s.id, { atBar: s.bars - KEEP_PHRASE_BARS, toBar: s.bars - 2 * KEEP_PHRASE_BARS }), now);
      return { kind, heldBars: 8, needBars: 8, atCycle: at, blocked: null };
    }
    const line = Math.max(KEEP_PHRASE_BARS, Math.ceil((played + 2) / KEEP_PHRASE_BARS) * KEEP_PHRASE_BARS);
    if (line >= plannedPlayBars(s) || scoreBarAt(s, line) >= s.bars - KEEP_PHRASE_BARS) return blocked('min-length');
    publish(score.jump(s.id, { atBar: scoreBarAt(s, line), toBar: s.bars - KEEP_PHRASE_BARS }), now);
    return { kind, heldBars: 8, needBars: 8, atCycle: s.startCycle + line, blocked: null };
  }

  const poll: Timer = setInterval(() => {
    const b = Math.floor(cycleNow());
    while (lastBar < b) onBar(++lastBar);
  }, POLL_MS);
  const frames: Timer = setInterval(step, FRAME_MS);

  // ─── Gestures ─────────────────────────────────────────────────────────────────────────────────

  const addEtch = (type: EtchType) => recordEtch(stores, { type, cycle: cycleNow(), hue: you.hue });

  const actions = {
    pad(point: PadPoint, active: boolean) {
      myPad = { point: { x: clamp(point.x), y: clamp(point.y) }, active, at: Date.now() };
    },
    keep(v: 1 | -1): boolean {
      const now = cycleNow();
      const s = sectionAtCycle(score.sections, now);
      if (!s) return false;
      addEtch(v > 0 ? 'stay' : 'move');
      if (ballot?.sectionId === s.id && ballot.v === v && keepPending) return true;
      ballot = { v, sectionId: s.id };
      keepPending = v > 0 && NO_STAY.has(s.role) ? { kind: 'extend', heldBars: 0, needBars: 8, atCycle: null, blocked: 'role' } : { kind: v > 0 ? 'extend' : 'shorten', heldBars: 0, needBars: 8, atCycle: null, blocked: null };
      return true;
    },
    react(type: DockReaction): boolean {
      addEtch(type);
      return true;
    },
    async request(text: string): Promise<RequestResult> {
      const clean = sanitizeRequestText(text);
      if (!clean) return { ok: false, error: 'empty' };
      const id = `mock-r${mine.length + 1}`;
      requestBars.set(id, Math.floor(cycleNow()));
      mine.push({ id, mine: true, text: clean, status: 'received', supporters: 1, publicReply: null, sectionId: null, createdAt: Date.now() });
      waiting++;
      pushRequests();
      return { ok: true, id };
    },
    vote(forkId: string, option: 'A' | 'B' | 'C'): boolean {
      if (!votes.take(performance.now())) {
        stores.nack.set({ event: 'vote', reason: 'rate-limited', at: Date.now() });
        return true;
      }
      if (!fork || fork.id !== forkId || fork.result) return true;
      fork = { ...fork, myVote: option };
      updateTally();
      return true;
    },
    poke() {},
  };

  return {
    engine,
    clock,
    stores,
    actions,
    mock: true,
    destroy() {
      clearInterval(poll);
      clearInterval(frames);
      engine.suspend();
    },
  };
}

function dedupeById(sections: SectionProgram[]): SectionProgram[] {
  const byId = new Map<string, SectionProgram>();
  for (const s of sections) byId.set(s.id, s);
  return [...byId.values()];
}
