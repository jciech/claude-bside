// Runtime query budget: the backstop behind the validator's static density bound (./density.ts), which
// is a model and can miss a way to make a query expensive. The engine's per-tick guards only act once
// a query returns, and a query that builds 10⁹ intermediate haps never returns in time; this stops it
// from the inside.
//
// Strudel's Pattern constructor does `this.query = query` (core/pattern.mjs:52-56), and every pattern
// queries its sources through `pat.query(state)`. An accessor on Pattern.prototype takes over that
// property: the setter keeps the function, the getter hands out a wrapper that counts the call and the
// haps it returns into the active budget, and throws QueryBudgetExceeded past a limit, or before a
// query whose span alone could build more haps than remain. Without an active budget the getter
// returns the function itself. Patterns built before installation (module constants such as `sine`
// or `silence`) keep their own data property; the patterns around them still count.
import * as core from '@strudel/core';
import type { QueryLimits } from '../shared/limits.ts';

export type { QueryLimits };

export class QueryBudgetExceeded extends Error {
  readonly limit: 'calls' | 'haps';
  readonly limits: QueryLimits;
  constructor(limit: 'calls' | 'haps', limits: QueryLimits) {
    super(`the pattern needed more than ${limit === 'calls' ? `${limits.calls} queries` : `${limits.haps} events`} to answer one query`);
    this.name = 'QueryBudgetExceeded';
    this.limit = limit;
    this.limits = limits;
  }
}

export const isQueryBudgetExceeded = (e: unknown): e is QueryBudgetExceeded => e instanceof QueryBudgetExceeded;

interface Budget {
  limits: QueryLimits;
  calls: number;
  haps: number;
  exceeded: QueryBudgetExceeded | null;
}

type Query = (state: unknown) => unknown[];

const RAW = Symbol('bside.query');
const WRAPPED = Symbol('bside.budgeted');
/** On a wrapper: the function it counts, so a pattern built from `pat.query` stores the plain function. */
const UNWRAP = Symbol('bside.raw');

let active: Budget | null = null;

function fail(budget: Budget, limit: 'calls' | 'haps'): never {
  budget.exceeded ??= new QueryBudgetExceeded(limit, budget.limits);
  throw budget.exceeded;
}

interface Span {
  begin: { valueOf(): number };
  end: { valueOf(): number };
}
let lastSpan: Span | null = null;
let lastCycles = 0;

/**
 * Cycles a query covers: a leaf (pure, a mini atom) builds one hap per cycle in one call, before
 * returning. Fractions hold BigInts, so the conversion is cached: most queries pass their span on.
 */
function cyclesOf(state: { span?: Span } | null): number {
  const span = state?.span;
  if (!span) return 0;
  if (span !== lastSpan) {
    lastSpan = span;
    lastCycles = span.end.valueOf() - span.begin.valueOf();
  }
  return lastCycles;
}

function budgeted(raw: Query): Query {
  const wrapper = function (this: unknown, state: unknown) {
    const budget = active;
    if (budget === null) return raw.call(this, state);
    // Once exceeded, every query fails at once, even if something swallowed the first error.
    if (budget.exceeded || ++budget.calls > budget.limits.calls) fail(budget, 'calls');
    if (cyclesOf(state as { span?: Span } | null) > budget.limits.haps - budget.haps) fail(budget, 'haps');
    const haps = raw.call(this, state);
    budget.haps += haps?.length ?? 0;
    if (budget.haps > budget.limits.haps) fail(budget, 'haps');
    return haps;
  };
  (wrapper as unknown as Record<symbol, Query>)[UNWRAP] = raw;
  return wrapper;
}

type Guarded = Record<symbol, Query | undefined>;

/** Installs the accessor once; safe to call again. */
export function installQueryGuard(): void {
  const proto = core.Pattern.prototype as object;
  if (Object.getOwnPropertyDescriptor(proto, 'query')?.get) return;
  Object.defineProperty(proto, 'query', {
    configurable: true,
    enumerable: false,
    get(this: Guarded): Query | undefined {
      const raw = this[RAW];
      if (active === null || raw === undefined) return raw;
      return (this[WRAPPED] ??= budgeted(raw));
    },
    set(this: Guarded, fn: Query) {
      this[RAW] = (fn as unknown as Guarded)?.[UNWRAP] ?? fn;
      this[WRAPPED] = undefined;
      if (active !== null) active.calls++;
    },
  });
}

/**
 * Runs `fn` (which queries patterns) within `limits`; throws QueryBudgetExceeded as soon as they are
 * passed. A budget inside another counts toward both. `usage`, if given, receives what was used.
 */
export function withQueryBudget<T>(limits: QueryLimits, fn: () => T, usage?: { calls: number; haps: number }): T {
  const outer = active;
  const budget: Budget = { limits, calls: 0, haps: 0, exceeded: null };
  active = budget;
  try {
    const result = fn();
    if (budget.exceeded) throw budget.exceeded;
    return result;
  } finally {
    active = outer;
    if (outer) {
      outer.calls += budget.calls;
      outer.haps += budget.haps;
    }
    if (usage) {
      usage.calls = budget.calls;
      usage.haps = budget.haps;
    }
  }
}

installQueryGuard();
