// Where sections go on the room timeline, under the lock rules of src/shared/schedule.ts: nothing
// changes after its lock point, new sections land on 4-bar lines, and (except in `now` mode) reach
// clients before their publish deadline. The future tempo map is always rebuilt from committed
// sections with buildTimeline, never edited in place.
import { bpmToCps } from '../../shared/music.ts';
import type { CommitMode } from '../../shared/composer-api.ts';
import type { SectionProgram } from '../../shared/program.ts';
import {
  lockMs,
  MIN_CHANGE_LEAD_S,
  nextPhraseLine,
  PHRASE_BARS,
  plannedPlayBars,
  publishDeadlineMs,
  scoreBarAt,
  type ScoreShape,
} from '../../shared/schedule.ts';
import { buildTimeline, cpsAtCycle, cycleAtMs, msAtCycle, type SectionTempo, type Timeline } from '../../shared/timeline.ts';

/** Slack between placement and broadcast (everything after the checker runs synchronously). */
export const ACCEPT_MARGIN_MS = 250;
/** Time budget for checking and accepting a plan that arrives right at its soft deadline. */
export const ACCEPT_BUDGET_MS = 3000;
const MAX_LINES_SEARCHED = 256;

/** Commit modes plus `boot` (nothing scheduled yet) and `fill` (the autopilot after the tail, no preload guarantee). */
export type PlaceMode = CommitMode | 'boot' | 'fill';

export const plannedEnd = (s: Pick<SectionProgram, 'startCycle' | 'bars' | 'jumps'>) => s.startCycle + plannedPlayBars(s);

export const barMsAt = (tl: Timeline, cycle: number) => 1000 / cpsAtCycle(tl, cycle);

/** True while a change that takes effect at `cycle` can still reach every client in time. */
export function changeableAt(tl: Timeline, cycle: number, nowMs: number): boolean {
  return msAtCycle(tl, cycle) - Math.max(MIN_CHANGE_LEAD_S * 1000, 2 * barMsAt(tl, cycle)) > nowMs + ACCEPT_MARGIN_MS;
}

/** Past its lock point: existence, start, transition, parts and its predecessor's extent are frozen. */
export function isHardLocked(tl: Timeline, s: SectionProgram, nowMs: number): boolean {
  return nowMs + ACCEPT_MARGIN_MS >= lockMs(tl, s);
}

export function sectionTempo(s: SectionProgram): SectionTempo {
  return { startCycle: s.startCycle, bars: plannedPlayBars(s), toCps: bpmToCps(s.tempo.toBpm), rampBars: s.tempo.rampBars, rampAt: s.tempo.rampAt };
}

/** Rebuilds the future tempo map from sections; segments inside the change lead stay as they are. */
export function rebuildTimeline(past: Timeline, nowMs: number, sections: readonly SectionProgram[]): Timeline {
  const lockCycle = cycleAtMs(past, nowMs + MIN_CHANGE_LEAD_S * 1000);
  return buildTimeline(past, lockCycle, sections.map(sectionTempo));
}

/** Score bar a part's pattern reaches after `playLen` bars of its section (the next bar to sound). */
export function scoreEndAt(shape: ScoreShape, playLen: number): number {
  return playLen >= 1 ? scoreBarAt(shape, playLen - 1) + 1 : 0;
}

/** Pattern bar of a part instance at an absolute cycle (where a continuing successor picks up). */
export function patternBarAt(section: SectionProgram, part: { continues: boolean; originCycle: number }, cycle: number): number {
  if (part.continues) return cycle - part.originCycle;
  return scoreEndAt(section, cycle - section.startCycle) + (section.startCycle - part.originCycle);
}

export interface PlacedShape {
  transitionIn: SectionProgram['transitionIn'];
  parts: readonly { enterBar: number }[];
  bars: number;
}

