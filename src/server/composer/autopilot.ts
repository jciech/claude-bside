// The autopilot's planning: pure functions of the validated library and a TurnContext.
//  - After someone else's material (a handoff), carry-vamp it for a few sections.
//  - Continue its own ensemble through the movement's form, following the conductor's expected
//    roles, each role arranged differently each time it comes back, the bridge in another mode.
//  - Close its side with an outro after 8–9 minutes of music (never before the movement is old
//    enough to be replaced, 6 minutes at the commit that opens the next one), then open a new side
//    with a contrasting ensemble: another groove family, not one heard recently, a legal tempo move
//    (≤ 12 BPM with a ramp, exact half or double time, or through a beatless intro), a related key.
import { createHash } from 'node:crypto';
import type { SectionSummary, TurnContext } from '../../shared/composer-api.ts';
import { PERCUSSIVE_ROLES, type SectionRole } from '../../shared/music.ts';
import type { FormStep, MovementPlan, Plan, SectionPlan } from '../../shared/plan.ts';
import { arrangeSection, barsFor, riserCode, secondsFor, type PrevView } from './arrange.ts';
import { carryPlan, carryRun, isCarryName, MAX_CARRY_RUN } from './carry.ts';
import type { Ensemble } from './library/index.ts';
import { fillScale, parseScale, scaleOf, transposeTonic } from './library/scale.ts';
import { colourMoves, partVariants, type Variant } from './variants.ts';
import { decideWishes, promisedEnsembles, readWishes, type Wish } from './wishes.ts';

export interface AutopilotLibrary {
  ensembles: readonly Ensemble[];
  /** Resolved sound ids each ensemble plays (from boot validation), for palettes and freshness. */
  sounds: ReadonlyMap<string, readonly string[]>;
  /** Code variants that passed boot validation, by ensemble id then part id (absent = any). */
  variants?: ReadonlyMap<string, ReadonlyMap<string, readonly Variant[]>>;
}

export type PlanMode = 'fallback' | 'compose';

export interface Candidate {
  plan: Plan;
  /** The ensemble a new side opens with, when the plan opens one. */
  opens: Ensemble | null;
  kind: 'carry' | 'continue' | 'open';
}

const NEXT_ROLE: Record<SectionRole, SectionRole> = {
  intro: 'groove',
  groove: 'build',
  build: 'drop',
  drop: 'breakdown',
  breakdown: 'groove',
  bridge: 'groove',
  interlude: 'groove',
  outro: 'intro',
  transition: 'groove',
  reprise: 'breakdown',
};

const FORM_NOTES: Record<SectionRole, string> = {
  intro: 'harmony first, the rhythm creeping in',
  groove: 'the full band settles in',
  build: 'stripped back, then layering up under a riser; kick and bass wait for the drop',
  drop: 'everything at once, the bass back',
  breakdown: 'drums away, harmony low and dark',
  bridge: 'a side road in another mode',
  interlude: 'a breath: harmony and colour only',
  outro: 'parts leave one by one',
  transition: 'crossing over',
  reprise: 'the loved moment again',
};

/** Forms a side is cut from (then trimmed to its length and closed with an outro). */
const BEAT_FORMS: SectionRole[][] = [
  ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove', 'bridge', 'build', 'drop', 'groove', 'breakdown', 'build', 'drop'],
  ['intro', 'groove', 'groove', 'breakdown', 'build', 'drop', 'bridge', 'groove', 'build', 'drop', 'interlude', 'groove', 'build', 'drop'],
  ['intro', 'build', 'drop', 'breakdown', 'groove', 'bridge', 'build', 'drop', 'groove', 'interlude', 'build', 'drop'],
];
const FREE_FORMS: SectionRole[][] = [
  ['intro', 'groove', 'interlude', 'groove', 'bridge', 'build', 'drop', 'breakdown', 'groove', 'interlude', 'groove', 'bridge'],
  ['intro', 'groove', 'breakdown', 'groove', 'bridge', 'interlude', 'build', 'drop', 'groove', 'breakdown', 'groove'],
];

