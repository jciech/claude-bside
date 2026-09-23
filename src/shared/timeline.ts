// The room clock. Every client maps server time to cycles with these pure functions, so all
// listeners agree on "which bar is it" without the server streaming ticks.
//
// Tempo is piecewise constant: a list of segments, each anchored at a server-clock instant and
// a cycle position. A tempo ramp is a run of one-bar segments. Changes are always published
// ahead of time (segment.startMs in the future), so every client switches at the same instant.

export interface TempoSegment {
  /** Server clock (ms, performance.timeOrigin + performance.now() on the server). */
  startMs: number;
  /** Absolute cycle (bar) at startMs. */
  startCycle: number;
  /** Cycles per second for this segment. */
  cps: number;
}

export interface Timeline {
  /** Sorted by startMs ascending; never empty. */
  segments: TempoSegment[];
}

export function createTimeline(startMs: number, cps: number, startCycle = 0): Timeline {
  return { segments: [{ startMs, startCycle, cps }] };
}

function segmentIndexAtMs(tl: Timeline, ms: number): number {
  const segs = tl.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.startMs <= ms) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function segmentIndexAtCycle(tl: Timeline, cycle: number): number {
  const segs = tl.segments;
  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid]!.startCycle <= cycle) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function segmentAtMs(tl: Timeline, ms: number): TempoSegment {
  return tl.segments[segmentIndexAtMs(tl, ms)]!;
}

export function segmentAtCycle(tl: Timeline, cycle: number): TempoSegment {
  return tl.segments[segmentIndexAtCycle(tl, cycle)]!;
}

/** Fractional cycle at a server-clock instant. Before the first segment, extrapolates backwards. */
export function cycleAtMs(tl: Timeline, ms: number): number {
  const s = segmentAtMs(tl, ms);
  return s.startCycle + ((ms - s.startMs) / 1000) * s.cps;
}

/** Server-clock instant at which a (fractional) cycle is reached. */
export function msAtCycle(tl: Timeline, cycle: number): number {
  const s = segmentAtCycle(tl, cycle);
  return s.startMs + ((cycle - s.startCycle) / s.cps) * 1000;
}

export function cpsAtCycle(tl: Timeline, cycle: number): number {
  return segmentAtCycle(tl, cycle).cps;
}

export function cpsAtMs(tl: Timeline, ms: number): number {
  return segmentAtMs(tl, ms).cps;
}

/**
 * Returns a new timeline whose tempo becomes `cps` at `atCycle`. Segments that start at or after
 * `atCycle` are replaced. `atCycle` should be a bar boundary in the future.
 */
export function withTempoAt(tl: Timeline, atCycle: number, cps: number): Timeline {
  const startMs = msAtCycle(tl, atCycle);
  const kept = tl.segments.filter((s) => s.startCycle < atCycle);
  const base = kept.length ? kept : [tl.segments[0]!];
  const last = base[base.length - 1]!;
  if (last.cps === cps && last.startCycle < atCycle) return { segments: base };
  return { segments: [...base, { startMs, startCycle: atCycle, cps }] };
}

/**
 * Linear tempo ramp from the tempo at `fromCycle` to `toCps`, stepping once per bar over `bars`
 * bars; the final tempo is reached exactly at `fromCycle + bars`.
 */
export function withTempoRamp(tl: Timeline, fromCycle: number, bars: number, toCps: number): Timeline {
  const fromCps = cpsAtCycle(tl, fromCycle);
  if (bars <= 0 || fromCps === toCps) return withTempoAt(tl, fromCycle, toCps);
  let next = tl;
  for (let i = 1; i <= bars; i++) {
    const cps = fromCps + ((toCps - fromCps) * i) / bars;
    next = withTempoAt(next, fromCycle + i, cps);
  }
  return next;
}

/** Drops segments that ended before `beforeMs` (keeps the one in effect at beforeMs). */
export function pruneTimeline(tl: Timeline, beforeMs: number): Timeline {
  const i = segmentIndexAtMs(tl, beforeMs);
  return { segments: tl.segments.slice(i) };
}
