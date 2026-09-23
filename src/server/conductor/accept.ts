// Acceptance rules the schema can't express (ARCHITECTURE §6, §9). Pure functions returning Issues
// phrased for self-repair. The conductor runs them in order — plan shape, carried parts, the
// checker's findings, musical, tempo, novelty, dramaturgy — and relaxes novelty and dramaturgy to
// warnings for the scripted autopilot.
import { fingerprintDistance, type Issue, type SectionCheck, type SectionFingerprint } from '../../shared/analysis.ts';
import { PERCUSSIVE_ROLES, type PartRole, type SectionRole, type Span } from '../../shared/music.ts';
import type { Automation, Knob, Plan, SectionPlan } from '../../shared/plan.ts';
import { BREATH_MAX_BARS, CROSSFADE_MAX_BARS } from '../../shared/schedule.ts';
import { isPublicText } from '../../shared/text.ts';
import { budgetSeconds, BUDGET_WINDOW_MS, FLOOR_BUDGET_S, isPeakSpan, maxRun, PEAK_BUDGET_S, runLength, type BudgetSpan } from './arc.ts';
import type { ResolvedPart } from './compile.ts';
import { laneValue, lanesFor, levelAt } from './knobs.ts';

const err = (rule: string, message: string, path?: string, hint?: string): Issue => ({ severity: 'error', rule, message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
const warn = (rule: string, message: string, path?: string, hint?: string): Issue => ({ ...err(rule, message, path, hint), severity: 'warning' });
const round2 = (x: number) => Math.round(x * 100) / 100;

export const MIN_SECTION_BARS = 16;
export const MOVEMENT_MIN_AGE_MIN = 6;
export const MOVEMENT_MAX_AGE_MIN = 20;
export const MAX_BPM_IN_MOVEMENT = 4;
export const MAX_BPM_MOVEMENT_CHANGE = 12;
/** A switch this small is inaudible; larger changes ramp at least 1 bar per BPM (4 bars per 4 BPM). */
const TEMPO_SWITCH_BPM = 2;
const BUILD_RISE = 0.2;
const RELEASE_DROP = 0.1;
const SPAN_TOLERANCE = 0.2;
const MIN_SHARE_FOR_USE = 0.02;
const STASIS_DISTANCE = 0.05;
const STASIS_RUN = 3;

/** Novelty and dramaturgy become warnings for the scripted autopilot (it must never be blocked). */
export function relax(issues: Issue[]): Issue[] {
  return issues.map((i) => (i.severity === 'error' ? { ...i, severity: 'warning' as const, message: `${i.message} (relaxed for the autopilot)` } : i));
}

export const isBeatless = (parts: readonly { role: PartRole }[]) => !parts.some((p) => PERCUSSIVE_ROLES.has(p.role));
const halfOrDouble = (a: number, b: number) => [2, 0.5].some((r) => Math.abs(a / b - r) <= 0.03 * r);

// ─── Plan shape ──────────────────────────────────────────────────────────────────────────────────

export interface PlanRuleContext {
  hasRequest(id: string): boolean;
  /** Requests shown to the composer that still need a decision (empty when not required). */
  requiredRequestIds: readonly string[];
  requestsRelaxed: boolean;
  forkAllowed: boolean;
  catalogIds: ReadonlySet<string>;
}

function textIssues(plan: Plan): Issue[] {
  const out: Issue[] = [];
  const check = (value: string | null | undefined, path: string) => {
    if (value && !isPublicText(value)) out.push(err('text', 'Public text may not contain links, markup, angle brackets or control characters.', path, 'Rephrase it as plain words.'));
  };
  plan.sections.forEach((s, i) => {
    check(s.name, `sections[${i}].name`);
    check(s.publicNote, `sections[${i}].publicNote`);
  });
  if (plan.movement) {
    check(plan.movement.name, 'movement.name');
    check(plan.movement.blurb, 'movement.blurb');
  }
  if (plan.fork) {
    check(plan.fork.prompt, 'fork.prompt');
    plan.fork.options.forEach((o, i) => {
      check(o.label, `fork.options[${i}].label`);
      check(o.description, `fork.options[${i}].description`);
    });
  }
  plan.requestDecisions.forEach((d, i) => check(d.publicReply, `requestDecisions[${i}].publicReply`));
  check(plan.announcement, 'announcement');
  return out;
}

function sectionShapeIssues(s: SectionPlan, path: string): Issue[] {
  const out: Issue[] = [];
  const ids = new Set<string>();
  s.parts.forEach((p, j) => {
    const pp = `${path}.parts[${j}]`;
    if (ids.has(p.id)) out.push(err('schema', `Part id "${p.id}" appears twice in the section.`, pp, 'Give every part its own id.'));
    ids.add(p.id);
    if (p.enterBar >= s.bars) out.push(err('schema', `enterBar ${p.enterBar} is not inside the section's ${s.bars} bars.`, `${pp}.enterBar`));
    if (p.exitBar !== null && (p.exitBar <= p.enterBar || p.exitBar > s.bars)) {
      out.push(err('schema', `exitBar ${p.exitBar} must be after enterBar ${p.enterBar} and at most ${s.bars}.`, `${pp}.exitBar`, 'Use null to play to the end.'));
    }
    if (p.code === null && !p.restart && p.enterBar !== 0) {
      out.push(err('carry', `A continuing part is already playing, so it enters at bar 0 (got ${p.enterBar}).`, `${pp}.enterBar`, 'Set enterBar 0, or restart: true to bring it back in later.'));
    }
    const names = new Set<string>();
    p.knobs.forEach((k, n) => {
      const kp = `${pp}.knobs[${n}]`;
      if (names.has(k.name)) out.push(err('schema', `Knob "${k.name}" is declared twice.`, kp));
      names.add(k.name);
      if (![k.min, k.max, k.default].every(Number.isFinite) || !(k.min < k.max) || k.default < k.min || k.default > k.max) {
        out.push(err('schema', `Knob "${k.name}" needs min < max and min ≤ default ≤ max (got ${k.min}, ${k.default}, ${k.max}).`, kp));
      }
    });
    const byTarget = new Map<string, { from: number; to: number }[]>();
    p.automation.forEach((a, n) => {
      const ap = `${pp}.automation[${n}]`;
      if (!(a.target === 'level' || a.target.startsWith('knob:'))) out.push(err('schema', `Automation target "${a.target}" must be "level" or "knob:<name>".`, ap));
      if (a.fromBar >= a.toBar || a.toBar > s.bars) out.push(err('schema', `Automation runs from bar ${a.fromBar} to ${a.toBar}; it must move forward and end by bar ${s.bars}.`, ap));
      if (a.target === 'level' && [a.from, a.to].some((v) => v < 0 || v > 1)) out.push(err('schema', 'Level automation values are faders between 0 and 1.', ap));
      const lanes = byTarget.get(a.target) ?? [];
      if (lanes.some((l) => a.fromBar < l.to && l.from < a.toBar)) {
        out.push(err('schema', `Automation lanes on "${a.target}" overlap.`, ap, 'Make lanes on the same target follow each other.'));
      }
      lanes.push({ from: a.fromBar, to: a.toBar });
      byTarget.set(a.target, lanes);
    });
  });
  s.parts.forEach((p, j) => {
    for (const t of p.duck?.targets ?? []) {
      if (t === p.id || !ids.has(t)) out.push(err('schema', `Duck target "${t}" must be another part of this section.`, `${path}.parts[${j}].duck`));
    }
  });
  if (s.tempoRampBars > s.bars) out.push(err('tempo', `tempoRampBars ${s.tempoRampBars} is longer than the section (${s.bars} bars).`, `${path}.tempoRampBars`));
  const t = s.transitionIn;
  if (t.type === 'crossfade' && t.bars > Math.min(CROSSFADE_MAX_BARS, s.bars / 2)) {
    out.push(err('schema', `A crossfade lasts at most ${Math.min(CROSSFADE_MAX_BARS, s.bars / 2)} bars here (≤ 8 and ≤ half the section).`, `${path}.transitionIn.bars`));
  }
  if (t.type === 'breath' && t.bars > BREATH_MAX_BARS) out.push(err('schema', `A breath lasts at most ${BREATH_MAX_BARS} bars.`, `${path}.transitionIn.bars`));
  if (t.type !== 'cut' && t.bars < 1) out.push(err('schema', `A ${t.type} needs at least 1 bar.`, `${path}.transitionIn.bars`));
  return out;
}

function decisionIssues(plan: Plan, ctx: PlanRuleContext): Issue[] {
  const out: Issue[] = [];
  const unknown = ctx.requestsRelaxed ? warn : err;
  const seen = new Set<string>();
  plan.requestDecisions.forEach((d, i) => {
    const path = `requestDecisions[${i}]`;
    if (seen.has(d.requestId)) out.push(err('request', `Request ${d.requestId} is decided twice.`, path));
    seen.add(d.requestId);
    if (!ctx.hasRequest(d.requestId)) out.push(unknown('request', `Unknown request id "${d.requestId}".`, path, 'Decide only requests listed in crowd.requests or crowd.promises.'));
    if (d.decision === 'this-plan' && (d.sectionIndex === null || d.sectionIndex >= plan.sections.length)) {
      out.push(err('request', '"this-plan" needs sectionIndex pointing at the section that honours it.', `${path}.sectionIndex`));
    }
    if (d.decision === 'merged' && (!d.mergedInto || !ctx.hasRequest(d.mergedInto))) out.push(err('request', '"merged" needs mergedInto naming a known request.', `${path}.mergedInto`));
    if (d.decision === 'fork-option' && !plan.fork?.options.some((o) => o.requestId === d.requestId)) {
      out.push(warn('request', `Request ${d.requestId} is decided "fork-option" but no fork option carries it.`, path));
    }
  });
  const missing = ctx.requiredRequestIds.filter((id) => !seen.has(id) && ctx.hasRequest(id));
  if (missing.length) {
    out.push(err('request', `Decide every request you were shown; missing: ${missing.join(', ')}.`, 'requestDecisions', 'Add a decision (this-plan, next-movement, fork-option, merged or declined) with a short public reply.'));
  }
  return out;
}

function forkIssues(plan: Plan, ctx: PlanRuleContext): Issue[] {
  const f = plan.fork;
  if (!f) return [];
  if (!ctx.forkAllowed) return [warn('fork', 'A fork is not allowed right now (one every few minutes); it was dropped.', 'fork')];
  const out: Issue[] = [];
  const ids = f.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) out.push(err('fork', 'Fork option ids must be distinct.', 'fork.options'));
  if (!ids.includes(f.defaultOption)) out.push(err('fork', `defaultOption ${f.defaultOption} is not one of the options.`, 'fork.defaultOption'));
  f.options.forEach((o, i) => {
    if (o.requestId && !ctx.hasRequest(o.requestId)) out.push(warn('fork', `Option ${o.id} refers to unknown request ${o.requestId}.`, `fork.options[${i}].requestId`));
  });
  return out;
}

function movementIssues(plan: Plan, ctx: PlanRuleContext): Issue[] {
  const m = plan.movement;
  if (!m) return [];
  const out: Issue[] = [];
  if (m.startsAtSection >= plan.sections.length) out.push(err('schema', `startsAtSection ${m.startsAtSection} points past the plan's ${plan.sections.length} section(s).`, 'movement.startsAtSection'));
  const unknownIds = m.palette.filter((id) => !ctx.catalogIds.has(id.toLowerCase()));
  if (unknownIds.length) out.push(warn('palette', `Palette ids not in the catalog: ${unknownIds.join(', ')}.`, 'movement.palette'));
  const loose = m.signature.filter((id) => !m.palette.includes(id));
  if (loose.length) out.push(warn('palette', `Signature sounds should be part of the palette: ${loose.join(', ')}.`, 'movement.signature'));
  return out;
}

export function planIssues(plan: Plan, ctx: PlanRuleContext): Issue[] {
  return [
    ...textIssues(plan),
    ...plan.sections.flatMap((s, i) => sectionShapeIssues(s, `sections[${i}]`)),
    ...decisionIssues(plan, ctx),
    ...forkIssues(plan, ctx),
    ...movementIssues(plan, ctx),
  ];
}

/** Rules that need carried knobs resolved, and the section before (pre-roll must fit inside it). */
export function resolvedIssues(s: SectionPlan, parts: readonly ResolvedPart[], path: string, prevPlayBars: number | null): Issue[] {
  const out: Issue[] = [];
  parts.forEach((p, j) => {
    const pp = `${path}.parts[${j}]`;
    p.automation.forEach((a, n) => {
      if (!a.target.startsWith('knob:')) return;
      const knob = p.knobs.find((k) => `knob:${k.name}` === a.target);
      if (!knob) out.push(err('knob-undeclared', `Automation targets ${a.target}, which part "${p.id}" does not declare.`, `${pp}.automation[${n}]`));
      else if ([a.from, a.to].some((v) => v < knob.min || v > knob.max)) {
        out.push(err('schema', `Automation of ${a.target} leaves the knob's range ${knob.min}–${knob.max}.`, `${pp}.automation[${n}]`));
      }
    });
  });
  if (prevPlayBars !== null) {
    const t = s.transitionIn;
    const preRoll = Math.max(t.type === 'riser' || t.type === 'breath' || t.type === 'filter' ? t.bars : 0, ...parts.map((p) => -Math.min(0, p.enterBar)));
    if (preRoll > prevPlayBars) out.push(err('schema', `Pre-roll of ${preRoll} bars (transition or pickups) is longer than the section before it (${prevPlayBars} bars).`, `${path}.transitionIn`));
    if (t.type === 'crossfade' && t.bars > prevPlayBars / 2) out.push(err('schema', `A crossfade may last at most half of the section before it (${prevPlayBars / 2} bars).`, `${path}.transitionIn.bars`));
  }
  return out;
}

// ─── Checker findings and musical rules ─────────────────────────────────────────────────────────

/** The checker's issues with plan paths ("sections[1].parts[2]" instead of the part id). */
export function checkIssues(check: SectionCheck, parts: readonly { id: string }[], path: string): Issue[] {
  const locate = (i: Issue): Issue => {
    const j = parts.findIndex((p) => p.id === i.path);
    return { ...i, path: j >= 0 ? `${path}.parts[${j}] (${i.path})` : `${path}${i.path ? `.${i.path}` : ''}` };
  };
  return [...check.errors, ...check.warnings, ...check.parts.flatMap((p) => [...p.errors, ...p.warnings])].map(locate);
}

export function musicalIssues(s: SectionPlan, check: SectionCheck, path: string): Issue[] {
  const out: Issue[] = [];
  check.parts.forEach((p) => {
    const plan = s.parts.find((x) => x.id === p.id);
    const median = p.analysis?.pitch?.medianMidi;
    if (plan?.role !== 'bass' || median === undefined) return;
    const where = `${path}.parts[${s.parts.indexOf(plan)}] (${p.id})`;
    if (median >= 72) out.push(err('register', `The bass part sits around MIDI ${Math.round(median)}, far above a bass register.`, where, 'Play it an octave or two lower, or give it another role (lead, arp).'));
    else if (median >= 60) out.push(warn('register', `The bass part sits around MIDI ${Math.round(median)}; bass usually lives below C4.`, where));
  });
  const spans = check.mix?.spans;
  if (spans) {
    for (const key of ['intensity', 'brightness', 'density', 'tension'] as const) {
      const t = s.targets[key];
      const m = spans[key];
      if (Math.abs(m.start - t.start) > SPAN_TOLERANCE || Math.abs(m.end - t.end) > SPAN_TOLERANCE) {
        out.push(warn('targets', `Measured ${key} ${m.start}→${m.end} is more than ${SPAN_TOLERANCE} away from the target ${t.start}→${t.end}.`, `${path}.targets.${key}`, 'Adjust the parts or restate the target to what the section does.'));
      }
    }
  }
  return out;
}

// ─── Tempo ──────────────────────────────────────────────────────────────────────────────────────

export interface TempoInput {
  sections: { plan: SectionPlan; movementBpm: number; fromBpm: number; opensMovement: boolean; prevBeatless: boolean }[];
  /** Tempo centre of the movement being left, when the plan opens a new one. */
  oldMovementBpm: number | null;
}

export function tempoIssues(input: TempoInput): Issue[] {
  const out: Issue[] = [];
  input.sections.forEach(({ plan: s, movementBpm, fromBpm, opensMovement, prevBeatless }, i) => {
    const path = `sections[${i}]`;
    const beatless = isBeatless(s.parts);
    if (Math.abs(s.bpm - movementBpm) > MAX_BPM_IN_MOVEMENT) {
      out.push(err('tempo', `${s.bpm} BPM is more than ${MAX_BPM_IN_MOVEMENT} from its movement's centre (${movementBpm}).`, `${path}.bpm`, `Stay within ${movementBpm - 4}–${movementBpm + 4}, or open a new movement.`));
    }
    const delta = Math.abs(s.bpm - fromBpm);
    if (delta > TEMPO_SWITCH_BPM && s.tempoRampBars < delta && !beatless && !halfOrDouble(s.bpm, fromBpm)) {
      out.push(err('tempo', `Moving ${round2(delta)} BPM (from ${fromBpm}) needs a ramp of at least ${Math.ceil(delta)} bars (4 bars per 4 BPM).`, `${path}.tempoRampBars`));
    }
    if (opensMovement && input.oldMovementBpm !== null) {
      const jump = Math.abs(movementBpm - input.oldMovementBpm);
      if (jump > MAX_BPM_MOVEMENT_CHANGE && !beatless && !prevBeatless && !halfOrDouble(movementBpm, input.oldMovementBpm)) {
        out.push(err('tempo', `A new movement may move at most ${MAX_BPM_MOVEMENT_CHANGE} BPM (${input.oldMovementBpm} → ${movementBpm}) unless through a beatless bridge or half/double time.`, 'movement.bpm',
          'Put a section with no percussive parts at the change, or pick a tempo within 12 BPM (or exactly half/double).'));
      }
    }
  });
  return out;
}

// ─── Novelty ────────────────────────────────────────────────────────────────────────────────────

export interface NoveltySection {
  plan: SectionPlan;
  fingerprint: SectionFingerprint | null;
  movementId: string;
  opensMovement: boolean;
}

export interface NoveltyInput {
  sections: NoveltySection[];
  similar(fp: SectionFingerprint, movementId: string): { sectionId: string; distance: number } | null;
  /** Accepted reprises of earlier movements within the last 30 min. */
  crossReprisesRecent: number;
  /** Fingerprints of the movement's sections so far (heard and committed), in order. */
  movementFingerprints(movementId: string): SectionFingerprint[];
  /** Sounds already heard or committed in the movement. */
  movementSounds(movementId: string): ReadonlySet<string>;
  cooldown: ReadonlySet<string>;
  signature(movementId: string): readonly string[];
  /** The crate drawn for the movement this plan opens (null when it opens none). */
  crate: readonly string[] | null;
}

const usedSounds = (fp: SectionFingerprint | null) => Object.entries(fp?.soundShares ?? {}).filter(([, share]) => share >= MIN_SHARE_FOR_USE).map(([id]) => id);

export function noveltyIssues(input: NoveltyInput): Issue[] {
  const out: Issue[] = [];
  const plannedFps = new Map<string, SectionFingerprint[]>();
  const plannedSounds = new Map<string, Set<string>>();
  let reprises = input.crossReprisesRecent;
  input.sections.forEach((s, i) => {
    const path = `sections[${i}]`;
    const fp = s.fingerprint;
    if (fp) {
      const hit = input.similar(fp, s.movementId);
      if (hit && !s.plan.reprise) {
        out.push(err('similarity', `Too close to ${hit.sectionId} from an earlier movement (distance ${hit.distance} < 0.15).`, path,
          'Change the sounds, groove or harmony — or set reprise to that id if the callback is deliberate.'));
      } else if (hit && s.plan.reprise) {
        if (reprises >= 1) out.push(err('similarity', 'Only one callback to an earlier movement per 30 minutes.', `${path}.reprise`, 'Make it new, or keep the callback for later.'));
        reprises++;
      }
      const history = [...input.movementFingerprints(s.movementId), ...(plannedFps.get(s.movementId) ?? [])];
      const chain = [...history.slice(-STASIS_RUN), fp];
      if (chain.length === STASIS_RUN + 1 && chain.slice(1).every((f, k) => fingerprintDistance(f, chain[k]!) < STASIS_DISTANCE)) {
        out.push(warn('stasis', `This is the ${STASIS_RUN}rd section running that barely differs from the one before.`, path, 'Evolve something: a part, the groove, the harmony or the register.'));
      }
      plannedFps.set(s.movementId, [...(plannedFps.get(s.movementId) ?? []), fp]);
    }
    const heard = new Set([...input.movementSounds(s.movementId), ...(plannedSounds.get(s.movementId) ?? [])]);
    const signature = new Set(input.signature(s.movementId));
    const introduced = usedSounds(fp).filter((id) => !heard.has(id) && input.cooldown.has(id) && !signature.has(id));
    if (introduced.length) {
      out.push(err('cooldown', `Introduces sounds that are resting after heavy use: ${introduced.join(', ')}.`, path, 'Dig into the crate instead, or name up to 3 of them as the movement\'s signature.'));
    }
    plannedSounds.set(s.movementId, new Set([...heard, ...usedSounds(fp)]));
  });
  const opened = input.sections.find((s) => s.opensMovement)?.movementId;
  if (input.crate && opened) {
    const opening = input.sections.filter((s) => s.movementId === opened);
    const crate = new Set(input.crate);
    const used = new Set(opening.flatMap((s) => usedSounds(s.fingerprint)).filter((id) => crate.has(id)));
    if (used.size < 2) {
      out.push(err('crate', `A new movement uses at least 2 sounds from its crate (uses ${used.size}).`, 'movement', `Crate: ${input.crate.slice(0, 16).join(', ')}.`));
    }
  }
  return out;
}

// ─── Dramaturgy ─────────────────────────────────────────────────────────────────────────────────

export interface DramaturgyEntry {
  role: SectionRole;
  span: BudgetSpan;
  tension: Span;
}

/** A part as the build rule reads its automation (carried knobs resolved). */
export interface AutomatedPart {
  level: number;
  enterBar: number;
  exitBar: number | null;
  knobs: readonly Knob[];
  automation: readonly Automation[];
}

/** The analyzer's spans compare the first and last 4 bars. */
const EDGE_BARS = 4;

/**
 * The rise a section's automation lanes add, which its measured spans leave out (the checker plays the
 * code at static faders and default knob values). Intensity: the measured end scaled by how much of the
 * mix's fader level (lanes, entries and exits) is still missing in the first bars. Tension: knobs swept
 * toward their bright or intense end (the axis they follow; toward max when they follow none), weighted
 * by each part's share of the end mix, up to the +0.3 a brightening mix can measure (half the mix swept
 * across the whole range).
 */
export function automationRise(parts: readonly AutomatedPart[], bars: number, measuredEnd: number): { intensity: number; tension: number } {
  const edge = Math.min(EDGE_BARS, bars);
  const mean = (xs: number[]) => xs.reduce((a, x) => a + x, 0) / Math.max(1, xs.length);
  const windowFrom = (from: number) => Array.from({ length: edge }, (_, i) => from + i + 0.5);
  const sounding = (p: AutomatedPart, bar: number) => bar >= p.enterBar && (p.exitBar === null || bar < p.exitBar);
  const faderIn = (p: AutomatedPart, from: number) => mean(windowFrom(from).map((b) => (sounding(p, b) ? levelAt(p, b) : 0)));
  const startLevels = parts.map((p) => faderIn(p, 0));
  const endLevels = parts.map((p) => faderIn(p, bars - edge));
  const start = startLevels.reduce((a, x) => a + x, 0);
  const end = endLevels.reduce((a, x) => a + x, 0);
  if (end <= 0) return { intensity: 0, tension: 0 };
  const intensity = measuredEnd * Math.min(1, Math.max(0, 1 - start / end));

  let swept = 0;
  parts.forEach((p, i) => {
    let best = 0;
    for (const k of p.knobs) {
      const lanes = lanesFor(p.automation, `knob:${k.name}`);
      if (!lanes.length || k.max <= k.min) continue;
      const position = (v: number) => {
        const x = Math.min(k.max, Math.max(k.min, v));
        return k.min > 0 ? Math.log(x / k.min) / Math.log(k.max / k.min) : (x - k.min) / (k.max - k.min);
      };
      const at = (from: number) => mean(windowFrom(from).map((b) => position(laneValue(lanes, b, k.default))));
      const direction = k.follows.startsWith('-') ? -1 : 1;
      best = Math.max(best, direction * (at(bars - edge) - at(0)));
    }
    swept += (endLevels[i]! / end) * best;
  });
  return { intensity, tension: 0.3 * Math.min(1, Math.max(0, 2 * swept)) };
}

export interface DramaturgyInput {
  /** Played and committed sections before the plan, in playing order. */
  before: DramaturgyEntry[];
  sections: (DramaturgyEntry & { plan: SectionPlan; parts: readonly AutomatedPart[]; measured: { intensity: Span; tension: Span } })[];
  /** Age of the movement the plan follows (null before the first one). */
  movementAgeMin: number | null;
  opensMovement: boolean;
  planBars: { min: number; max: number };
}

export function dramaturgyIssues(input: DramaturgyInput): Issue[] {
  const out: Issue[] = [];
  const all = [...input.before];
  input.sections.forEach((s, i) => {
    const path = `sections[${i}]`;
    const prev = all[all.length - 1];
    const roles = [...all.map((e) => e.role), s.role];
    if (runLength(roles, s.role) > maxRun(s.role)) {
      out.push(err('dramaturgy', `A "${s.role}" section ${maxRun(s.role) + 1} times running; the same role plays at most ${s.role === 'groove' ? 'three' : 'twice'} in a row.`, `${path}.role`));
    }
    if (s.plan.bars < MIN_SECTION_BARS && s.role !== 'transition') out.push(err('dramaturgy', `Sections run at least ${MIN_SECTION_BARS} bars (only transitions may be shorter).`, `${path}.bars`));

    const spans = [...all.map((e) => e.span), s.span];
    const from = s.span.endMs - BUDGET_WINDOW_MS;
    const mine = budgetSeconds([s.span], from, s.span.endMs);
    const total = budgetSeconds(spans, from, s.span.endMs);
    if (mine.peak > 0 && total.peak > PEAK_BUDGET_S) {
      out.push(err('dramaturgy', `Peak budget: ${Math.round(total.peak)} s at peak intensity (≥ ${round2(s.span.peakAt)}) within 10 minutes; at most ${PEAK_BUDGET_S} s.`, `${path}.targets.intensity`, 'Let this section sit below the peak.'));
    }
    if (mine.floor > 0 && total.floor > FLOOR_BUDGET_S) {
      out.push(err('dramaturgy', `Floor budget: ${Math.round(total.floor)} s near silence (≤ 0.2) within 10 minutes; at most ${FLOOR_BUDGET_S} s.`, `${path}.targets.intensity`, 'Lift the intensity above 0.2.'));
    }
    if (isPeakSpan(s.span)) {
      let run = 1;
      for (let k = all.length - 1; k >= 0 && isPeakSpan(all[k]!.span); k--) run++;
      if (run >= 3) out.push(err('dramaturgy', 'Three peak sections in a row; give the room a breath between peaks.', `${path}.targets.intensity`));
    }
    if (s.role === 'build') {
      const measured = Math.max(s.measured.intensity.end - s.measured.intensity.start, s.measured.tension.end - s.measured.tension.start);
      const lanes = automationRise(s.parts, s.plan.bars, s.measured.intensity.end);
      const automated = Math.max(lanes.intensity, lanes.tension);
      if (Math.max(measured, automated) < BUILD_RISE) {
        out.push(err('dramaturgy', `A build must measure at least ${BUILD_RISE} more intense or tense at its end than its start (measured +${round2(measured)}, automation +${round2(automated)}).`, path,
          'Add density toward the end, bring parts in late, fade the mix up with level lanes, or sweep knobs toward their bright end (toward max when they follow nothing).'));
      }
    }
    if (prev?.role === 'build' && s.tension.start > prev.tension.end - RELEASE_DROP) {
      out.push(err('dramaturgy', `After a build, start with less tension than it ends with (${prev.tension.end} → ${s.tension.start}).`, `${path}.targets.tension`));
    }
    all.push(s);
  });
  const age = input.movementAgeMin;
  if (age !== null && input.opensMovement && age < MOVEMENT_MIN_AGE_MIN) {
    out.push(err('dramaturgy', `The current movement is only ${Math.round(age)} min old; movements run 6–20 minutes.`, 'movement', 'Continue it with sections for now.'));
  }
  if (age !== null && !input.opensMovement && age >= MOVEMENT_MAX_AGE_MIN) {
    out.push(err('dramaturgy', `This movement has run ${Math.round(age)} minutes; open a new one (movements end by ${MOVEMENT_MAX_AGE_MIN}).`, 'movement', 'Add a movement (startsAtSection 1 lets the first section close this one).'));
  }
  const bars = input.sections.reduce((a, s) => a + s.plan.bars, 0);
  if (bars < input.planBars.min || bars > input.planBars.max) {
    out.push(warn('plan-length', `The plan adds ${bars} bars; aim for ${input.planBars.min}–${input.planBars.max}.`, 'sections'));
  }
  return out;
}
