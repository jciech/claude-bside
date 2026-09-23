// The schedule as the performer sees it: every (section, part) instance with its absolute extent
// and how it begins and ends (continuation, transition, release). Pure: every client derives the
// same instances from the same sections (src/client/engine/types.ts). Carried knob values need no
// history: the conductor writes them into each carried part's knob defaults.
import { PERCUSSIVE_ROLES, PITCHED_ROLES, type PartRole } from '../../shared/music.ts';
import type { ProgramPart, SectionProgram } from '../../shared/program.ts';
import { influenceCycle, scoreBarAt } from '../../shared/schedule.ts';
import { cpsAtCycle, msAtCycle, type Timeline } from '../../shared/timeline.ts';

/** How long a channel takes to release after its instance stops: 1 beat (percussive) or 1 bar. */
export function roleReleaseBars(role: PartRole): number {
  return PERCUSSIVE_ROLES.has(role) ? 0.25 : 1;
}

export type EffectiveTransition = SectionProgram['transitionIn']['type'];

export interface InstanceSpec {
  /** `${sectionId}:${partId}` */
  key: string;
  section: SectionProgram;
  part: ProgramPart;
  /** Absolute play cycles this instance may sound in: [start, end). */
  start: number;
  end: number;
  /** The same-id part of the next section continues this one: `end` is not a cut. */
  continuedByNext: boolean;
  /** This instance continues the previous section's same-id part: play time, no re-onset. */
  continuing: boolean;
  /** Channel release after a window exit (bars). */
  releaseBars: number;
  /** Channel release when the section ends under it (breaths release faster). */
  endReleaseBars: number;
  /** Equal-power fade in over [at, at + bars) (incoming crossfade). */
  fadeIn: { at: number; bars: number } | null;
  /** Equal-power fade out over [at, at + bars) (outgoing crossfade). */
  fadeOut: { at: number; bars: number } | null;
  /** Channel high-pass opening over [at, at + bars) (incoming filter transition). */
  highpassOpen: { at: number; bars: number } | null;
  /** Channel low-pass closing over [at, at + bars) (outgoing filter transition). */
  lowpassClose: { at: number; bars: number } | null;
}

export interface RiserSpec {
  sectionId: string;
  from: number;
  to: number;
}

export interface Score {
  /** Sorted by startCycle. */
  sections: SectionProgram[];
  instances: InstanceSpec[];
  byKey: Map<string, InstanceSpec>;
  /** Instances per orbit, sorted by start. */
  byOrbit: Map<number, InstanceSpec[]>;
  risers: RiserSpec[];
  /** The transition each section is actually rendered with (skipped windows become 'cut'). */
  transitions: Map<string, EffectiveTransition>;
}

/** Start of the window a section's transition acts in. */
function transitionWindowStart(s: SectionProgram): number {
  const t = s.transitionIn;
  return t.type === 'riser' || t.type === 'breath' || t.type === 'filter' ? s.startCycle - t.bars : s.startCycle;
}

/**
 * The transition as rendered: a window that began before the section arrived is skipped (never
 * joined part-way), and zero-length transitions are cuts.
 */
export function effectiveTransition(s: SectionProgram, arrivedAt: number | undefined): EffectiveTransition {
  const t = s.transitionIn;
  if (t.type === 'cut' || t.bars <= 0) return 'cut';
  if (arrivedAt !== undefined && arrivedAt > transitionWindowStart(s)) return 'cut';
  return t.type;
}

