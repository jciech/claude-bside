// From an accepted SectionPlan to the SectionProgram every client renders (ARCHITECTURE §5–6):
// carried parts resolved against the previous instance, pattern origins that make continuing parts
// carry on exactly where they were, orbits per instance, sidechain targets as orbits, the vamp rule,
// measured spans from the checker, and balance trims toward role loudness targets.
import type { Issue, PartCheck, SectionCheck } from '../../shared/analysis.ts';
import type { Automation, Knob, Plan, SectionPlan } from '../../shared/plan.ts';
import type { PartRole, SectionRole } from '../../shared/music.ts';
import type { ProgramPart, SectionProgram } from '../../shared/program.ts';
import type { CheckSectionInput } from '../types.ts';
import { vampLoopFor } from '../../shared/schedule.ts';
import { levelAt } from './knobs.ts';
import { patternBarAt } from './placement.ts';

export const ORBITS = 24;
const NO_VAMP: ReadonlySet<SectionRole> = new Set(['build', 'transition', 'intro', 'outro']);

/** Pre-master RMS targets per role (dBFS); parts further than ±4 dB away are trimmed toward them. */
export const ROLE_RMS_TARGET: Record<PartRole, number> = {
  kick: -12,
  snare: -15,
  hats: -20,
  perc: -18,
  breaks: -14,
  bass: -14,
  chords: -18,
  arp: -19,
  lead: -16,
  pad: -20,
  texture: -24,
  vox: -17,
};
const TRIM_DEADBAND_DB = 4;
const TRIM_RANGE_DB: [number, number] = [-6, 3];

export interface ResolvedPart {
  id: string;
  role: PartRole;
  code: string;
  knobs: Knob[];
  chromatic: boolean;
  level: number;
  enterBar: number;
  exitBar: number | null;
  automation: Automation[];
  duckTargets: { targets: string[]; depth: number; releaseSec: number } | null;
  /** Code identical to the previous section's same-id part. */
  carried: boolean;
  /** Carried without restart: one uninterrupted instance with the previous one. */
  continues: boolean;
}

/** The section before, as far as carrying needs it (a compiled program or the plan's previous section). */
export interface CarrySource {
  name: string;
  parts: readonly { id: string; code: string; knobs: readonly Knob[] }[];
}

export function resolveSection(plan: SectionPlan, prev: CarrySource | null, path: string): { parts: ResolvedPart[]; errors: Issue[] } {
  const errors: Issue[] = [];
  const parts: ResolvedPart[] = [];
  plan.parts.forEach((p, i) => {
    const before = prev?.parts.find((x) => x.id === p.id) ?? null;
    let code = p.code;
    let knobs = p.knobs;
    if (code === null) {
      if (!before) {
        errors.push({
          severity: 'error',
          rule: 'carry',
          message: `Part "${p.id}" is carried (code null) but ${prev ? `the section before ("${prev.name}")` : 'nothing before it'} has no part "${p.id}".`,
          path: `${path}.parts[${i}].code`,
          hint: prev ? `Carry one of: ${prev.parts.map((x) => x.id).join(', ') || 'none'}; or write the code.` : 'Write the code.',
        });
        return;
      }
      code = before.code;
      const restated = new Map(p.knobs.map((k) => [k.name, k]));
      knobs = [...before.knobs.map((k) => restated.get(k.name) ?? k), ...p.knobs.filter((k) => !before.knobs.some((b) => b.name === k.name))];
    }
    parts.push({
      id: p.id,
      role: p.role,
      code,
      knobs: [...knobs],
      chromatic: p.chromatic,
      level: p.level,
      enterBar: p.enterBar,
      exitBar: p.exitBar,
      automation: [...p.automation],
      duckTargets: p.duck,
      carried: before !== null && before.code === code,
      continues: p.code === null && !p.restart,
    });
  });
  return { parts, errors };
}