export interface PlacementInput {
  mode: PlaceMode;
  /** Live sections, sorted by startCycle. */
  sections: readonly SectionProgram[];
  /** Provisional sections the plan may take the slot of (horizon mode). */
  replaces: readonly string[];
  /** Ids that may not be replaced even when provisional (the playing section's successor). */
  planningLocked: ReadonlySet<string>;
  timeline: Timeline;
  nowMs: number;
  /** The plan's sections in order (only their pre-roll and length matter here). */
  shapes: readonly PlacedShape[];
  /** Grid origin when nothing is scheduled yet (boot). */
  gridOrigin: number;
}

export interface Placement {
  startCycle: number;
  anchor: SectionProgram | null;
  kept: SectionProgram[];
  revokes: string[];
  /** Tempo map of the kept sections (the plan's own tempo only acts from its bar 0). */
  timeline: Timeline;
  /** Clients get the preload lead (always true except possibly in `now`/`boot` mode). */
  preload: boolean;
  /** Bars later than the anchor's planned end (the tail vamps meanwhile). */
  lateBars: number;
  /** Replacement ids that could not be honoured because they are locked by now. */
  lockedReplaces: string[];
}

export function place(input: PlacementInput): Placement | { error: string } {
  const { sections, timeline, nowMs } = input;
  const nowCycle = cycleAtMs(timeline, nowMs);
  const hard = (s: SectionProgram) => s.startCycle <= nowCycle || isHardLocked(timeline, s, nowMs);
  let lastFrozen = -1;
  sections.forEach((s, i) => {
    if (hard(s)) lastFrozen = i;
  });

  let cut: number;
  const lockedReplaces: string[] = [];
  if (input.mode === 'next' || input.mode === 'now') {
    cut = lastFrozen + 1;
  } else {
    const replaceable = (s: SectionProgram) => s.provisional && !hard(s) && !input.planningLocked.has(s.id);
    const first = sections.findIndex((s) => input.replaces.includes(s.id) && replaceable(s));
    for (const id of input.replaces) {
      const s = sections.find((x) => x.id === id);
      if (s && !replaceable(s)) lockedReplaces.push(id);
    }
    cut = first < 0 ? sections.length : Math.max(first, lastFrozen + 1);
  }
  const kept = sections.slice(0, cut);
  const revokes = sections.slice(cut).map((s) => s.id);
  const anchor = kept[kept.length - 1] ?? null;
  const tl = rebuildTimeline(timeline, nowMs, kept);

  const fits = (start: number, needPreload: boolean) => {
    let at = start;
    for (const shape of input.shapes) {
      const placed = { startCycle: at, transitionIn: shape.transitionIn, parts: shape.parts };
      if (lockMs(tl, placed) <= nowMs + ACCEPT_MARGIN_MS) return false;
      if (needPreload && publishDeadlineMs(tl, placed) < nowMs + ACCEPT_MARGIN_MS) return false;
      at += shape.bars;
    }
    return true;
  };

  const needPreload = input.mode === 'horizon' || input.mode === 'next';
  const cutsIn = input.mode === 'next' || input.mode === 'now';
  const origin = anchor?.startCycle ?? input.gridOrigin;
  let first: number;
  if (anchor && !cutsIn) first = Math.max(plannedEnd(anchor), nextPhraseLine(Math.floor(nowCycle) + 1, origin));
  else first = nextPhraseLine(Math.max(Math.floor(nowCycle) + 1, anchor ? anchor.startCycle + 1 : -Infinity), origin);

  for (let i = 0, c = first; i < MAX_LINES_SEARCHED; i++, c += PHRASE_BARS) {
    if (!fits(c, needPreload)) continue;
    return {
      startCycle: c,
      anchor,
      kept,
      revokes,
      timeline: tl,
      preload: needPreload || fits(c, true),
      lateBars: anchor && !cutsIn ? Math.max(0, c - plannedEnd(anchor)) : 0,
      lockedReplaces,
    };
  }
  return { error: 'No placement line satisfies the lock rules within reach.' };
}
