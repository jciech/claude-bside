// Window math for part instances (src/client/engine/types.ts, "Window"): which stretches of play
// time an instance sounds in, how play time maps onto the pattern's time there, where straddling
// notes re-trigger (entries) and where notes are cut (exits, score discontinuities, section ends).
// Pure and allocation-light: called for every instance on every scheduler tick.
import { scoreBarAt, scoreSegments } from '../../shared/schedule.ts';
import type { InstanceSpec } from './score.ts';

/** How far ahead a note's cut point is searched; longer notes are not truncated. */
export const CUT_HORIZON_BARS = 64;
const EPS = 1e-9;

/** A maximal stretch of in-window play time with one linear mapping onto pattern time. */
export interface Run {
  /** Absolute play cycles [from, to). */
  from: number;
  to: number;
  /** Absolute play cycle minus absolute query cycle: haps queried at c sound at c + shift. */
  shift: number;
  /** Notes straddling `from` re-trigger there with their remaining length. */
  entry: boolean;
}

/** True when score time jumps at relative play bar `p` (a Stay/Move-on jump or a vamp loop point). */
export function isDiscontinuity(inst: InstanceSpec, p: number): boolean {
  if (p <= 0 || !Number.isInteger(p)) return false;
  return Math.abs(scoreBarAt(inst.section, p) - (scoreBarAt(inst.section, p - 0.5) + 0.5)) > EPS;
}

/**
 * The in-window runs of an instance intersecting [a, b). Runs of score-mapped instances are split at
 * score discontinuities; continuing instances run on play time and are only split by their window.
 * `resumeAt` (output start after unlock or a clock skip) is an entry for every instance.
 */
export function runs(inst: InstanceSpec, a: number, b: number, resumeAt: number | null = null): Run[] {
  const lo = Math.max(a, inst.start);
  const hi = Math.min(b, inst.end);
  if (hi <= lo) return [];
  const s = inst.section;
  const base = s.startCycle;
  const enter = inst.part.enterBar;
  const exit = inst.part.exitBar ?? Number.POSITIVE_INFINITY;
  const out: Run[] = [];
  for (const seg of scoreSegments(s, lo - base, hi - base)) {
    const s0 = seg.scoreFrom;
    const s1 = s0 + (seg.playTo - seg.playFrom);
    const w0 = Math.max(s0, enter);
    const w1 = Math.min(s1, exit);
    if (w1 <= w0) continue;
    const from = base + seg.playFrom + (w0 - s0);
    const to = base + seg.playFrom + (w1 - s0);
    const shift = inst.continuing ? 0 : seg.playFrom - s0;
    const entry = isEntryPoint(inst, from, w0);
    const last = out[out.length - 1];
    if (last && Math.abs(last.to - from) < EPS && Math.abs(last.shift - shift) < EPS && !entry) {
      last.to = to;
      continue;
    }
    out.push({ from, to, shift, entry: entry || (resumeAt !== null && Math.abs(from - resumeAt) < EPS) });
  }
  return out;
}

/** Straddling notes re-trigger where the extent starts, the window opens or score time jumps. */
function isEntryPoint(inst: InstanceSpec, from: number, windowStart: number): boolean {
  if (inst.continuing) return false;
  if (Math.abs(from - inst.start) < EPS || Math.abs(windowStart - inst.part.enterBar) < EPS) return true;
  return isDiscontinuity(inst, from - inst.section.startCycle);
}

/**
 * Where a note sounding at `x` (in-window just before it) must end: the first window exit, score
 * discontinuity or section end at or after `x`. Infinity when none within the horizon, or when the
 * instance simply continues into the next section.
 */
export function cutAfter(inst: InstanceSpec, x: number): number {
  if (x >= inst.end) return inst.continuedByNext ? Number.POSITIVE_INFINITY : inst.end;
  const ahead = runs(inst, x, x + CUT_HORIZON_BARS);
  const first = ahead[0];
  if (!first || first.from > x + EPS || first.entry) return x;
  if (first.to >= x + CUT_HORIZON_BARS - EPS) return Number.POSITIVE_INFINITY;
  if (Math.abs(first.to - inst.end) < EPS && inst.continuedByNext) return Number.POSITIVE_INFINITY;
  return first.to;
}

/** The cut for notes starting inside `run` (queried over a range ending at `b`). */
export function cutForRun(inst: InstanceSpec, run: Run, b: number): number {
  const hi = Math.min(b, inst.end);
  if (run.to < hi - EPS) return run.to;
  return cutAfter(inst, run.to);
}

/** Whether the instance is in its window at `c` (inside its extent). */
export function inWindowAt(inst: InstanceSpec, c: number): boolean {
  if (c < inst.start || c >= inst.end) return false;
  const score = scoreBarAt(inst.section, c - inst.section.startCycle);
  return score >= inst.part.enterBar && score < (inst.part.exitBar ?? Number.POSITIVE_INFINITY);
}

/**
 * The most recent point at or before `c` where the instance stopped sounding (window exit or cut
 * section end), within `lookback` bars, or null while it sounds or never did.
 */
export function lastExitBefore(inst: InstanceSpec, c: number, lookback: number): number | null {
  if (inWindowAt(inst, c)) return null;
  const from = c - lookback;
  const hi = Math.min(c + EPS, inst.end);
  const rs = runs(inst, from, hi);
  const last = rs[rs.length - 1];
  if (!last) return null;
  if (last.to > c) return null;
  if (Math.abs(last.to - inst.end) < EPS && inst.continuedByNext) return null;
  return last.to;
}
