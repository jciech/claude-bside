// buildTurnContext: everything a composer sees for one planning request, as plain JSON (no Maps, no
// functions) and lean on tokens — rounded numbers, capped lists, code only where carrying needs it.
// Pure: the conductor gathers the inputs (schedule, ledger digests, crowd summary, budgets).
import type { CrateItem, LedgerRow, PersistedSession } from '../types.ts';
import type { CrowdSummary, PlanReason, ReplacedSection, SectionSummary, TurnContext } from '../../shared/composer-api.ts';
import type { PartDigest } from '../../shared/analysis.ts';
import { BPM_MAX, BPM_MIN, cpsToBpm, MAX_PARTS_PER_SECTION, SECTION_LENGTHS, type SectionRole } from '../../shared/music.ts';
import type { ProgramPart, SectionProgram } from '../../shared/program.ts';
import { cpsAtMs, cycleAtMs, msAtCycle, type Timeline } from '../../shared/timeline.ts';
import { budgetState, expectedSections, type Arc, type BudgetSpan } from './arc.ts';
import { knobValuesAt } from './knobs.ts';
import { patternBarAt, plannedEnd } from './placement.ts';

export type MovementState = PersistedSession['movements'][number];

const HISTORY_ROWS = 12;
const REPRISE_CANDIDATES = 4;
const RECENT_SCALES = 6;

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Plan size bounds in bars at a tempo: between max(16 bars, 60 s) and max(48 bars, 100 s). */
export function planBarBounds(secondsPerBar: number): { min: number; max: number } {
  return { min: Math.max(16, Math.ceil(60 / secondsPerBar)), max: Math.max(48, Math.floor(100 / secondsPerBar)) };
}

export interface TurnContextInput {
  nowMs: number;
  timeline: Timeline;
  scheduleRev: number;
  request: {
    id: string;
    kind: 'section' | 'movement';
    reasons: PlanReason[];
    softDeadlineMs: number;
    hardDeadlineMs: number;
    targetCycle: number;
    sectionsWanted: 1 | 2;
    replaces: string[];
    vamping: boolean;
  };
  /** Live schedule: the previous section, the current one and everything committed, by startCycle. */
  sections: readonly SectionProgram[];
  /** The movement the plan continues (the tail's), or null before the first one. */
  movement: MovementState | null;
  movementAgeMin: number;
  /** Arc a new movement would start from (the room-bent baseline). */
  newMovementArc: Arc;
  crowd: CrowdSummary;
  /** Ledger rows of the last 2 h, oldest first. */
  history: readonly LedgerRow[];
  lovedMoments: TurnContext['history']['lovedMoments'];
  cooldown: string[];
  flags: string[];
  crate: CrateItem[];
  health: TurnContext['health'];
  forkAllowed: boolean;
  /** Played and committed music (kept sections only), for the budgets. */
  budget: readonly BudgetSpan[];
  /** Roles of played and kept committed sections, in order. */
  lastRoles: SectionRole[];
  peakRun: number;
}

const emptyDigest = (p: ProgramPart): PartDigest => ({
  id: p.id,
  role: p.role,
  instrument: p.instrument,
  evPerBar: 0,
  register: null,
  sync: 0,
  bright: 0,
  loud: 0,
  period: null,
  keyFit: null,
});

/** Section summaries in schedule order. Carried parts' knob defaults already hold their starting values. */
export function summarizeSections(sections: readonly SectionProgram[]): Map<string, SectionSummary> {
  const out = new Map<string, SectionSummary>();
  for (const s of sections) {
    const ids = new Map(s.parts.map((p) => [p.orbit, p.id]));
    const parts = s.parts.map((p) => ({
      ...(p.digest ?? emptyDigest(p)),
      code: p.code,
      level: p.level,
      enterBar: p.enterBar,
      exitBar: p.exitBar,
      knobs: p.knobs,
      knobValuesAtEnd: knobValuesAt(p, s.bars, null),
      duck: p.duck ? { targets: p.duck.orbits.map((o) => ids.get(o)).filter((x): x is string => !!x), depth: p.duck.depth, releaseSec: p.duck.releaseSec } : null,
      chromatic: p.chromatic,
      patternBarAtEnd: patternBarAt(s, p, plannedEnd(s)),
    }));
    out.set(s.id, {
      id: s.id,
      name: s.name,
      role: s.role,
      startCycle: s.startCycle,
      bars: s.bars,
      bpm: s.tempo.toBpm,
      scale: s.scale,
      chords: s.chords,
      provisional: s.provisional,
      targets: s.targets,
      measured: s.measured,
      parts,
    });
  }
  return out;
}

