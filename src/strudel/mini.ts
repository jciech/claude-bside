// Mini-notation checks with the real krill parser (the one @strudel/mini uses, same "…" wrapping as
// mini.mjs mini2ast), plus a static worst case of events per cycle so density can be bounded before
// anything is evaluated. Pure: no Strudel runtime needed.
import { parse, type KrillSyntaxError } from '@strudel/mini/krill-parser.js';
import { MAX_DENSITY_FACTOR } from '../shared/limits.ts';

interface KNode {
  type_: string;
  source_?: unknown;
  arguments_?: Record<string, unknown>;
  options_?: { ops?: KOp[]; weight?: number; reps?: number };
  location_?: { start: { offset: number }; end: { offset: number } };
}
interface KOp {
  type_: string;
  arguments_: Record<string, unknown>;
}

export interface MiniProblem {
  message: string;
  /** Offset inside the string value (0 = first character after the quote). */
  offset: number;
  hint?: string;
}

export type MiniCheck =
  | {
      ok: true;
      events: number;
      /** Worst case of events sounding at the same moment ("a, b, c" → 3; "a b c" → 1). */
      polyphony: number;
      /** Longest `a:b:c` list a single event carries (1 when there are no lists). */
      listLength: number;
      /** Longest event, in cycles ("a/4" → 4, "<a@3 b>" → 3, "a b" → 1/2; 0 for rests only). */
      span: number;
      problems: MiniProblem[];
      constant: number | null;
    }
  | { ok: false; message: string; offset: number; hint: string };

const REST = new Set(['~', '-']);
const MIN_SLOW = 1 / MAX_DENSITY_FACTOR;

const MINI_HINT =
  'Mini-notation: "a b" sequence, "<a b>" one per bar, "[a b]" group, "a*2" repeat faster, "a!2" replicate, ' +
  '"a@3" stretch, "a(3,8)" euclid, "~" rest, "a?" random drop, "[a|b]" random choice, "a, b" play together.';

const isNode = (x: unknown): x is KNode => !!x && typeof x === 'object' && 'type_' in x;
const offsetOf = (n: KNode | undefined) => Math.max(0, (n?.location_?.start.offset ?? 1) - 1);

const cache = new Map<string, MiniCheck>();
const CACHE_SIZE = 512;

/** Parses and bounds one mini-notation string (the value between the quotes). */
export function checkMini(value: string): MiniCheck {
  const hit = cache.get(value);
  if (hit) return hit;
  const result = parseAndBound(value);
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
  cache.set(value, result);
  return result;
}

function parseAndBound(value: string): MiniCheck {
  let ast: unknown;
  try {
    ast = parse(`"${value}"`);
  } catch (e) {
    const err = e as KrillSyntaxError & { found?: string | null };
    const offset = Math.max(0, (err.location?.start.offset ?? 1) - 1);
    return { ok: false, offset, ...describeSyntaxError(value, offset, err) };
  }
  const problems: MiniProblem[] = [];
  if (!isNode(ast)) return { ok: true, events: 1, polyphony: 1, listLength: 1, span: 1, problems, constant: null };
  return {
    ok: true,
    events: countEvents(ast, problems),
    polyphony: polyphonyOf(ast),
    listLength: listLengthOf(ast),
    span: spanOf(ast),
    problems,
    constant: constantOf(ast),
  };
}

/** Numeric atoms of a mini string: the largest magnitude, and whether any atom is not a number. */
export function miniNumbers(value: string): { maxAbs: number; nonNumeric: boolean } | null {
  let ast: unknown;
  try {
    ast = parse(`"${value}"`);
  } catch {
    return null;
  }
  let maxAbs = 0;
  let nonNumeric = false;
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!isNode(x)) return;
    if (x.type_ === 'atom') {
      const src = String(x.source_);
      if (REST.has(src) || src === '_') return;
      const v = Number(src);
      if (src.trim() === '' || !Number.isFinite(v)) nonNumeric = true;
      else maxAbs = Math.max(maxAbs, Math.abs(v));
      return;
    }
    visit(x.source_);
    for (const op of x.options_?.ops ?? []) visit(Object.values(op.arguments_));
  };
  visit(ast);
  return { maxAbs, nonNumeric };
}