export function buildScore(input: readonly SectionProgram[], arrivals: ReadonlyMap<string, number>): Score {
  const sections = [...input].sort((a, b) => a.startCycle - b.startCycle);
  const transitions = new Map<string, EffectiveTransition>();
  for (const s of sections) transitions.set(s.id, effectiveTransition(s, arrivals.get(s.id)));
  const instances: InstanceSpec[] = [];
  const risers: RiserSpec[] = [];

  sections.forEach((section, i) => {
    const prev = sections[i - 1] ?? null;
    const next = sections[i + 1] ?? null;
    const incoming = transitions.get(section.id)!;
    const outgoing = next ? transitions.get(next.id)! : null;
    if (incoming === 'riser') risers.push({ sectionId: section.id, from: section.startCycle - section.transitionIn.bars, to: section.startCycle });

    for (const part of section.parts) {
      const before = prev?.parts.find((p) => p.id === part.id);
      const continuing = part.continues && !!before;
      const after = next?.parts.find((p) => p.id === part.id);
      const continuedByNext = !!after?.continues;
      const pickup = part.enterBar < 0;
      const release = roleReleaseBars(part.role);

      let end = Number.POSITIVE_INFINITY;
      let endReleaseBars = release;
      let fadeOut: InstanceSpec['fadeOut'] = null;
      let lowpassClose: InstanceSpec['lowpassClose'] = null;
      if (next) {
        const n = next.transitionIn.bars;
        end = next.startCycle;
        if (!continuedByNext) {
          if (outgoing === 'crossfade' && !(PITCHED_ROLES.has(part.role) && next.scale !== section.scale)) {
            end = next.startCycle + n;
            fadeOut = { at: next.startCycle, bars: n };
          } else if (outgoing === 'breath') {
            end = next.startCycle - n;
            endReleaseBars = Math.min(release, 0.25);
          } else if (outgoing === 'filter') {
            lowpassClose = { at: next.startCycle - n, bars: n };
          }
        }
      }

      const spec: InstanceSpec = {
        key: `${section.id}:${part.id}`,
        section,
        part,
        start: continuing ? section.startCycle : section.startCycle + Math.min(0, part.enterBar),
        end,
        continuedByNext,
        continuing,
        releaseBars: release,
        endReleaseBars,
        fadeIn: !continuing && !pickup && incoming === 'crossfade' ? { at: section.startCycle, bars: section.transitionIn.bars } : null,
        fadeOut,
        highpassOpen:
          !continuing && !pickup && incoming === 'filter' ? { at: section.startCycle, bars: Math.max(0.5, section.transitionIn.bars / 2) } : null,
        lowpassClose,
      };
      if (spec.end > spec.start) instances.push(spec);
    }
  });

  const byKey = new Map(instances.map((x) => [x.key, x]));
  const byOrbit = new Map<number, InstanceSpec[]>();
  for (const x of instances) {
    const list = byOrbit.get(x.part.orbit) ?? [];
    list.push(x);
    byOrbit.set(x.part.orbit, list);
  }
  for (const list of byOrbit.values()) list.sort((a, b) => a.start - b.start);
  return { sections, instances, byKey, byOrbit, risers, transitions };
}

/** The section sounding at `cycle`: the last one whose bar 0 is at or before it. */
export function sectionAt(sections: readonly SectionProgram[], cycle: number): SectionProgram | null {
  let found: SectionProgram | null = null;
  for (const s of sections) {
    if (s.startCycle <= cycle) found = s;
    else break;
  }
  return found;
}

/** Fields of a part that change what it plays. */
function partRenderKey(p: ProgramPart): string {
  return JSON.stringify([p.id, p.role, p.code, p.orbit, p.level, p.enterBar, p.exitBar, p.knobs, p.automation, p.duck, p.originCycle, p.continues, p.carried]);
}

/** Search limit for where two score mappings diverge (bars). */
const SCORE_DIFF_HORIZON = 512;

/**
 * Earliest cycle whose rendering can differ between two versions of a section (or its absence).
 * Stay/Move-on only edit score time, so they count from the first bar whose mapping changes;
 * anything else about the section counts from its influence cycle. Tempo is diffed via the timeline.
 */
export function affectedFrom(before: SectionProgram | undefined, after: SectionProgram | undefined): number {
  if (!before || !after) return Math.min(...[before, after].filter((s): s is SectionProgram => !!s).map((s) => influenceCycle(s)), Number.POSITIVE_INFINITY);
  const same =
    before.startCycle === after.startCycle &&
    before.scale === after.scale &&
    before.transitionIn.type === after.transitionIn.type &&
    before.transitionIn.bars === after.transitionIn.bars &&
    before.parts.length === after.parts.length &&
    before.parts.every((p, i) => partRenderKey(p) === partRenderKey(after.parts[i]!));
  if (!same) return Math.min(influenceCycle(before), influenceCycle(after));
  for (let bar = 0; bar < SCORE_DIFF_HORIZON; bar++) {
    if (Math.abs(scoreBarAt(before, bar + 0.5) - scoreBarAt(after, bar + 0.5)) > 1e-9) return before.startCycle + bar;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * First cycle at which two timelines map differently (Infinity when they agree). Both are piecewise
 * linear with breakpoints at segment starts, so comparing position and tempo there suffices; segments
 * pruned from the front of one of them don't count.
 */
export function timelineDiffFrom(a: Timeline, b: Timeline): number {
  const lo = Math.max(a.segments[0]!.startCycle, b.segments[0]!.startCycle);
  let from = Number.POSITIVE_INFINITY;
  for (const s of [...a.segments, ...b.segments]) {
    const c = Math.max(lo, s.startCycle);
    if (Math.abs(msAtCycle(a, c) - msAtCycle(b, c)) > 0.5 || cpsAtCycle(a, c) !== cpsAtCycle(b, c)) from = Math.min(from, c);
  }
  return from;
}