export function buildTurnContext(input: TurnContextInput): TurnContext {
  const { nowMs, timeline: tl, movement } = input;
  const nowCycle = cycleAtMs(tl, nowMs);
  const bpm = cpsToBpm(cpsAtMs(tl, nowMs));
  const secondsPerBar = 240 / bpm;
  const summaries = summarizeSections(input.sections);
  const current = [...input.sections].reverse().find((s) => s.startCycle <= nowCycle) ?? null;
  const replaced = new Set(input.request.replaces);
  const committed = input.sections.filter((s) => s.startCycle > nowCycle && !replaced.has(s.id));
  const replacing = input.sections.filter((s) => replaced.has(s.id)).map((s): ReplacedSection => {
    const { id, name, role, startCycle, bars, bpm, scale, chords, parts } = summaries.get(s.id)!;
    return { id, name, role, startCycle, bars, bpm, scale, chords, parts: parts.map((p) => ({ id: p.id, role: p.role, instrument: p.instrument })) };
  });
  const bounds = planBarBounds(secondsPerBar);

  const arc: Arc = movement
    ? { baseline: movement.baseline, amplitude: movement.amplitude, arcShape: movement.arcShape, groove: movement.groove }
    : input.newMovementArc;
  const sectionsSoFar = movement ? movement.tracks.length + committed.filter((s) => s.movementId === movement.id).length : 0;
  const expected = expectedSections({
    arc,
    progress: movement ? Math.max(0, (input.request.targetCycle - movement.startCycle) / Math.max(1, movement.plannedBars)) : 0,
    progressPerBar: movement ? 1 / Math.max(1, movement.plannedBars) : 0,
    ageMin: input.movementAgeMin,
    startCycle: input.request.targetCycle,
    count: input.request.sectionsWanted,
    newMovement: input.request.kind === 'movement' ? input.newMovementArc : null,
    lastRoles: input.lastRoles,
    formSteps: movement ? movement.form.slice(sectionsSoFar) : [],
    budget: budgetState(input.budget, nowMs, msAtCycle(tl, input.request.targetCycle)),
    peakRun: input.peakRun,
    secondsPerBar,
  });

  const rows = input.history;
  const lastRows = rows.slice(-HISTORY_ROWS);
  const loved = new Set(input.lovedMoments.map((m) => m.sectionId));
  const candidates = [
    ...rows.filter((r) => movement && r.movementId === movement.id).slice(-(REPRISE_CANDIDATES - 1)),
    ...rows.filter((r) => loved.has(r.sectionId)),
  ].filter((r, i, all) => all.findIndex((x) => x.sectionId === r.sectionId) === i);
  const scales = [...new Set([...input.history].reverse().map((r) => r.scale))].slice(0, RECENT_SCALES);

  return {
    request: {
      id: input.request.id,
      kind: input.request.kind,
      reasons: input.request.reasons,
      softDeadlineSec: Math.max(0, Math.round((input.request.softDeadlineMs - nowMs) / 1000)),
      hardDeadlineSec: Math.max(0, Math.round((input.request.hardDeadlineMs - nowMs) / 1000)),
      sectionsWanted: input.request.sectionsWanted,
      startCycle: input.request.targetCycle,
      replaces: input.request.replaces,
      replacing,
      vamping: input.request.vamping,
      scheduleRev: input.scheduleRev,
    },
    clock: { cycle: round2(nowCycle), bpm: round2(bpm), secondsPerBar: round2(secondsPerBar) },
    movement: movement
      ? {
          id: movement.id,
          name: movement.name,
          ageMin: round1(input.movementAgeMin),
          bpm: movement.bpm,
          scale: movement.scale,
          groove: movement.groove,
          arcShape: movement.arcShape,
          baseline: movement.baseline,
          progress: round2(Math.min(1, Math.max(0, (nowCycle - movement.startCycle) / Math.max(1, movement.plannedBars)))),
          signature: movement.signature,
          palette: movement.palette,
        }
      : null,
    now: current ? { ...summaries.get(current.id)!, barsLeft: Math.max(0, Math.round(plannedEnd(current) - nowCycle)) } : null,
    committed: committed.map((s) => summaries.get(s.id)!),
    expected,
    crowd: input.crowd,
    memory: {
      lastRationale: movement?.lastRationale ?? null,
      movementIntent: movement ? `${movement.name}: ${movement.blurb}` : null,
      form: movement?.form ?? [],
      motifs: movement?.motifs ?? [],
    },
    history: {
      sections: lastRows.map((r) => ({
        id: r.sectionId,
        name: r.name,
        role: r.role,
        bpm: r.bpm,
        scale: r.scale,
        sounds: r.sounds.slice(0, 4).map((s) => s.id),
        intensity: round2(r.measured.intensity),
        fireZ: round1(r.crowd?.fireZ ?? 0),
        keep: round2(r.crowd?.keep ?? 0),
      })),
      lovedMoments: input.lovedMoments,
      repriseCandidates: candidates.slice(-REPRISE_CANDIDATES).map((r) => ({ sectionId: r.sectionId, name: r.name, role: r.role, parts: r.parts })),
      recentScales: scales,
    },
    novelty: { cooldown: input.cooldown, flags: input.flags, crate: input.crate },
    health: input.health,
    rules: {
      bpm: movement ? [Math.max(BPM_MIN, movement.bpm - 4), Math.min(BPM_MAX, movement.bpm + 4)] : [BPM_MIN, BPM_MAX],
      maxBpmDeltaInMovement: 4,
      sectionLengths: [...SECTION_LENGTHS],
      maxParts: MAX_PARTS_PER_SECTION,
      minPlanBars: bounds.min,
      maxPlanBars: bounds.max,
      forkAllowed: input.forkAllowed,
      budget: { ...budgetState(input.budget, nowMs, msAtCycle(tl, input.request.targetCycle)), lastRoles: input.lastRoles.slice(-6) },
    },
  };
}