/** Events that can sound at once: stacked layers add up, sequences and alternations take the widest. */
function polyphonyOf(node: KNode): number {
  switch (node.type_) {
    case 'atom':
      return REST.has(String(node.source_)) ? 0 : 1;
    case 'element':
    case 'stretch':
      return isNode(node.source_) ? polyphonyOf(node.source_) : 1;
    case 'pattern': {
      const kids = childrenOf(node).map(polyphonyOf);
      const layered = ['stack', 'polymeter', 'polymeter_slowcat'].includes(String(node.arguments_?.alignment));
      return layered ? kids.reduce((a, b) => a + b, 0) : Math.max(0, ...kids);
    }
    default:
      return 1;
  }
}

function listLengthOf(node: KNode): number {
  const own = node.type_ === 'element' ? 1 + (node.options_?.ops ?? []).filter((op) => op.type_ === 'tail').length : 1;
  const inner = Array.isArray(node.source_) ? node.source_.filter(isNode).map(listLengthOf) : isNode(node.source_) ? [listLengthOf(node.source_)] : [];
  return Math.max(own, ...inner);
}

const PAIRS: Record<string, string> = { '[': ']', '<': '>', '{': '}', '(': ')' };

/** The innermost bracket still open at `offset`, if any. */
function unclosed(text: string): string | null {
  const stack: string[] = [];
  for (const ch of text) {
    if (Object.hasOwn(PAIRS, ch)) stack.push(ch);
    else if (stack.length && PAIRS[stack[stack.length - 1]!] === ch) stack.pop();
  }
  return stack.length ? stack[stack.length - 1]! : null;
}

function describeSyntaxError(value: string, offset: number, err: { found?: string | null }): { message: string; hint: string } {
  const before = value.slice(0, offset);
  const open = unclosed(before);
  if (err.found === '|' && open === '<') {
    return {
      message: 'random choice "|" cannot sit directly inside <…>',
      hint: 'Wrap the choice in brackets: "<[c3|e3] g3>".',
    };
  }
  const atEnd = err.found == null || (err.found === '"' && offset >= value.length);
  if (atEnd && open) return { message: `missing closing ${PAIRS[open]}`, hint: 'Balance every [ ] < > { } ( ).' };
  const found = atEnd ? 'end of string' : JSON.stringify(err.found);
  return { message: `unexpected ${found}`, hint: MINI_HINT };
}

/** Numeric values an amount sub-pattern can take (e.g. `*<2 4>` → [2, 4]); non-numbers are reported. */
function valuesOf(node: unknown, problems: MiniProblem[], what: string): number[] {
  const out: number[] = [];
  const visit = (x: unknown) => {
    if (Array.isArray(x)) return x.forEach(visit);
    if (!isNode(x)) return;
    if (x.type_ === 'atom') {
      const src = String(x.source_);
      if (REST.has(src)) return;
      const v = Number(src);
      if (src.trim() === '' || !Number.isFinite(v)) problems.push({ message: `${what} must be a number, got "${src}"`, offset: offsetOf(x) });
      else out.push(v);
      return;
    }
    if (x.type_ === 'element') {
      visit(x.source_);
      for (const op of x.options_?.ops ?? []) if (op.type_ === 'range') visit(op.arguments_.element);
      return;
    }
    visit(x.source_);
  };
  visit(node);
  return out;
}

function countEvents(node: KNode, problems: MiniProblem[]): number {
  switch (node.type_) {
    case 'atom':
      return REST.has(String(node.source_)) ? 0 : 1;
    case 'element':
      return elementEvents(node, problems);
    case 'pattern':
      return patternEvents(node, problems);
    case 'stretch': {
      const slow = valuesOf(node.arguments_?.amount, problems, 'slow factor');
      return (isNode(node.source_) ? countEvents(node.source_, problems) : 1) * slowFactor(slow, node, problems);
    }
    default:
      return 1;
  }
}

function slowFactor(values: number[], at: KNode, problems: MiniProblem[]): number {
  const min = Math.min(...values);
  if (!values.length) return 1;
  if (min < MIN_SLOW) {
    problems.push({
      message: `"/${min}" speeds the pattern up more than ${MAX_DENSITY_FACTOR}×`,
      offset: offsetOf(at),
      hint: `Slow factors must be at least 1/${MAX_DENSITY_FACTOR}; use "*n" (n ≤ ${MAX_DENSITY_FACTOR}) to speed up.`,
    });
  }
  return Math.max(1, 1 / Math.max(min, MIN_SLOW));
}

