// The room clock (docs/ARCHITECTURE.md §4): the server's view of the shared timeline, plus a bar
// callback. Each timer is aimed at the absolute instant of the next integer cycle (msAtCycle), so
// timer lateness never accumulates, tempo changes re-aim the pending timer, and an early wake-up
// simply re-arms.
import { cpsToBpm } from '../../shared/music.ts';
import { cpsAtMs, cycleAtMs, msAtCycle, type Timeline } from '../../shared/timeline.ts';
import type { Logger, RoomClock } from '../types.ts';

export function serverNow(): number {
  return performance.timeOrigin + performance.now();
}

export interface ClockTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** After a stall (sleep, debugger, blocked loop) at most this many missed bars are announced. */
const MAX_CATCH_UP_BARS = 16;
/** msAtCycle → cycleAtMs round trips can land a hair below the integer. */
const EPSILON = 1e-6;
/** A timeline swap moving the current position by more than this is a jump, not a tempo change. */
const JUMP_CYCLES = 1e-3;

const barInProgress = (cycle: number): number => Math.ceil(cycle - EPSILON) - 1;

export function createRoomClock(opts: { timeline: Timeline; now?: () => number; timers?: ClockTimers; log?: Logger }): RoomClock {
  const now = opts.now ?? serverNow;
  const timers: ClockTimers = opts.timers ?? { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const log = opts.log;
  const listeners = new Set<(bar: number) => void>();
  let timeline = opts.timeline;
  let running = false;
  /** The last bar announced (or, right after start or a jump, the bar in progress). */
  let lastBar = 0;
  let handle: ReturnType<typeof setTimeout> | null = null;

  const disarm = () => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };

  const arm = () => {
    disarm();
    if (!running) return;
    const delay = Math.max(0, Math.ceil(msAtCycle(timeline, lastBar + 1) - now()));
    handle = timers.setTimeout(fire, delay);
    (handle as { unref?: () => void } | null)?.unref?.();
  };

  const announce = (bar: number) => {
    for (const listener of [...listeners]) {
      try {
        listener(bar);
      } catch (err) {
        log?.error('bar listener failed', { bar, err });
      }
    }
  };

  function fire() {
    handle = null;
    const reached = Math.floor(cycleAtMs(timeline, now()) + EPSILON);
    if (reached > lastBar) {
      let from = lastBar + 1;
      if (reached - from >= MAX_CATCH_UP_BARS) {
        log?.warn('clock fell behind; skipping bars', { from, to: reached - MAX_CATCH_UP_BARS });
        from = reached - MAX_CATCH_UP_BARS + 1;
      }
      for (let bar = from; bar <= reached && running; bar++) {
        lastBar = bar;
        announce(bar);
      }
    }
    // A listener may have stopped the clock or swapped the timeline (which re-armed already).
    if (running && handle === null) arm();
  }

  return {
    now,
    cycle: () => cycleAtMs(timeline, now()),
    bpm: () => cpsToBpm(cpsAtMs(timeline, now())),
    timeline: () => timeline,
    setTimeline(next) {
      if (!running) {
        timeline = next;
        return;
      }
      const t = now();
      const before = cycleAtMs(timeline, t);
      const after = cycleAtMs(next, t);
      timeline = next;
      if (Math.abs(after - before) > JUMP_CYCLES) {
        // Bars are never announced twice; after a forward jump, carry on from the new position.
        if (after < before) log?.warn('timeline moved the clock backwards', { before, after });
        lastBar = Math.max(lastBar, barInProgress(after));
      }
      arm();
    },
    onBar(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      if (running) return;
      running = true;
      lastBar = barInProgress(cycleAtMs(timeline, now()));
      arm();
    },
    stop() {
      running = false;
      disarm();
    },
  };
}