/** Where each continuing part's pattern is when the new section starts at `startCycle`. */
export function continuingPatternBars(parts: readonly ResolvedPart[], prev: SectionProgram | null, startCycle: number): Map<string, number> {
  const out = new Map<string, number>();
  if (!prev) return out;
  for (const p of parts) {
    const before = prev.parts.find((x) => x.id === p.id);
    if (p.continues && before) out.set(p.id, patternBarAt(prev, before, startCycle));
  }
  return out;
}

export function checkInputFor(plan: SectionPlan, parts: readonly ResolvedPart[], patternBars: ReadonlyMap<string, number>): CheckSectionInput {
  return {
    parts: parts.map((p) => ({
      id: p.id,
      role: p.role,
      code: p.code,
      knobs: p.knobs,
      chromatic: p.chromatic,
      level: p.level,
      enterBar: p.enterBar,
      exitBar: p.exitBar,
      patternBarAtStart: patternBars.get(p.id) ?? 0,
    })),
    bpm: plan.bpm,
    scale: plan.scale,
    bars: plan.bars,
    vampLoopBars: vampLoopFor(plan.bars),
  };
}

/** Lowest orbits first; continuing parts keep theirs; nothing the previous section used is reused. */
export function assignOrbits(parts: readonly ResolvedPart[], prev: SectionProgram | null): Map<string, number> {
  const out = new Map<string, number>();
  const taken = new Set(prev?.parts.map((p) => p.orbit) ?? []);
  const used = new Set<number>();
  for (const p of parts) {
    const before = prev?.parts.find((x) => x.id === p.id);
    if (p.continues && before) {
      out.set(p.id, before.orbit);
      used.add(before.orbit);
    }
  }
  for (const p of parts) {
    if (out.has(p.id)) continue;
    let orbit = 1;
    while (orbit <= ORBITS && (taken.has(orbit) || used.has(orbit))) orbit++;
    if (orbit > ORBITS) for (orbit = 1; used.has(orbit); orbit++);
    out.set(p.id, orbit);
    used.add(orbit);
  }
  return out;
}

/** Whether looping the last phrase would still sound (and suit the role). */
export function vampAllowed(role: SectionRole, bars: number, parts: readonly ResolvedPart[], checks: readonly (PartCheck | undefined)[]): boolean {
  if (NO_VAMP.has(role)) return false;
  const loop = vampLoopFor(bars);
  return parts.some((p, i) => {
    const inLoop = p.enterBar < bars && (p.exitBar === null || p.exitBar > bars - loop);
    return inLoop && levelAt(p, bars) > 0.001 && checks[i]?.analysis?.silent !== true;
  });
}

/** Balance trims (dB by part id) toward ROLE_RMS_TARGET, when the catalog has measured levels. */
export function balanceTrims(parts: readonly { id: string; role: PartRole; level: number }[], checks: readonly (PartCheck | undefined)[]): Record<string, number> {
  const trims: Record<string, number> = {};
  parts.forEach((p, i) => {
    const est = checks[i]?.analysis?.loudness.estRmsDb;
    if (est === null || est === undefined || p.level <= 0) return;
    const diff = ROLE_RMS_TARGET[p.role] - (est + 20 * Math.log10(p.level));
    if (Math.abs(diff) <= TRIM_DEADBAND_DB) return;
    const trim = Math.min(TRIM_RANGE_DB[1], Math.max(TRIM_RANGE_DB[0], diff - Math.sign(diff) * TRIM_DEADBAND_DB));
    trims[p.id] = Math.round(trim * 2) / 2;
  });
  return trims;
}

export interface CompileInput {
  id: string;
  index: number;
  track: number;
  movementId: string;
  author: SectionProgram['author'];
  startCycle: number;
  plan: SectionPlan;
  parts: ResolvedPart[];
  provisional: boolean;
  /** The program this one follows (the anchor, or the plan's previous section). */
  prev: SectionProgram | null;
  check: SectionCheck;
}

