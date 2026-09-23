// Scheduling rules shared by the conductor (which must respect them) and the performer (which
// relies on them). Everything here is a pure function of committed sections and the timeline.
//
// Vocabulary
//  - play bar:  real bars since a section's startCycle (what the clock says)
//  - score bar: position in the section as composed (0 … bars). Stay/Move-on add `jumps` that make
//               score time repeat or skip; past the end of the score the last phrase loops (vamp).
//  - influence: a section starts affecting sound before its bar 0 when it has a pre-roll
//               (riser/breath/filter transition, pickup parts with negative enterBar).
//  - lock:      once the server clock passes lockMs(section), nothing about that section — its
//               existence, startCycle, transition, parts — or its predecessor's extent may change.
import { msAtCycle, cpsAtCycle, type Timeline } from './timeline.ts';
import type { SectionProgram } from './program.ts';

/** Clients receive a section at least this long (+ PRELOAD_BARS) before its influence cycle. */
export const SECTION_PRELOAD_S = 8;
export const PRELOAD_BARS = 2;
/** No already-broadcast state changes within this much time of the cycle it affects. */
export const MIN_CHANGE_LEAD_S = 4;
/** The performer's scheduler lookahead; superdough cannot cancel haps once handed over. */
export const SCHEDULER_LOOKAHEAD_S = 0.25;
/** Section placement grid: new sections, vamps, Stay and Move-on land on 4-bar lines. */
export const PHRASE_BARS = 4;
/** A phrase for Stay/Move-on purposes. */
export const KEEP_PHRASE_BARS = 8;
/** Crossfades are at most this long; breaths at most BREATH_MAX_BARS. */
export const CROSSFADE_MAX_BARS = 8;
export const BREATH_MAX_BARS = 2;
export const PICKUP_MAX_BARS = 8;
/** Planning is triggered when locked, unplayed music falls below this (plus p90 compose time). */
export const HORIZON_TRIGGER_MIN_S = 120;

export interface Jump {
  /** Score bar at which the jump happens. */
  atBar: number;
  /** Score bar it continues from. atBar > toBar repeats material (Stay); atBar < toBar skips (Move on). */
  toBar: number;
}

/** The parts of a section that define its score-time mapping. */
export interface ScoreShape {
  bars: number;
  jumps: readonly Jump[];
  vamp: { allowed: boolean; loopBars: number };
}

export interface ScoreSegment {
  /** Play-bar span [playFrom, playTo) mapping linearly onto score bars starting at scoreFrom. */
  playFrom: number;
  playTo: number;
  scoreFrom: number;
}

/** How many bars before bar 0 a section starts to act (transition pre-roll or pickup parts). */
type PreRollShape = { transitionIn: SectionProgram['transitionIn']; parts: readonly { enterBar: number }[] };
type PlacedShape = PreRollShape & { startCycle: number };

export function preRollBars(s: PreRollShape): number {
  const t = s.transitionIn;
  const transition = t.type === 'riser' || t.type === 'breath' || t.type === 'filter' ? t.bars : 0;
  const pickup = Math.max(0, ...s.parts.map((p) => -Math.min(0, p.enterBar)));
  return Math.max(transition, pickup);
}

export function influenceCycle(s: PlacedShape): number {
  return s.startCycle - preRollBars(s);
}

function barMs(tl: Timeline, cycle: number): number {
  return 1000 / cpsAtCycle(tl, cycle);
}

/** Server-clock ms after which the section (and its predecessor's extent) is immutable. */
export function lockMs(tl: Timeline, s: PlacedShape): number {
  const at = influenceCycle(s);
  return msAtCycle(tl, at) - Math.max(MIN_CHANGE_LEAD_S * 1000, 2 * barMs(tl, at));
}

/** Latest server-clock ms by which clients must have received the section (preload guarantee). */
export function publishDeadlineMs(tl: Timeline, s: PlacedShape): number {
  const at = influenceCycle(s);
  return msAtCycle(tl, at) - SECTION_PRELOAD_S * 1000 - PRELOAD_BARS * barMs(tl, at);
}

/** Total score-bar delta introduced by jumps: positive when Stay repeated material. */
export function jumpDelta(jumps: readonly Jump[]): number {
  return jumps.reduce((sum, j) => sum + (j.atBar - j.toBar), 0);
}

/** Planned play length: composed bars adjusted by jumps (excludes any vamp). */
export function plannedPlayBars(s: Pick<ScoreShape, 'bars' | 'jumps'>): number {
  return s.bars + jumpDelta(s.jumps);
}

/** Length of the phrase that loops once a section plays past its score (vamp). */
export function vampLoopBars(s: Pick<ScoreShape, 'bars' | 'vamp'>): number {
  return Math.max(1, Math.min(s.vamp.loopBars, s.bars / 2));
}

/**
 * Maps a play bar to a score bar: jumps in order, then the vamp loop past the score's end.
 * Negative play bars (pickups) map to themselves.
 */
export function scoreBarAt(s: ScoreShape, playBar: number): number {
  if (playBar < 0) return playBar;
  let play0 = 0;
  let score0 = 0;
  for (const j of s.jumps) {
    const playAtJump = play0 + (j.atBar - score0);
    if (playBar < playAtJump) break;
    play0 = playAtJump;
    score0 = j.toBar;
  }
  const score = score0 + (playBar - play0);
  if (score < s.bars) return score;
  const loop = vampLoopBars(s);
  return s.bars - loop + ((score - s.bars) % loop);
}

/**
 * Splits a play-bar span into pieces that each map linearly onto score time. The performer queries
 * the part pattern over [scoreFrom, scoreFrom + (playTo - playFrom)) and shifts the haps by
 * (playFrom - scoreFrom).
 */
export function scoreSegments(
  s: ScoreShape,
  playFrom: number,
  playTo: number,
): ScoreSegment[] {
  const cuts = new Set<number>();
  let play0 = 0;
  let score0 = 0;
  for (const j of s.jumps) {
    const playAtJump = play0 + (j.atBar - score0);
    cuts.add(playAtJump);
    play0 = playAtJump;
    score0 = j.toBar;
  }
  const playAtEnd = play0 + (s.bars - score0);
  const loop = vampLoopBars(s);
  for (let c = playAtEnd; c < playTo; c += loop) cuts.add(c);
  const points = [...cuts].filter((c) => c > playFrom && c < playTo).sort((a, b) => a - b);
  const bounds = [playFrom, ...points, playTo];
  const out: ScoreSegment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i]!;
    const b = bounds[i + 1]!;
    if (b <= a) continue;
    out.push({ playFrom: a, playTo: b, scoreFrom: scoreBarAt(s, a) });
  }
  return out;
}

/** Sections sorted by startCycle; each sounds until the next one's startCycle (or forever). */
export function sectionExtents<T extends { startCycle: number }>(sections: readonly T[]): { section: T; endCycle: number }[] {
  const sorted = [...sections].sort((a, b) => a.startCycle - b.startCycle);
  return sorted.map((section, i) => ({ section, endCycle: sorted[i + 1]?.startCycle ?? Number.POSITIVE_INFINITY }));
}

/** Next placement line (multiple of PHRASE_BARS from `origin`) at or after `cycle`. */
export function nextPhraseLine(cycle: number, origin = 0, phrase = PHRASE_BARS): number {
  return origin + Math.ceil((cycle - origin) / phrase) * phrase;
}
