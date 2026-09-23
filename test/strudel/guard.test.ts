// The runtime query budget (src/strudel/guard.ts): the backstop behind the static density bound. A
// query that would build millions of haps stops within milliseconds, and real music never trips it.
import { readFileSync } from 'node:fs';
import * as core from '@strudel/core';
import { describe, expect, it } from 'vitest';
import { QUERY_BUDGET_PER_BAR, QUERY_BUDGET_TICK, QUERY_BUDGET_TICK_BARS, queryBudget } from '../../src/shared/limits.ts';
import type { CheckPartInput } from '../../src/server/types.ts';
import { analyzeSection } from '../../src/strudel/analyze.ts';
import { createSoundIndex, parseCatalog } from '../../src/strudel/catalog.ts';
import { compilePart } from '../../src/strudel/compile.ts';
import { QueryBudgetExceeded, installQueryGuard, isQueryBudgetExceeded, withQueryBudget } from '../../src/strudel/guard.ts';
import { cycleState } from '../../src/strudel/query.ts';
import { compilePlayable, playableParts } from './playable.ts';

const compile = (code: string) => compilePart(code, { knob: () => core.signal(() => 1023) }).pattern;
const query = (pattern: any, from: number, to: number) => pattern.query(cycleState(from, to, { _cps: 0.5 })) as unknown[];
const usage = () => ({ calls: 0, haps: 0 });

function timed(fn: () => unknown): { ms: number; error: unknown } {
  const t0 = performance.now();
  try {
    fn();
    return { ms: performance.now() - t0, error: null };
  } catch (e) {
    return { ms: performance.now() - t0, error: e };
  }
}

describe('the query budget', () => {
  it('counts nothing and returns the plain query function when no budget is active', () => {
    const pattern = compile('s("bd*4").gain(0.5)');
    expect(pattern.query).toBe(pattern.query);
    const plain = pattern.query;
    withQueryBudget(QUERY_BUDGET_TICK, () => expect(pattern.query).not.toBe(plain));
    expect(query(pattern, 0, 1)).toHaveLength(4);
  });

  it('counts queries and the haps they return at every level', () => {
    const used = usage();
    const haps = withQueryBudget(QUERY_BUDGET_TICK, () => query(compile('s("bd*4").gain(0.5)'), 0, 1), used);
    expect(haps).toHaveLength(4);
    expect(used.calls).toBeGreaterThan(2);
    expect(used.haps).toBeGreaterThan(4);
  });

  it('throws QueryBudgetExceeded past either limit', () => {
    const pattern = compile('s("hh*16").gain(0.5).pan(0.5)');
    expect(() => withQueryBudget({ calls: 3, haps: 1e6 }, () => query(pattern, 0, 1))).toThrow(QueryBudgetExceeded);
    const e = timed(() => withQueryBudget({ calls: 1e6, haps: 20 }, () => query(pattern, 0, 1))).error;
    expect(isQueryBudgetExceeded(e) && e.limit).toBe('haps');
  });

  it('still fails when Strudel swallows the error (queryArc logs and returns [])', () => {
    const pattern = compile('s("hh*16").gain(0.5)');
    let swallowed: unknown[] | null = null;
    const log = console.log;
    console.log = () => {};
    try {
      expect(() => withQueryBudget({ calls: 1e6, haps: 5 }, () => (swallowed = pattern.queryArc(0, 1)))).toThrow(QueryBudgetExceeded);
    } finally {
      console.log = log;
    }
    expect(swallowed).toEqual([]);
  });

  it('keeps the plain function in patterns built from a budgeted `pat.query` (withSteps does that)', () => {
    const pattern = compile('s("bd*4")');
    const copy = withQueryBudget(QUERY_BUDGET_TICK, () => new core.Pattern(pattern.query));
    const direct = usage();
    const viaCopy = usage();
    withQueryBudget(QUERY_BUDGET_TICK, () => query(pattern, 0, 1), direct);
    withQueryBudget(QUERY_BUDGET_TICK, () => query(copy, 0, 1), viaCopy);
    // A wrapped wrapper would count every query of the copy twice.
    expect(viaCopy).toEqual(direct);
  });

  it('adds a nested budget to the one around it, and installs once', () => {
    const outer = usage();
    const inner = usage();
    withQueryBudget(QUERY_BUDGET_PER_BAR, () => withQueryBudget(QUERY_BUDGET_TICK, () => query(compile('s("bd*4")'), 0, 1), inner), outer);
    expect(outer.calls).toBeGreaterThanOrEqual(inner.calls);
    expect(outer.haps).toBe(inner.haps);
    const descriptor = Object.getOwnPropertyDescriptor(core.Pattern.prototype, 'query');
    installQueryGuard();
    expect(Object.getOwnPropertyDescriptor(core.Pattern.prototype, 'query')).toEqual(descriptor);
  });

  it('gives a tick its own budget and longer queries one per bar', () => {
    expect(queryBudget(0.025)).toBe(QUERY_BUDGET_TICK);
    expect(queryBudget(QUERY_BUDGET_TICK_BARS)).toBe(QUERY_BUDGET_TICK);
    expect(queryBudget(1)).toEqual(QUERY_BUDGET_PER_BAR);
    expect(queryBudget(8)).toEqual({ calls: 8 * QUERY_BUDGET_PER_BAR.calls, haps: 8 * QUERY_BUDGET_PER_BAR.haps });
  });
});