function checkFactor(values: number[], at: KNode, label: string, problems: MiniProblem[]): number {
  if (!values.length) return 1;
  const max = Math.max(...values);
  const min = Math.min(...values);
  if (max > MAX_DENSITY_FACTOR || min < 0) {
    problems.push({
      message: `${label} ${min < 0 ? min : max} is outside 0…${MAX_DENSITY_FACTOR}`,
      offset: offsetOf(at),
      hint: `Density factors in mini-notation must be between 0 and ${MAX_DENSITY_FACTOR}; 2–8 is typical.`,
    });
  }
  return Math.min(Math.max(1, max), MAX_DENSITY_FACTOR * 4);
}

/**
 * Worst events of one element. As a step of `<…>` (`inSlowcat`) its `!` copies and `@` weight make it
 * last more cycles, not play more per cycle: slowcatWorst accounts for them.
 */
function elementEvents(el: KNode, problems: MiniProblem[], inSlowcat = false): number {
  let events = isNode(el.source_) ? countEvents(el.source_, problems) : 1;
  const ops = el.options_?.ops ?? [];
  for (const op of ops) {
    const a = op.arguments_;
    switch (op.type_) {
      case 'stretch': {
        const values = valuesOf(a.amount, problems, a.type === 'slow' ? 'slow factor' : 'speed factor');
        const at = isNode(a.amount) ? a.amount : el;
        events *= a.type === 'slow' ? slowFactor(values, at, problems) : checkFactor(values, at, '"*"', problems);
        break;
      }
      case 'replicate':
        if (!inSlowcat) events *= checkFactor([Number(a.amount)], el, '"!" count', problems);
        break;
      case 'bjorklund': {
        const pulses = valuesOf(a.pulse, problems, 'euclid pulses');
        const steps = valuesOf(a.step, problems, 'euclid steps');
        if (a.rotation) valuesOf(a.rotation, problems, 'euclid rotation');
        const at = isNode(a.pulse) ? a.pulse : el;
        checkFactor(steps, isNode(a.step) ? a.step : el, 'euclid steps', problems);
        if (pulses.length && steps.length && (Math.min(...pulses) < 0 || Math.max(...pulses) > Math.min(...steps))) {
          problems.push({ message: 'euclid pulses must be between 0 and the number of steps', offset: offsetOf(at), hint: 'e.g. "bd(3,8)" or "bd(5,8,2)".' });
        }
        events *= Math.max(1, Math.min(Math.max(0, ...pulses), MAX_DENSITY_FACTOR));
        break;
      }
      case 'range': {
        const from = valuesOf(el.source_, problems, 'range start');
        const to = valuesOf(a.element, problems, 'range end');
        if (from.length && to.length) events = Math.max(...to.map((t) => Math.max(...from.map((f) => Math.abs(t - f) + 1))));
        break;
      }
      default:
        break; // degradeBy (?) and tail (:) never add events
    }
  }
  const weight = el.options_?.weight ?? 1;
  if (!inSlowcat && !ops.some((op) => op.type_ === 'replicate') && weight > MAX_DENSITY_FACTOR) {
    problems.push({ message: `"@${weight}" is longer than ${MAX_DENSITY_FACTOR}`, offset: offsetOf(el), hint: `Keep weights ≤ ${MAX_DENSITY_FACTOR}.` });
  }
  return events;
}

const weightOf = (n: unknown) => (isNode(n) ? (n.options_?.weight ?? 1) : 1);
const childrenOf = (n: KNode): KNode[] => (Array.isArray(n.source_) ? n.source_.filter(isNode) : []);

function patternEvents(p: KNode, problems: MiniProblem[]): number {
  const kids = childrenOf(p);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  switch (p.arguments_?.alignment) {
    case 'rand':
      return Math.max(0, ...kids.map((k) => countEvents(k, problems)));
    case 'polymeter_slowcat':
      return sum(kids.map((seq) => slowcatWorst(seq, problems)));
    case 'polymeter': {
      const spc = p.arguments_?.stepsPerCycle;
      const first = kids[0];
      const steps = spc
        ? checkFactor(valuesOf(spc, problems, 'steps per cycle'), isNode(spc) ? spc : p, '"%" steps', problems)
        : first ? sum(childrenOf(first).map(weightOf)) : 1;
      return sum(kids.map((seq) => (countEvents(seq, problems) * steps) / Math.max(1e-9, sum(childrenOf(seq).map(weightOf)) || 1)));
    }
    default:
      return sum(kids.map((k) => countEvents(k, problems)));
  }
}

