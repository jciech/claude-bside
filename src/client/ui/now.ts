// "What's playing" derived from the schedule and the bar: the track, its side, what comes next and
// how far along it is. Pure; shared by the top bar, landing, label, cue chip and summary.
import type { MovementInfo, ProgramPart, SectionProgram } from '../../shared/program.ts';
import { plannedPlayBars, scoreBarAt } from '../../shared/schedule.ts';
import { movementAt, nextSection, sectionAtCycle, type ScheduleState } from './stores.ts';

export interface NowPlaying {
  section: SectionProgram | null;
  movement: MovementInfo | null;
  next: SectionProgram | null;
  /** Bars until `next` starts (ceil), when there is one. */
  barsToNext: number | null;
  /** Play bars since the section started. */
  playBar: number;
  /** Position in the composed score (Stay/Move-on jumps and the vamp applied). */
  scoreBar: number;
  /** 0..1 through the planned play length. */
  progress: number;
  /** 0..1 intensity measured for this point of the track. */
  intensity: number;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function nowPlaying(schedule: ScheduleState, cycle: number): NowPlaying {
  const section = sectionAtCycle(schedule.sections, cycle);
  const next = nextSection(schedule.sections, cycle);
  const movementId = section?.movementId;
  const movement = schedule.movements.find((m) => m.id === movementId) ?? movementAt(schedule.movements, cycle);
  if (!section) {
    return { section: null, movement, next, barsToNext: next ? Math.ceil(next.startCycle - cycle - 1e-6) : null, playBar: 0, scoreBar: 0, progress: 0, intensity: 0.3 };
  }
  const playBar = cycle - section.startCycle;
  const scoreBar = scoreBarAt(section, Math.max(0, playBar));
  const progress = Math.min(1, Math.max(0, playBar / Math.max(1, plannedPlayBars(section))));
  const m = section.measured.intensity;
  return {
    section,
    movement,
    next,
    barsToNext: next ? Math.ceil(next.startCycle - cycle - 1e-6) : null,
    playBar,
    scoreBar,
    progress,
    intensity: lerp(m.start, m.end, Math.min(1, scoreBar / Math.max(1, section.bars))),
  };
}

export type PartState = 'waiting' | 'playing' | 'leaving' | 'gone';

/** Where a part is in its window at a score bar ("enters at bar 8", "left at bar 16"). */
export function partState(part: Pick<ProgramPart, 'enterBar' | 'exitBar'>, scoreBar: number): PartState {
  if (scoreBar < part.enterBar) return 'waiting';
  if (part.exitBar !== null && scoreBar >= part.exitBar) return 'gone';
  if (part.exitBar !== null && scoreBar >= part.exitBar - 1) return 'leaving';
  return 'playing';
}

/** Instances audible around `cycle`: the current section's, plus the previous one's during a crossfade. */
export function audibleInstances(schedule: ScheduleState, cycle: number): { section: SectionProgram; part: ProgramPart; key: string; leaving: boolean }[] {
  const np = nowPlaying(schedule, cycle);
  if (!np.section) return [];
  const out = np.section.parts
    .filter((part) => part.exitBar === null || part.exitBar > 0 || np.playBar < 0)
    .map((part) => ({ section: np.section!, part, key: `${np.section!.id}:${part.id}`, leaving: false }));
  // Pickups of the next track play over the end of this one.
  if (np.next) {
    for (const part of np.next.parts) {
      if (part.enterBar < 0 && cycle >= np.next.startCycle + part.enterBar) out.push({ section: np.next, part, key: `${np.next.id}:${part.id}`, leaving: false });
    }
  }
  const t = np.section.transitionIn;
  if (t.type === 'crossfade' && np.playBar < t.bars) {
    const prev = sectionAtCycle(schedule.sections, np.section.startCycle - 1e-6);
    if (prev) {
      for (const part of prev.parts) {
        const continued = np.section.parts.some((p) => p.id === part.id && p.continues);
        if (!continued) out.push({ section: prev, part, key: `${prev.id}:${part.id}`, leaving: true });
      }
    }
  }
  return out;
}
