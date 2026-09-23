// The autopilot's planning: pure functions of the validated library and a TurnContext.
//  - After someone else's material (a handoff), carry-vamp it for a few sections.
//  - Continue its own ensemble through the movement's form, following the conductor's expected roles.
//  - Open a new side (movement) when asked, after its own outro, when nothing fits the current
//    movement, or at boot — keeping the tempo change legal (≤ 12 BPM with a ramp, or a beatless
//    intro) and the key close.
import { createHash } from 'node:crypto';
import type { SectionSummary, TurnContext } from '../../shared/composer-api.ts';
import { PERCUSSIVE_ROLES, type SectionRole } from '../../shared/music.ts';
import type { FormStep, MovementPlan, Plan, SectionPlan } from '../../shared/plan.ts';
import { arrangeSection, barsFor, riserCode, type PrevView } from './arrange.ts';
import { carryPlan, carryRun, MAX_CARRY_RUN } from './carry.ts';
import type { Ensemble } from './library/index.ts';
import { fillScale, parseScale, scaleOf, transposeTonic } from './library/scale.ts';
import { decideWishes, promisedEnsembles, readWishes, type Wish } from './wishes.ts';

export interface AutopilotLibrary {
  ensembles: readonly Ensemble[];
  /** Resolved sound ids each ensemble plays (from boot validation), for palettes and freshness. */
  sounds: ReadonlyMap<string, readonly string[]>;
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
  build: 'filters open, the kick steps out at the end',
  drop: 'everything at once',
  breakdown: 'drums away, harmony and hook alone',
  bridge: 'a side road without the lead',
  interlude: 'a breath: harmony and colour only',
  outro: 'parts leave one by one',
  transition: 'crossing over',
  reprise: 'the loved moment again',
};

const MAX_MOVEMENT_JUMP_BPM = 12;
const TEMPO_SWITCH_BPM = 2;
const MAX_BPM_IN_MOVEMENT = 4;

export function seedOf(ctx: TurnContext): number {
  return createHash('sha1').update(`${ctx.request.id}|${ctx.request.startCycle}`).digest().readUInt32BE(0);
}

const hasBeat = (ens: Ensemble) => ens.parts.some((p) => PERCUSSIVE_ROLES.has(p.role));
const clampBpm = (ens: Ensemble, bpm: number) => Math.min(ens.bpm.max, Math.max(ens.bpm.min, Math.round(bpm)));
const rampFor = (to: number, from: number) => (Math.abs(to - from) > TEMPO_SWITCH_BPM ? Math.ceil(Math.abs(to - from)) : 0);

/** The ensemble that wrote every part of `section` (in its scale, plus a build's riser), if the autopilot did. */
export function recognize(ensembles: readonly Ensemble[], section: Pick<SectionSummary, 'scale' | 'bars' | 'parts'>): Ensemble | null {
  const parts = section.parts.filter((p) => p.code !== riserCode(section.bars));
  if (!parts.length) return null;
  return (
    ensembles.find((ens) => {
      const codes = new Map(ens.parts.map((p) => [p.id, fillScale(p.code, section.scale)]));
      return parts.every((p) => codes.get(p.id) === p.code);
    }) ?? null
  );
}

/** Whether an ensemble can play inside a movement: it knows every scale mode, and a tempo within ±4. */
export function fitsMovement(ens: Ensemble, movement: { bpm: number; scale: string }): boolean {
  const tokens = parseScale(movement.scale);
  if (!tokens || !tokens.every((t) => ens.modes.includes(t.mode))) return false;
  return Math.abs(clampBpm(ens, movement.bpm) - movement.bpm) <= MAX_BPM_IN_MOVEMENT;
}

function usedNames(ctx: TurnContext): Set<string> {
  return new Set([...ctx.history.sections.map((s) => s.name), ...(ctx.now ? [ctx.now.name] : []), ...ctx.committed.map((s) => s.name)]);
}

function pick<T>(items: readonly T[], used: ReadonlySet<T>, seed: number): T {
  const fresh = items.filter((i) => !used.has(i));
  const pool = fresh.length ? fresh : items;
  return pool[seed % pool.length]!;
}

/** Played-then-committed section names, oldest first, each section once. */
function sectionNames(ctx: TurnContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...ctx.history.sections, ...(ctx.now ? [ctx.now] : []), ...ctx.committed]) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s.name);
  }
  return out;
}