/**
 * Worst events in one cycle of `<a b c>`. A step lasts `weight` cycles and plays its `!` copies one
 * after another (mini.mjs: repeatCycles(n).fast(n) on a step of weight n), so "<a!32 b!32>" still
 * plays one step per cycle.
 */
function slowcatWorst(seq: KNode, problems: MiniProblem[]): number {
  if (seq.type_ !== 'pattern') return countEvents(seq, problems);
  const per = childrenOf(seq).map((el) => ({ events: elementEvents(el, problems, true) * repsOf(el), weight: weightOf(el) }));
  if (per.some((x) => x.weight < 1)) return per.reduce((a, x) => a + x.events, 0);
  const worst = Math.max(0, ...per.map((x) => Math.ceil(x.events / x.weight)));
  return per.every((x) => Number.isInteger(x.weight)) ? worst : 2 * worst;
}

function repsOf(el: KNode): number {
  const op = el.options_?.ops?.find((o) => o.type_ === 'replicate');
  const n = Number(op?.arguments_.amount ?? 1);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Numeric atoms of an amount sub-pattern, without reporting (countEvents reports them). */
const amounts = (node: unknown): number[] => valuesOf(node, [], '');

// ─── Event length ─────────────────────────────────────────────────────────────────────────────────
// How long one event can last, in cycles, following mini.mjs: a step of weight w in a sequence of
// total weight W lasts w/W of its parent's cycle; in `<…>` it lasts w cycles (the sequence is slowed
// by W), in `{…}%n` w/n cycles.

function spanOf(node: KNode): number {
  switch (node.type_) {
    case 'atom':
      return REST.has(String(node.source_)) ? 0 : 1;
    case 'element':
      return elementSpan(node);
    case 'pattern':
      return patternSpan(node);
    case 'stretch':
      return (isNode(node.source_) ? spanOf(node.source_) : 1) * Math.max(0, ...amounts(node.arguments_?.amount));
    default:
      return 1;
  }
}

/** An element's longest event within its own cycle, before its step's share of the parent. */
function elementSpan(el: KNode): number {
  let span = isNode(el.source_) ? spanOf(el.source_) : 1;
  for (const op of el.options_?.ops ?? []) {
    if (op.type_ === 'stretch') {
      const values = amounts(op.arguments_.amount);
      if (!values.length) continue;
      if (op.arguments_.type === 'slow') span *= Math.max(0, ...values);
      else {
        const positive = values.filter((v) => v > 0);
        span = positive.length ? span / Math.min(...positive) : 0;
      }
    } else if (op.type_ === 'replicate') span /= repsOf(el);
  }
  return span;
}

/** Longest step of a sequence in units of its steps (the element's own span × its weight). */
const stepsSpan = (seq: KNode): number =>
  seq.type_ === 'pattern' ? Math.max(0, ...childrenOf(seq).map((el) => (el.type_ === 'element' ? elementSpan(el) : spanOf(el)) * weightOf(el))) : spanOf(seq);

function patternSpan(p: KNode): number {
  const kids = childrenOf(p);
  const longest = (xs: number[]) => Math.max(0, ...xs);
  switch (p.arguments_?.alignment) {
    case 'stack':
    case 'rand':
      return longest(kids.map(spanOf));
    case 'polymeter_slowcat':
      return longest(kids.map(stepsSpan));
    case 'polymeter': {
      const spc = p.arguments_?.stepsPerCycle;
      const given = spc ? amounts(spc).filter((v) => v > 0) : [];
      const first = kids[0];
      const steps = given.length ? Math.min(...given) : first ? childrenOf(first).reduce((a, k) => a + weightOf(k), 0) || 1 : 1;
      return longest(kids.map(stepsSpan)) / steps;
    }
    case 'feet':
      return longest(kids.map(spanOf)) / Math.max(1, kids.length);
    default: {
      const total = kids.reduce((a, k) => a + weightOf(k), 0);
      return total > 0 ? stepsSpan(p) / total : 0;
    }
  }
}

/** The number a mini string stands for when it is just one numeric atom ("2"), else null. */
function constantOf(root: KNode): number | null {
  const kids = childrenOf(root);
  if (root.type_ !== 'pattern' || kids.length !== 1) return null;
  const el = kids[0]!;
  if (el.type_ !== 'element' || (el.options_?.ops?.length ?? 0) > 0 || !isNode(el.source_) || el.source_.type_ !== 'atom') return null;
  const v = Number(el.source_.source_);
  return Number.isFinite(v) && String(el.source_.source_).trim() !== '' ? v : null;
}