const MAX_MOVEMENT_JUMP_BPM = 12;
const TEMPO_SWITCH_BPM = 2;
const MAX_BPM_IN_MOVEMENT = 4;
/** A side may only be replaced once it is this old (the conductor's minimum, checked at commit). */
const MOVEMENT_MIN_SEC = 6 * 60;
const MOVEMENT_MAX_SEC = 9 * 60;
/** A side's planned length: its form is cut to 8–8.75 minutes. */
const SIDE_SECONDS: [number, number] = [8 * 60, 8.75 * 60];
/** How far ahead the conductor asks for music (its horizon trigger), so when the next plan comes. */
const PLAN_AHEAD_SEC = 120;

export function seedOf(ctx: TurnContext): number {
  return createHash('sha1').update(`${ctx.request.id}|${ctx.request.startCycle}`).digest().readUInt32BE(0);
}

const hashOf = (text: string) => createHash('sha1').update(text).digest().readUInt32BE(0);
const hasBeat = (ens: Ensemble) => ens.parts.some((p) => PERCUSSIVE_ROLES.has(p.role));
const clampBpm = (ens: Ensemble, bpm: number) => Math.min(ens.bpm.max, Math.max(ens.bpm.min, Math.round(bpm)));
const rampFor = (to: number, from: number) => (Math.abs(to - from) > TEMPO_SWITCH_BPM ? Math.ceil(Math.abs(to - from)) : 0);

/** Every code a part may play in a scale: its template and each variant. */
function codesOf(ens: Ensemble, scale: string): Map<string, Set<string>> {
  return new Map(ens.parts.map((p) => [p.id, new Set(partVariants(p).map((v) => fillScale(v.code, scale)))]));
}

/** The ensemble that wrote every part of `section` (in its scale, plus a build's riser), if the autopilot did. */
export function recognize(ensembles: readonly Ensemble[], section: Pick<SectionSummary, 'scale' | 'bars' | 'parts'>): Ensemble | null {
  const parts = section.parts.filter((p) => p.code !== riserCode(section.bars));
  if (!parts.length) return null;
  return (
    ensembles.find((ens) => {
      const codes = codesOf(ens, section.scale);
      return parts.every((p) => codes.get(p.id)?.has(p.code));
    }) ?? null
  );
}

const knowsScale = (ens: Ensemble, scale: string) => {
  const tokens = parseScale(scale);
  return !!tokens && tokens.every((t) => ens.modes.includes(t.mode));
};

/** Whether an ensemble can play inside a movement: it knows every scale mode, and a tempo within ±4. */
export function fitsMovement(ens: Ensemble, movement: { bpm: number; scale: string }): boolean {
  if (!knowsScale(ens, movement.scale)) return false;
  return Math.abs(clampBpm(ens, movement.bpm) - movement.bpm) <= MAX_BPM_IN_MOVEMENT;
}

/** Section titles played and committed, oldest first (a plan appends its own as it goes). */
function usedNames(ctx: TurnContext): string[] {
  return sectionsSoFar(ctx).map((s) => s.name);
}

/** A title not heard lately: an unused one if any is left, else the one used longest ago. */
function pickTitle(titles: readonly string[], used: readonly string[], seed: number): string {
  const fresh = titles.filter((t) => !used.includes(t));
  if (fresh.length) return fresh[seed % fresh.length]!;
  return [...titles].sort((a, b) => used.lastIndexOf(a) - used.lastIndexOf(b))[0]!;
}

function pick<T>(items: readonly T[], used: ReadonlySet<T>, seed: number): T {
  const fresh = items.filter((i) => !used.has(i));
  const pool = fresh.length ? fresh : items;
  return pool[seed % pool.length]!;
}

/** Played-then-committed sections, oldest first, each once. */
function sectionsSoFar(ctx: TurnContext): { id: string; name: string; role: SectionRole }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string; role: SectionRole }[] = [];
  for (const s of [...ctx.history.sections, ...(ctx.now ? [ctx.now] : []), ...ctx.committed]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, name: s.name, role: s.role });
  }
  return out;
}

/** Ensembles heard recently, most recent first (recognised by their section titles). */
function recentEnsembles(lib: AutopilotLibrary, ctx: TurnContext): Ensemble[] {
  const out: Ensemble[] = [];
  for (const s of sectionsSoFar(ctx).reverse()) {
    if (isCarryName(s.name)) continue;
    const ens = lib.ensembles.find((e) => e.titles.includes(s.name));
    if (ens && !out.includes(ens)) out.push(ens);
  }
  return out;
}