/** Section roles to write next: the conductor's expected roles, kept sensible for the ensemble. */
function rolesFor(ctx: TurnContext, ens: Ensemble, count: number, after: SectionRole): SectionRole[] {
  const out: SectionRole[] = [];
  let prev = after;
  for (let i = 0; i < count; i++) {
    let role = ctx.expected[i]?.role ?? NEXT_ROLE[prev];
    if (role === prev && role !== 'groove') role = NEXT_ROLE[role];
    if (role === 'intro') role = 'groove';
    if (!hasBeat(ens) && (role === 'build' || role === 'drop' || role === 'reprise')) role = role === 'build' ? 'bridge' : 'groove';
    out.push(role);
    if (role === 'outro') break;
    prev = role;
  }
  return out;
}

function formFor(ens: Ensemble, bpm: number): FormStep[] {
  const roles: SectionRole[] = hasBeat(ens)
    ? ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove', 'bridge', 'build', 'drop', 'outro']
    : ['intro', 'groove', 'bridge', 'interlude', 'groove', 'bridge', 'outro'];
  return roles.map((role) => ({ role, bars: barsFor(role, bpm), note: FORM_NOTES[role] }));
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

/**
 * The new side's tempo: the ensemble's own if it is within 12 BPM of the old side, else as close
 * as the rule allows, else its own through a beatless intro. Ramps are measured from the section
 * actually playing before (`tailBpm`), which may sit up to 4 BPM off the old side's centre.
 */
function tempoFor(ens: Ensemble, movementBpm: number | null, tailBpm: number | null): Omit<Choice, 'ensemble'> {
  if (movementBpm === null || tailBpm === null) return { bpm: ens.bpm.default, rampBars: 0, beatless: false };
  let bpm = ens.bpm.default;
  if (Math.abs(bpm - movementBpm) > MAX_MOVEMENT_JUMP_BPM) {
    const reach = Math.round(movementBpm + Math.sign(bpm - movementBpm) * MAX_MOVEMENT_JUMP_BPM);
    if (reach >= ens.bpm.min && reach <= ens.bpm.max) bpm = reach;
  }
  if (Math.abs(bpm - movementBpm) > MAX_MOVEMENT_JUMP_BPM) return { bpm, rampBars: 0, beatless: true };
  return { bpm, rampBars: rampFor(bpm, tailBpm), beatless: false };
}

function staleness(lib: AutopilotLibrary, ens: Ensemble, ctx: TurnContext): number {
  const mine = new Set(lib.sounds.get(ens.id) ?? []);
  const recent = ctx.history.sections.slice(-12).flatMap((s) => s.sounds);
  if (!mine.size || !recent.length) return 0;
  return recent.filter((s) => mine.has(s)).length / recent.length;
}

/** Where the new side should sit: the conductor's arc target, leaned by what listeners asked for. */
function targetMood(ctx: TurnContext, wishes: readonly Wish[]): { intensity: number; brightness: number } {
  const e = ctx.expected[0]?.targets;
  const mood = e
    ? { intensity: (e.intensity.start + e.intensity.end) / 2, brightness: (e.brightness.start + e.brightness.end) / 2 }
    : ctx.crowd.listeners > 0
      ? { intensity: ctx.crowd.pad.intensity, brightness: ctx.crowd.pad.brightness }
      : { intensity: 0.5, brightness: 0.5 };
  const weight = wishes.reduce((a, w) => a + w.support, 0);
  if (weight > 0) {
    mood.intensity += (0.15 * wishes.reduce((a, w) => a + w.lean.intensity * w.support, 0)) / weight;
    mood.brightness += (0.15 * wishes.reduce((a, w) => a + w.lean.brightness * w.support, 0)) / weight;
  }
  return mood;
}

function chooseEnsembles(lib: AutopilotLibrary, ctx: TurnContext, tail: SectionSummary | null, avoid: Ensemble | null, wishes: readonly Wish[], seed: number): Choice[] {
  const movementBpm = ctx.movement?.bpm ?? tail?.bpm ?? null;
  const mood = targetMood(ctx, wishes);
  const promised = new Set(promisedEnsembles(ctx.crowd.promises, lib.ensembles).map((p) => p.ensemble.id));
  return lib.ensembles
    .map((ens) => {
      const tempo = tempoFor(ens, movementBpm, tail?.bpm ?? null);
      const wished = wishes.filter((w) => w.ensemble?.id === ens.id).reduce((a, w) => a + w.support, 0);
      const jitter = (createHash('sha1').update(`${seed}:${ens.id}`).digest().readUInt16BE(0) / 65536) * 0.15;
      const score =
        -1.2 * (Math.abs(ens.mood.intensity - mood.intensity) + Math.abs(ens.mood.brightness - mood.brightness)) -
        0.8 * staleness(lib, ens, ctx) -
        (tempo.beatless ? 0.3 : 0) -
        (ens.id === avoid?.id ? 3 : 0) -
        (ens.standby ? 1 : 0) +
        Math.min(1.5, wished) +
        (promised.has(ens.id) ? 2 : 0) +
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

function continueMovement(ctx: TurnContext, ens: Ensemble, tail: SectionSummary, own: boolean, count: 1 | 2, seed: number): Candidate {
  const movement = ctx.movement!;
  const scale = own ? tail.scale : movement.scale;
  const bpm = own ? tail.bpm : clampBpm(ens, movement.bpm);
  const used = usedNames(ctx);
  const roles = rolesFor(ctx, ens, count, tail.role);
  let prev: PrevView = tail;
  const sections = roles.map((role, i) => {
    const name = pick(ens.titles, used, seed + i);
    used.add(name);
    const { section, view } = arrangeSection({
      ensemble: ens,
      role,
      scale,
      bpm,
      rampBars: i === 0 ? rampFor(bpm, tail.bpm) : 0,
      bars: barsFor(role, bpm),
      prev,
      sameEnsemble: own || i > 0,
      beatless: false,
      targets: expectedTargets(ctx, i),
      name,
      seed: seed + i,
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
    const name = pick(closing.ensemble.titles, used, seed);
    used.add(name);
    const outro = arrangeSection({
      ensemble: closing.ensemble,
      role: 'outro',
      scale: closing.tail.scale,
      bpm: closing.tail.bpm,
      rampBars: 0,
      bars: barsFor('outro', closing.tail.bpm),
      prev: closing.tail,
      sameEnsemble: true,
      beatless: false,
      targets: null,
      name,
      seed,
    });
    sections.push(outro.section);
    prev = outro.view;
  }
  const roles = (['intro', 'groove'] as const).slice(0, count - sections.length);
  roles.forEach((role, i) => {
    const name = pick(ens.titles, used, seed + 1 + i);
    used.add(name);
    const arranged = arrangeSection({
      ensemble: ens,
      role,
      scale,
      bpm: choice.bpm,
      rampBars: i === 0 ? choice.rampBars : 0,
      bars: barsFor(role, choice.bpm),
      prev,
      sameEnsemble: i > 0,
      beatless: i === 0 && choice.beatless,
      targets: expectedTargets(ctx, sections.length),
      name,
      seed: seed + 1 + i,
    });
    sections.push(arranged.section);
    prev = arranged.view;
  });
  const sounds = [...(lib.sounds.get(ens.id) ?? [])];
  const movement: MovementPlan = {
    name: pick(ens.movementNames, new Set(ctx.movement ? [ctx.movement.name] : []), seed),
    startsAtSection: closes ? 1 : 0,
    bpm: choice.bpm,
    scale,
    groove: ens.groove,
    arcShape: ens.arc,
    form: formFor(ens, choice.bpm),
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
      if (wantsSide || tail.role === 'outro') {
        for (const choice of choices(own).slice(0, 2)) out.push(openMovement(lib, ctx, choice, tail.role === 'outro' ? null : { ensemble: own, tail }, count, seed));
      }
      out.push(continueMovement(ctx, own, tail, true, count, seed));
    } else {
      const run = carryRun(sectionNames(ctx));
      const bars = barsFor('groove', tail.bpm, ctx.rules.minPlanBars);
      const carry: Candidate = { plan: carryPlan(tail, run, bars, count), opens: null, kind: 'carry' };
      if (run < MAX_CARRY_RUN && !wantsSide) out.push(carry);
      const ranked = choices(null);
      // New material doesn't arrive just to wind a side down: when the arc says outro, open the next one.
      if (!wantsSide && ctx.expected[0]?.role !== 'outro') {
        for (const choice of ranked.filter((c) => fitsMovement(c.ensemble, ctx.movement!)).slice(0, 2)) {
          out.push(continueMovement(ctx, choice.ensemble, tail, false, count, seed));
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
