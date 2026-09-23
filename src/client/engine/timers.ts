// Scheduler timers. worker-timers runs them in a worker so background tabs aren't throttled to
// 1 Hz (strudel.cc does the same); without Worker support (tests, old browsers) it falls back.
import * as workerTimers from 'worker-timers';

export interface Timers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const nativeTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
};

export function backgroundTimers(): Timers {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') return nativeTimers;
  return {
    setInterval: (fn, ms) => workerTimers.setInterval(fn, ms),
    clearInterval: (id) => {
      try {
        workerTimers.clearInterval(id as number);
      } catch {
        // already cleared
      }
    },
    setTimeout: (fn, ms) => workerTimers.setTimeout(fn, ms),
    clearTimeout: (id) => {
      try {
        workerTimers.clearTimeout(id as number);
      } catch {
        // already fired
      }
    },
  };
}