/** How often `ens` already played `role` since its latest intro (this movement), plus planned ones. */
function occurrences(ctx: TurnContext, ens: Ensemble, role: SectionRole, planned: readonly SectionRole[]): number {
  const titles = new Set(ens.titles);
  let n = planned.filter((r) => r === role).length;
  for (const s of sectionsSoFar(ctx).reverse()) {
    if (!titles.has(s.name)) break;
    if (s.role === role) n++;
    if (s.role === 'intro') break;
  }
  return n;
}

// ─── Timing a side ──────────────────────────────────────────────────────────────────────────────

interface SideClock {
  /** Seconds of the movement already played when the plan's first section starts. */
  start: number;
  /** When the side should end, in seconds of the movement. */
  target: number;
  /** The movement's age now, in seconds. */
  age: number;
  bpm: number;
}

function sideClock(ctx: TurnContext, bpm: number): SideClock {
  const m = ctx.movement!;
  const age = m.ageMin * 60;
  const lead = Math.max(0, ctx.request.startCycle - ctx.clock.cycle) * ctx.clock.secondsPerBar;
  const formSec = ctx.memory.form.reduce((a, f) => a + f.bars, 0) * (240 / m.bpm);
  const target = ctx.memory.form.length >= 2 ? Math.min(MOVEMENT_MAX_SEC, Math.max(SIDE_SECONDS[0], formSec)) : (SIDE_SECONDS[0] + SIDE_SECONDS[1]) / 2;
  return { start: age + lead, target, age, bpm };
}

/** An outro starting at `at` may close the side: the plan opening the next one comes late enough. */
function mayClose(clock: SideClock, at: number): boolean {
  const outro = secondsFor('outro', clock.bpm);
  const nextPlanAge = Math.max(clock.age, at + outro - PLAN_AHEAD_SEC);
  return nextPlanAge >= MOVEMENT_MIN_SEC || at + outro >= MOVEMENT_MAX_SEC;
}

/** A section of `role` starting at `at` would leave no room for an outro before the side's end. */
function shouldClose(clock: SideClock, at: number, role: SectionRole): boolean {
  const outro = secondsFor('outro', clock.bpm);
  const next = at + secondsFor(role, clock.bpm);
  return next + outro > clock.target || next + outro > MOVEMENT_MAX_SEC;
}

/** Section roles to write next: the conductor's expected roles, kept sensible and timed to the side. */
function rolesFor(ctx: TurnContext, count: number, after: SectionRole, clock: SideClock): SectionRole[] {
  const out: SectionRole[] = [];
  let prev = after;
  let at = clock.start;
  for (let i = 0; i < count; i++) {
    let role = ctx.expected[i]?.role ?? NEXT_ROLE[prev];
    if (role === prev && role !== 'groove') role = NEXT_ROLE[role];
    if (role === 'intro') role = 'groove';
    if (prev === 'build') role = 'drop';
    if (prev !== 'build') {
      // A build only starts if its drop still fits before the outro.
      const late = shouldClose(clock, at, role) || (role === 'build' && shouldClose(clock, at + secondsFor('build', clock.bpm), 'drop'));
      if ((role === 'outro' || late) && mayClose(clock, at)) role = 'outro';
      // Too early to close but no room for a long section: a short side road before the outro.
      else if (late) role = prev === 'bridge' ? 'interlude' : 'bridge';
      else if (role === 'outro') role = prev === 'groove' ? 'breakdown' : 'groove';
    }
    out.push(role);
    if (role === 'outro') break;
    at += secondsFor(role, clock.bpm);
    prev = role;
  }
  return out;
}

/** A side's form: one of the forms for its kind of ensemble, cut to the side's length, then an outro. */
function formFor(ens: Ensemble, bpm: number, seed: number): FormStep[] {
  const forms = hasBeat(ens) ? BEAT_FORMS : FREE_FORMS;
  const roles = forms[seed % forms.length]!;
  const target = SIDE_SECONDS[0] + ((seed >>> 8) % 1000) / 1000 * (SIDE_SECONDS[1] - SIDE_SECONDS[0]);
  const outro = secondsFor('outro', bpm);
  const steps: FormStep[] = [];
  let t = 0;
  for (const [i, role] of roles.entries()) {
    const d = secondsFor(role, bpm);
    const tail = role === 'build' ? secondsFor('drop', bpm) : 0;
    if (i >= 3 && t + d + tail + outro > target) break;
    steps.push({ role, bars: barsFor(role, bpm), note: FORM_NOTES[role] });
    t += d;
  }
  while (steps.length && steps[steps.length - 1]!.role === 'build') steps.pop();
  steps.push({ role: 'outro', bars: barsFor('outro', bpm), note: FORM_NOTES.outro });
  return steps;
}

