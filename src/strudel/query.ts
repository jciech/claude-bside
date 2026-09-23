// Querying Strudel patterns for analysis: raw State queries (queryArc swallows exceptions,
// core/pattern.mjs:414-420) and capture of the problems Strudel only reports through its logger.
import * as core from '@strudel/core';

export const cycleState = (from: number, to: number, controls: Record<string, unknown>) =>
  new core.State(new core.TimeSpan(core.Fraction(from), core.Fraction(to)), controls);

/** Runs `fn` while collecting Strudel's logger output (it only reports some problems that way). */
export function captureLogs<T>(fn: () => T): { result: T; logs: string[] } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('%c')) logs.push(args[0].slice(2));
    else original(...args);
  };
  try {
    core.logger(`[bside] ${Math.random()}`); // resets the logger's 1 s de-duplication (logger.mjs:14-19)
    logs.length = 0;
    return { result: fn(), logs };
  } finally {
    console.log = original;
  }
}