describe('queries the static bound once missed stop within milliseconds', () => {
  // Compiled without the validator: before the fixes R00-R02 these validated, and each builds from
  // a million to billions of haps in one query of a single tick.
  it.each([
    ['R00: struct over a multiplied receiver', 's("bd").ply(16).ply(16).ply(16).ply(16).ply(16).struct("x")', 0],
    ['R00: arp', 'n("0").s("sine").ply(16).ply(16).ply(16).ply(16).arp("0")', 0],
    ['R01: ribbon exempts the part from the ceiling', 's("hh*16").ribbon(0, 1).lastOf(100, x => x.ply(16).ply(16).ply(16).ply(16).ply(16))', 99],
    ['R02: a multiplied value behind a late condition', 's("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16).ply(16)))', 1023],
    ['R02: a knob moves the condition into bar 0', 's("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16).ply(16))).early(knob("k"))', 0],
    ['R02: a value read across 100 000-cycle events', 's("bd").slow(100000).gain("1*16")', 0],
  ])('%s', (_, code, bar) => {
    const pattern = compile(code);
    const used = usage();
    const run = timed(() => withQueryBudget(queryBudget(1 / 8), () => query(pattern, bar, bar + 1 / 8), used));
    expect(isQueryBudgetExceeded(run.error), String(run.error)).toBe(true);
    expect(run.ms).toBeLessThan(500);
    expect(used.haps).toBeLessThanOrEqual(QUERY_BUDGET_TICK.haps + 4096);
  });

  it('becomes a density error in the checker instead of a worker timeout', () => {
    const index = createSoundIndex(parseCatalog(JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'))));
    const code = 's("bd").ply(16).ply(16).ply(16).ply(16).ply(16).struct("x")';
    const part: CheckPartInput = { id: 'bomb', role: 'perc', code, knobs: [], chromatic: false, level: 0.8, enterBar: 0, exitBar: null, patternBarAtStart: 0 };
    const t0 = performance.now();
    const result = analyzeSection({ parts: [{ ...part, pattern: compile(code) }], bpm: 120, scale: null, bars: 16, index });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(result.parts[0]!.errors).toEqual([expect.objectContaining({ rule: 'density', message: expect.stringMatching(/^Playing bar 0 needs more work than the engine allows for one query/) })]);
  });
});

describe('calibration', () => {
  it('lets every playable part play with room to spare: the limits sit 20× above what it needs', () => {
    const parts = playableParts();
    const most = { tick: usage(), bar: usage() };
    const note = (into: { calls: number; haps: number }, used: { calls: number; haps: number }) => {
      into.calls = Math.max(into.calls, used.calls);
      into.haps = Math.max(into.haps, used.haps);
    };
    for (const p of parts) {
      const pattern = compilePlayable(p);
      for (let bar = 0; bar < 16; bar++) {
        const used = usage();
        withQueryBudget(queryBudget(1), () => query(pattern, bar, bar + 1), used);
        note(most.bar, used);
      }
      for (let t = 0; t < 4; t += 1 / 8) {
        const used = usage();
        withQueryBudget(queryBudget(QUERY_BUDGET_TICK_BARS), () => query(pattern, t, t + QUERY_BUDGET_TICK_BARS), used);
        note(most.tick, used);
      }
    }
    expect(20 * most.tick.calls).toBeLessThanOrEqual(QUERY_BUDGET_TICK.calls);
    expect(20 * most.tick.haps).toBeLessThanOrEqual(QUERY_BUDGET_TICK.haps);
    expect(20 * most.bar.calls).toBeLessThanOrEqual(QUERY_BUDGET_PER_BAR.calls);
    expect(20 * most.bar.haps).toBeLessThanOrEqual(QUERY_BUDGET_PER_BAR.haps);
  }, 120_000);
});