function expectedTargets(ctx: TurnContext, i: number) {
  const e = ctx.expected[i];
  return e ? { intensity: e.targets.intensity, brightness: e.targets.brightness } : null;
}

// ─── Choosing an ensemble for a new side ──────────────────────────────────────────────────────

interface Choice {
  ensemble: Ensemble;
  bpm: number;
  rampBars: number;
  beatless: boolean;
}

/** Exact half or double time, as the conductor's tempo rules accept it (within 3 %). */
function halfOrDouble(ens: Ensemble, tailBpm: number): number | null {
  for (const ratio of [2, 0.5]) {
    const bpm = Math.round(tailBpm * ratio);
    if (bpm >= ens.bpm.min && bpm <= ens.bpm.max && Math.abs(bpm / tailBpm - ratio) <= 0.03 * ratio) return bpm;
  }
  return null;
}

/**
 * The new side's tempo: the ensemble's own if it is within 12 BPM of the old side; else exact half
 * or double time; else as close as a 12 BPM move allows; else its own through a beatless intro.
 * Ramps are measured from the section actually playing before (`tailBpm`).
 */
function tempoFor(ens: Ensemble, movementBpm: number | null, tailBpm: number | null): Omit<Choice, 'ensemble'> {
  if (movementBpm === null || tailBpm === null) return { bpm: ens.bpm.default, rampBars: 0, beatless: false };
  const own = ens.bpm.default;
  if (Math.abs(own - movementBpm) <= MAX_MOVEMENT_JUMP_BPM) return { bpm: own, rampBars: rampFor(own, tailBpm), beatless: false };
  const multiple = halfOrDouble(ens, tailBpm);
  if (multiple !== null) return { bpm: multiple, rampBars: 0, beatless: false };
  const reach = Math.round(movementBpm + Math.sign(own - movementBpm) * MAX_MOVEMENT_JUMP_BPM);
  if (reach >= ens.bpm.min && reach <= ens.bpm.max) return { bpm: reach, rampBars: rampFor(reach, tailBpm), beatless: false };
  return { bpm: own, rampBars: 0, beatless: true };
}

function staleness(lib: AutopilotLibrary, ens: Ensemble, ctx: TurnContext): number {
  const mine = new Set(lib.sounds.get(ens.id) ?? []);
  const recent = ctx.history.sections.slice(-12).flatMap((s) => s.sounds);
  if (!mine.size || !recent.length) return 0;
  return recent.filter((s) => mine.has(s)).length / recent.length;
}

/**
 * Where the new side should sit: the room's pad when someone is listening (else the middle), pushed
 * away from the side that is ending, and leaned by what listeners asked for.
 */
function targetMood(ctx: TurnContext, wishes: readonly Wish[], current: Ensemble | null): { intensity: number; brightness: number } {
  const base = ctx.crowd.listeners > 0 ? { intensity: ctx.crowd.pad.intensity, brightness: ctx.crowd.pad.brightness } : { intensity: 0.5, brightness: 0.5 };
  const mood = current
    ? { intensity: base.intensity + 0.5 * (base.intensity - current.mood.intensity), brightness: base.brightness + 0.3 * (base.brightness - current.mood.brightness) }
    : { ...base };
  const weight = wishes.reduce((a, w) => a + w.support, 0);
  if (weight > 0) {
    mood.intensity += (0.15 * wishes.reduce((a, w) => a + w.lean.intensity * w.support, 0)) / weight;
    mood.brightness += (0.15 * wishes.reduce((a, w) => a + w.lean.brightness * w.support, 0)) / weight;
  }
  return mood;
}

const RECENCY_PENALTY = [3, 1.5, 0.8, 0.4];
/** Cost of each ensemble skipped on the tour. */
const TOUR_STEP = 0.5;