export function compileSection(input: CompileInput): { program: SectionProgram; trims: Record<string, number> } {
  const { plan, parts, prev, check, startCycle } = input;
  const checks = parts.map((p) => check.parts.find((c) => c.id === p.id));
  const orbits = assignOrbits(parts, prev);
  const programParts: ProgramPart[] = parts.map((p, i) => {
    const before = prev?.parts.find((x) => x.id === p.id);
    const continues = p.continues && !!before;
    const originCycle = continues ? startCycle - patternBarAt(prev!, before!, startCycle) : startCycle;
    const c = checks[i];
    return {
      id: p.id,
      role: p.role,
      code: p.code,
      orbit: orbits.get(p.id)!,
      level: p.level,
      enterBar: p.enterBar,
      exitBar: p.exitBar,
      knobs: p.knobs,
      automation: p.automation,
      duck: p.duckTargets
        ? { orbits: p.duckTargets.targets.map((t) => orbits.get(t)).filter((o): o is number => o !== undefined), depth: p.duckTargets.depth, releaseSec: p.duckTargets.releaseSec }
        : null,
      originCycle,
      continues,
      carried: p.carried,
      chromatic: p.chromatic,
      instrument: c?.instrument ?? '',
      digest: c?.digest ?? null,
    };
  });
  const spans = check.mix?.spans;
  const program: SectionProgram = {
    id: input.id,
    rev: 1,
    index: input.index,
    track: input.track,
    movementId: input.movementId,
    name: plan.name,
    role: plan.role,
    startCycle,
    bars: plan.bars,
    jumps: [],
    vamp: { allowed: vampAllowed(plan.role, plan.bars, parts, checks), loopBars: vampLoopFor(plan.bars) },
    provisional: input.provisional,
    tempo: { fromBpm: plan.bpm, toBpm: plan.bpm, rampBars: plan.tempoRampBars, rampAt: plan.tempoRampAt },
    scale: plan.scale,
    chords: plan.chords,
    transitionIn: { ...plan.transitionIn },
    targets: structuredClone(plan.targets),
    measured: spans ? structuredClone(spans) : structuredClone(plan.targets),
    parts: programParts,
    publicNote: plan.publicNote,
    author: input.author,
  };
  return { program, trims: balanceTrims(parts, checks) };
}

/**
 * Last-resort autopilot: every part still sounding at the tail's end carried (continuing) for 16 bars
 * at its held level. Its code was already accepted, so this passes whatever else failed.
 */
export function carryPlan(tail: SectionProgram): Plan {
  const byOrbit = new Map(tail.parts.map((p) => [p.orbit, p.id]));
  const sounding = tail.parts.filter((p) => p.exitBar === null || p.exitBar >= tail.bars);
  const carried = sounding.length ? sounding : tail.parts;
  const ids = new Set(carried.map((p) => p.id));
  return {
    sections: [
      {
        name: tail.name,
        role: 'groove',
        bars: 16,
        bpm: tail.tempo.toBpm,
        tempoRampBars: 0,
        tempoRampAt: 'start',
        scale: tail.scale,
        chords: tail.chords,
        targets: structuredClone(tail.measured),
        transitionIn: { type: 'cut', bars: 0 },
        parts: carried.map((p) => {
          const held = levelAt(p, tail.bars);
          const targets = (p.duck?.orbits ?? []).map((o) => byOrbit.get(o)).filter((id): id is string => !!id && ids.has(id) && id !== p.id);
          return {
            id: p.id,
            role: p.role,
            code: null,
            restart: false,
            chromatic: p.chromatic,
            level: Math.round((held > 0.05 ? held : p.level) * 100) / 100,
            enterBar: 0,
            exitBar: null,
            knobs: [],
            automation: [],
            duck: p.duck && targets.length ? { targets, depth: p.duck.depth, releaseSec: p.duck.releaseSec } : null,
          };
        }),
        reprise: null,
        publicNote: 'The band holds the groove while the next idea takes shape.',
      },
    ],
    movement: null,
    fork: null,
    requestDecisions: [],
    motifs: [],
    announcement: null,
    rationale: 'Autopilot carried the previous section.',
  };
}