/**
 * The order new sides take through the library, so every ensemble gets a side before any comes
 * back (the turn context only remembers the last dozen sections, so this can't come from history):
 * library order, rearranged so neighbours never share a groove family — each step takes the next
 * ensemble of the family with the most left that isn't the family just taken.
 */
function tourOf(ensembles: readonly Ensemble[]): Ensemble[] {
  const families = new Map<string, Ensemble[]>();
  for (const e of ensembles) families.set(e.groove, [...(families.get(e.groove) ?? []), e]);
  const out: Ensemble[] = [];
  let last: string | null = null;
  while (out.length < ensembles.length) {
    const open = [...families].filter(([groove, q]) => q.length && groove !== last);
    const [groove, queue] = (open.length ? open : [...families].filter(([, q]) => q.length)).reduce((a, b) => (b[1].length > a[1].length ? b : a));
    out.push(queue.shift()!);
    last = groove;
  }
  return out;
}

function chooseEnsembles(lib: AutopilotLibrary, ctx: TurnContext, tail: SectionSummary | null, avoid: Ensemble | null, wishes: readonly Wish[], seed: number): Choice[] {
  const movementBpm = ctx.movement?.bpm ?? tail?.bpm ?? null;
  const recent = recentEnsembles(lib, ctx);
  const current = avoid ?? recent[0] ?? null;
  const mood = targetMood(ctx, wishes, current);
  const groove = ctx.movement?.groove ?? current?.groove ?? null;
  const promised = new Set(promisedEnsembles(ctx.crowd.promises, lib.ensembles).map((p) => p.ensemble.id));
  const tour = tourOf(lib.ensembles);
  const here = current ? tour.indexOf(current) : -1;
  // Nobody at the pad: the mood target is only a nudge away from the side that ends.
  const moodWeight = ctx.crowd.listeners > 0 ? 1 : 0.5;
  return lib.ensembles
    .map((ens) => {
      const tempo = tempoFor(ens, movementBpm, tail?.bpm ?? null);
      const wished = wishes.filter((w) => w.ensemble?.id === ens.id).reduce((a, w) => a + w.support, 0);
      const jitter = (createHash('sha1').update(`${seed}:${ens.id}`).digest().readUInt16BE(0) / 65536) * 0.3;
      const heard = ens.id === avoid?.id ? 0 : recent.findIndex((e) => e.id === ens.id);
      const ahead = here < 0 ? 0 : (tour.indexOf(ens) - here - 1 + tour.length) % tour.length;
      const score =
        -moodWeight * (Math.abs(ens.mood.intensity - mood.intensity) + Math.abs(ens.mood.brightness - mood.brightness)) -
        TOUR_STEP * ahead -
        0.8 * staleness(lib, ens, ctx) -
        (tempo.beatless ? 0.3 : 0) -
        (heard >= 0 ? (RECENCY_PENALTY[heard] ?? 0) : 0) -
        (groove !== null && ens.groove === groove ? 1 : 0) -
        (ens.standby ? 1 : 0) +
        Math.min(1.5, wished) +
        (promised.has(ens.id) ? 20 : 0) +
        jitter;
      return { choice: { ensemble: ens, ...tempo }, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.choice);
}

/** Near keys for a new side: up a fourth, a fifth, a minor third, down a minor third, a whole tone. */
const KEY_STEPS = [5, 7, 3, -3, 2];

/**
 * A key for the new side, close to the old one: a new colour (mode) may keep the tonic, otherwise the
 * tonic moves to a neighbouring key so the key centre never sits still for long.
 */
function keyFor(ens: Ensemble, ctx: TurnContext, seed: number): string {
  const current = ctx.movement ? (parseScale(ctx.movement.scale)?.[0] ?? null) : null;
  const mode = ens.modes[0]!;
  if (!current) return scaleOf(ens.tonic, mode);
  const keep = current.mode !== mode && seed % 3 === 0;
  return scaleOf(keep ? current.tonic : transposeTonic(current.tonic, KEY_STEPS[seed % KEY_STEPS.length]!), mode);
}

// ─── Plans ────────────────────────────────────────────────────────────────────────────────────

function basePlan(sections: SectionPlan[], rationale: string): Plan {
  return { sections, movement: null, fork: null, requestDecisions: [], motifs: [], announcement: null, rationale: rationale.slice(0, 1200) };
}

/** A side's away keys: the related modes of its home key, starting at the one this side prefers. */
function awayKeys(ens: Ensemble, home: string, movementName: string): string[] {
  const moves = colourMoves(ens, home);
  const first = moves.length ? hashOf(`away:${movementName}`) % moves.length : 0;
  return [...moves.slice(first), ...moves.slice(0, first)];
}

interface SectionJob {
  ensemble: Ensemble;
  role: SectionRole;
  scale: string;
  away: readonly string[];
  bpm: number;
  rampBars: number;
  prev: PrevView | null;
  sameEnsemble: boolean;
  beatless: boolean;
  targets: ReturnType<typeof expectedTargets>;
  name: string;
  seed: number;
  occurrence: number;
  rotation: number;
}

function arrange(lib: AutopilotLibrary, job: SectionJob) {
  return arrangeSection({ ...job, bars: barsFor(job.role, job.bpm), variants: lib.variants?.get(job.ensemble.id) });
}

function continueMovement(lib: AutopilotLibrary, ctx: TurnContext, ens: Ensemble, tail: SectionSummary, own: boolean, count: 1 | 2, seed: number): Candidate {
  const movement = ctx.movement!;
  const home = knowsScale(ens, movement.scale) ? movement.scale : tail.scale;
  const bpm = own ? tail.bpm : clampBpm(ens, movement.bpm);
  const used = usedNames(ctx);
  const roles = rolesFor(ctx, count, tail.role, sideClock(ctx, bpm));
  const offset = hashOf(movement.name);
  const away = awayKeys(ens, home, movement.name);
  let prev: PrevView = tail;
  const sections = roles.map((role, i) => {
    const name = pickTitle(ens.titles, used, seed + i);
    used.push(name);
    const earlier = occurrences(ctx, ens, role, roles.slice(0, i));
    const { section, view } = arrange(lib, {
      ensemble: ens,
      role,
      scale: home,
      // A side states a role at home before it takes it anywhere else (a bridge always leaves).
      away: earlier === 0 && role !== 'bridge' ? [] : away,
      bpm,
      rampBars: i === 0 ? rampFor(bpm, tail.bpm) : 0,
      prev,
      sameEnsemble: own || i > 0,
      beatless: false,
      targets: expectedTargets(ctx, i),
      name,
      seed: seed + i,
      occurrence: earlier,
      rotation: offset,
    });
    prev = view;
    return section;
  });
  return { plan: basePlan(sections, `autopilot: ${ens.id} continues "${movement.name}" (${roles.join(', ')})`), opens: null, kind: 'continue' };
}

function openMovement(lib: AutopilotLibrary, ctx: TurnContext, choice: Choice, closing: { ensemble: Ensemble; tail: SectionSummary } | null, count: 1 | 2, seed: number): Candidate {
  const ens = choice.ensemble;
  const scale = keyFor(ens, ctx, seed);
  const used = usedNames(ctx);
  const sections: SectionPlan[] = [];
  let prev: PrevView | null = ctx.committed[ctx.committed.length - 1] ?? ctx.now ?? null;
  const closes = closing !== null && count === 2;
  if (closes) {
    const name = pickTitle(closing.ensemble.titles, used, seed);
    used.push(name);
    const home = ctx.movement && knowsScale(closing.ensemble, ctx.movement.scale) ? ctx.movement.scale : closing.tail.scale;
    const outro = arrange(lib, {
      ensemble: closing.ensemble,
      role: 'outro',
      scale: home,
      away: [],
      bpm: closing.tail.bpm,
      rampBars: 0,
      prev: closing.tail,
      sameEnsemble: true,
      beatless: false,
      targets: null,
      name,
      seed,
      occurrence: 0,
      rotation: seed,
    });
    sections.push(outro.section);
    prev = outro.view;
  }
  const movementName = pick(ens.movementNames, new Set(ctx.movement ? [ctx.movement.name] : []), seed);
  const offset = hashOf(movementName);
  const roles = (['intro', 'groove'] as const).slice(0, count - sections.length);
  roles.forEach((role, i) => {
    const name = pickTitle(ens.titles, used, seed + 1 + i);
    used.push(name);
    const arranged = arrange(lib, {
      ensemble: ens,
      role,
      scale,
      away: [],
      bpm: choice.bpm,
      rampBars: i === 0 ? choice.rampBars : 0,
      prev,
      sameEnsemble: i > 0,
      beatless: i === 0 && choice.beatless,
      targets: expectedTargets(ctx, sections.length),
      name,
      seed: seed + 1 + i,
      occurrence: 0,
      rotation: offset,
    });
    sections.push(arranged.section);
    prev = arranged.view;
  });
  const sounds = [...(lib.sounds.get(ens.id) ?? [])];
  const movement: MovementPlan = {
    name: movementName,
    startsAtSection: closes ? 1 : 0,
    bpm: choice.bpm,
    scale,
    groove: ens.groove,
    arcShape: ens.arc,
    form: formFor(ens, choice.bpm, seed),
    palette: sounds.slice(0, 16),
    signature: sounds.slice(0, 2),
    blurb: ens.blurb.slice(0, 200),
  };
  const why = `autopilot: opens a ${ens.id} side in ${scale} at ${choice.bpm} BPM${closes ? `, closing ${closing.ensemble.id} with an outro` : ''}`;
  return { plan: { ...basePlan(sections, why), movement }, opens: ens, kind: 'open' };
}

/**
 * Candidate plans, best first. `fallback` fills a gap: one section, no new side unless it must, no
 * request decisions. `compose` is the autopilot as the room's composer.
 */
export function planCandidates(lib: AutopilotLibrary, ctx: TurnContext, mode: PlanMode): Candidate[] {
  const seed = seedOf(ctx);
  const count: 1 | 2 = mode === 'fallback' ? 1 : ctx.request.sectionsWanted;
  const tail: SectionSummary | null = ctx.committed[ctx.committed.length - 1] ?? ctx.now ?? null;
  const wishes = mode === 'compose' ? readWishes(ctx.crowd.requests, lib.ensembles) : [];
  const wantsSide = mode === 'compose' && ctx.request.kind === 'movement';
  const choices = (avoid: Ensemble | null) => chooseEnsembles(lib, ctx, tail, avoid, wishes, seed);
  const out: Candidate[] = [];

  if (!tail || !ctx.movement) {
    for (const choice of choices(null).slice(0, 3)) out.push(openMovement(lib, ctx, choice, null, count, seed));
  } else {
    const own = recognize(lib.ensembles, tail);
    if (own) {
      const cont = continueMovement(lib, ctx, own, tail, true, count, seed);
      const closesNow = cont.plan.sections[0]!.role === 'outro' && count === 2 && ctx.movement.ageMin * 60 >= MOVEMENT_MIN_SEC;
      if (wantsSide || tail.role === 'outro' || closesNow) {
        for (const choice of choices(own).slice(0, 2)) out.push(openMovement(lib, ctx, choice, tail.role === 'outro' ? null : { ensemble: own, tail }, count, seed));
      }
      out.push(cont);
    } else {
      const run = carryRun(sectionsSoFar(ctx).map((s) => s.name));
      const bars = barsFor('groove', tail.bpm, ctx.rules.minPlanBars);
      const carry: Candidate = { plan: carryPlan(tail, run, bars, count), opens: null, kind: 'carry' };
      if (run < MAX_CARRY_RUN && !wantsSide) out.push(carry);
      const ranked = choices(null);
      // New material doesn't arrive just to wind a side down: when the arc says outro, open the next one.
      if (!wantsSide && ctx.expected[0]?.role !== 'outro') {
        for (const choice of ranked.filter((c) => fitsMovement(c.ensemble, ctx.movement!)).slice(0, 2)) {
          out.push(continueMovement(lib, ctx, choice.ensemble, tail, false, count, seed));
        }
      }
      for (const choice of ranked.slice(0, 2)) out.push(openMovement(lib, ctx, choice, null, count, seed));
      if (run >= MAX_CARRY_RUN || wantsSide) out.push(carry);
    }
  }
  if (mode === 'fallback') return out;
  const promised = promisedEnsembles(ctx.crowd.promises, lib.ensembles);
  return out.map((c) => {
    const playing = c.opens && c.plan.movement ? { ensemble: c.opens, sectionIndex: c.plan.movement.startsAtSection, opensMovement: true } : null;
    return { ...c, plan: { ...c.plan, requestDecisions: decideWishes(wishes, promised, playing).slice(0, 10) } };
  });
}
