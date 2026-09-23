// The security boundary: a static allowlist check of composer-written part code, on the source as
// written (so every issue points at the composer's own text), parsed with the same acorn options as
// @strudel/transpiler. Pure and isomorphic: the server checker and every browser run it before
// anything is compiled. Accepted code is at most a few `const` bindings followed by ONE pattern
// expression built from allowlisted calls, literals, arithmetic and expression-bodied arrows.
import { parse, type Comment, type Expression, type Node, type Program, type SpreadElement } from 'acorn';
import type { Issue } from '../shared/analysis.ts';
import { MAX_DENSITY_FACTOR, MAX_PART_ONSETS_PER_BAR } from '../shared/limits.ts';
import { ALLOWLIST } from './allowlist.ts';
import { STATIC_EVENTS_CEILING, constantValue, densityBound, densitySpec, valueBound, type DensitySpec, type ValueBound } from './density.ts';
import { checkMini, miniNumbers } from './mini.ts';
import { synonymOf, suggest } from './suggest.ts';

export interface ValidateResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  knobsUsed: string[];
}

export const MAX_CODE_CHARS = 1200;
const MAX_NODES = 1500;
const MAX_DEPTH = 60;
const MAX_STRING_CHARS = 400;
const MAX_NUMBER = 1e6;
const MAX_CONSTS = 8;
const KNOB_NAME = /^[a-z][a-z0-9_]{0,15}$/;
/** Same parser options as @strudel/transpiler (transpiler.mjs:25-30). */
const ACORN = { ecmaVersion: 2022, allowAwaitOutsideFunction: true, locations: true } as const;
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);
/** Characters that make a single-quoted string look like mini-notation the author meant to pattern. */
const MINI_LOOKING = /[\s[\]<>{}*!@?|,~()%]/;

const EXAMPLE = 'e.g. n("0 2 4").scale("C:minor").s("sawtooth").lpf(800)';

type Call = Extract<Expression, { type: 'CallExpression' }>;
type Member = Extract<Expression, { type: 'MemberExpression' }>;

class Reporter {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  private readonly lineStarts: number[] = [0];
  private readonly code: string;
  constructor(code: string) {
    this.code = code;
    for (let i = 0; i < code.length; i++) if (code[i] === '\n') this.lineStarts.push(i + 1);
  }
  error(rule: string, message: string, at: number | null, hint?: string): void {
    this.errors.push(this.issue('error', rule, message, at, hint));
  }
  warn(rule: string, message: string, at: number | null, hint?: string): void {
    this.warnings.push(this.issue('warning', rule, message, at, hint));
  }
  private issue(severity: Issue['severity'], rule: string, message: string, at: number | null, hint?: string): Issue {
    const issue: Issue = { severity, rule, message };
    if (at !== null) {
      let line = 0;
      while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1]! <= at) line++;
      const start = this.lineStarts[line]!;
      const column = at - start;
      const text = this.code.slice(start, this.lineStarts[line + 1] ?? this.code.length).replace(/\n$/, '');
      issue.line = line + 1;
      issue.column = column + 1;
      issue.excerpt = `${text}\n${' '.repeat(column)}^`;
    }
    if (hint) issue.hint = hint;
    return issue;
  }
}

function deniedHint(name: string): string | undefined {
  if (['setcps', 'setcpm', 'setCps', 'setCpm', 'cps', 'cpm'].includes(name)) return 'Tempo is set by the section\'s bpm; remove the call.';
  if (['orbit', 'o', 'duck', 'duckorbit', 'duckdepth', 'duckattack'].includes(name)) return 'The engine routes each part itself; use the part\'s duck field for sidechaining.';
  if (['samples', 'aliasBank', 'setSoundfontUrl', 'loadSoundfont'].includes(name)) return 'Use sounds from the catalog as they are.';
  if (['filter', 'withValue', 'fmap'].includes(name)) return 'For a low-pass filter use .lpf(freq); for conditional changes use .every(n, x => …) or .sometimes(x => …).';
  if (['polymeter', 'pm', 'pace', 'steps'].includes(name)) return 'Write polymeters in mini-notation: "{bd sd hh, cp ~}%4".';
  if (name === 'm') return 'Write a "double-quoted" string; it is mini-notation already.';
  const syn = synonymOf(name);
  return syn && ALLOWLIST.methods.has(syn) ? `Did you mean .${syn}()?` : undefined;
}

/** Validates one part's code. `knobs` are the declared knob names (inherited included). */
export function validatePart(code: string, opts: { knobs: string[] }): ValidateResult {
  const r = new Reporter(typeof code === 'string' ? code : '');
  const knobsUsed: string[] = [];
  const done = (): ValidateResult => ({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, knobsUsed });

  if (typeof code !== 'string' || code.trim() === '') {
    r.error('syntax', 'The code is empty.', null, `Write one pattern expression, ${EXAMPLE}.`);
    return done();
  }
  if (code.length > MAX_CODE_CHARS) {
    r.error('size', `The code is ${code.length} characters; parts are limited to ${MAX_CODE_CHARS}.`, null, 'Split the idea across two parts.');
    return done();
  }

  const comments: Comment[] = [];
  let program: Program;
  try {
    program = parse(code, { ...ACORN, onComment: comments });
  } catch (e) {
    const err = e as SyntaxError & { pos?: number };
    const message = err.message.replace(/\s*\(\d+:\d+\)$/, '');
    r.error('syntax', `JavaScript syntax error: ${message}.`, err.pos ?? null,
      /Unterminated string/.test(message)
        ? 'Strings cannot span lines; keep each "mini-notation string" on one line.'
        : 'Check brackets and quotes: every part is one expression like s("bd*4").gain(0.8).');
    return done();
  }
  for (const c of comments) {
    if (/^\s*mini-(off|on)/.test(c.value)) r.error('syntax', 'mini-off/mini-on comments change how strings are read and are not allowed.', c.start);
  }

  const declared = new Set(opts.knobs);
  const locals = new Set<string>();
  const usedLocals = new Set<string>();
  let nodes = 0;

  const declarations: { name: string; init: Node }[] = [];
  let expression: Node | null = null;
  const statements = program.body.filter((s) => s.type !== 'EmptyStatement');
  if (statements.length === 0) r.error('syntax', 'The code has no pattern expression.', null, `Write one, ${EXAMPLE}.`);

  statements.forEach((stmt, i) => {
    const last = i === statements.length - 1;
    switch (stmt.type) {
      case 'VariableDeclaration': {
        if (stmt.kind !== 'const') return r.error('syntax', `Use const instead of ${stmt.kind}.`, stmt.start);
        for (const d of stmt.declarations) {
          if (d.id.type !== 'Identifier') { r.error('syntax', 'Destructuring is not allowed.', d.id.start); continue; }
          const { name } = d.id;
          if (!checkBindingName(name, d.id.start, 'Constant')) continue;
          if (locals.has(name)) r.error('syntax', `'${name}' is declared twice.`, d.id.start);
          if (!d.init) { r.error('syntax', `const ${name} needs a value.`, d.start); continue; }
          expr(d.init, locals, 0); // before the name is in scope: no self-reference, no recursion
          locals.add(name);
          declarations.push({ name, init: d.init });
        }
        if (declarations.length > MAX_CONSTS) r.error('size', `At most ${MAX_CONSTS} constants per part.`, stmt.start);
        if (last) r.error('syntax', 'The code must end with a pattern expression.', stmt.start, `After the constants, write the pattern, e.g. stack(${declarations.map((d) => d.name).join(', ')}).`);
        return;
      }
      case 'ExpressionStatement':
        if (!last) {
          r.error('syntax', 'Only one pattern expression is allowed per part.', stmt.start, 'Combine patterns with stack(a, b) or split them into separate parts.');
          expr(stmt.expression, locals, 0);
          return;
        }
        if ('directive' in stmt && stmt.directive) return r.error('syntax', 'Directives are not allowed.', stmt.start);
        expression = stmt.expression;
        expr(stmt.expression, locals, 0);
        return;
      case 'LabeledStatement':
        return r.error('syntax', `Labels like "${stmt.label.name}:" are not allowed: a part is exactly one expression and the room plays parts side by side.`,
          stmt.start, 'Remove the label and write just the pattern.');
      default:
        return r.error('syntax', `${describeStatement(stmt.type)} is not allowed; a part is const bindings followed by one pattern expression.`, stmt.start);
    }
  });

  for (const d of declarations) {
    if (!usedLocals.has(d.name)) r.warn('unused', `const ${d.name} is never used.`, d.init.start, 'Use it in the pattern or remove it.');
  }

  if (r.errors.length === 0 && expression) {
    const bound = densityBound(declarations, expression);
    if (bound.events > STATIC_EVENTS_CEILING) {
      r.error('density', `This part could produce up to ${formatCount(bound.events)} events in a single bar (static limit ${STATIC_EVENTS_CEILING}).`, null,
        `Largest multipliers: ${bound.multipliers.slice(0, 4).join(', ') || 'the mini-notation itself'}. Use smaller counts or fewer stacked copies (limit ${MAX_PART_ONSETS_PER_BAR} onsets per bar).`);
    }
  }
  return done();

  /** Constants may not hide Strudel functions; arrow parameters may (x => x.fast(2) with any name). */
  function checkBindingName(name: string, at: number, what: 'Constant' | 'Parameter'): boolean {
    if (name === 'knob' || ALLOWLIST.scopeOnly.has(name) || ALLOWLIST.denied.has(name)) {
      r.error('denied', `${what} name '${name}' is not allowed.`, at, 'Pick another name.');
      return false;
    }
    if (what === 'Constant' && ALLOWLIST.globals.has(name)) {
      r.error('syntax', `${what} name '${name}' hides the Strudel function ${name}().`, at, `Rename it, e.g. my${name[0]!.toUpperCase()}${name.slice(1)}.`);
      return false;
    }
    return true;
  }

  function expr(node: Node | SpreadElement | null, scope: ReadonlySet<string>, depth: number): void {
    if (!node) return;
    if (++nodes > MAX_NODES) {
      if (nodes === MAX_NODES + 1) r.error('size', `The code is too complex (more than ${MAX_NODES} syntax nodes).`, node.start, 'Simplify the part or split it.');
      return;
    }
    if (depth > MAX_DEPTH) return r.error('size', `Expressions are nested more than ${MAX_DEPTH} levels deep.`, node.start);
    const n = node as Expression | SpreadElement;
    switch (n.type) {
      case 'Literal':
        return literal(n);
      case 'TemplateLiteral':
        if (n.expressions.length) {
          return r.error('syntax', 'Template literals with ${…} are not allowed.', n.start, 'Use a plain "double-quoted" mini-notation string.');
        }
        return mini(n.quasis[0]!.value.raw, n.start);
      case 'Identifier':
        return identifier(n.name, n.start, scope, false);
      case 'CallExpression':
        return call(n, scope, depth);
      case 'MemberExpression':
        return member(n, scope, depth, false);
      case 'ArrowFunctionExpression': {
        if (n.async || n.generator) return r.error('syntax', 'async/generator functions are not allowed.', n.start);
        if (n.body.type === 'BlockStatement') {
          return r.error('syntax', 'Arrow functions must have an expression body, like x => x.fast(2).', n.start);
        }
        const inner = new Set(scope);
        for (const p of n.params) {
          if (p.type !== 'Identifier') { r.error('syntax', 'Arrow parameters must be plain names (no defaults or destructuring).', p.start); continue; }
          if (checkBindingName(p.name, p.start, 'Parameter')) inner.add(p.name);
        }
        return expr(n.body, inner, depth + 1);
      }
      case 'ArrayExpression':
        for (const el of n.elements) {
          if (el === null) r.error('syntax', 'Array holes ([a, , b]) are not allowed.', n.start);
          else expr(el, scope, depth + 1);
        }
        return;
      case 'ObjectExpression':
        return object(n, scope, depth);
      case 'BinaryExpression': {
        if (!ARITHMETIC.has(n.operator)) return r.error('syntax', `The operator ${n.operator} is not allowed; only + - * / % ** on numbers.`, n.start);
        const v = numericValue(n);
        if (v !== null && !(Math.abs(v) <= MAX_NUMBER)) {
          return r.error('number', `${clip(code.slice(n.start, n.end))} is ${String(v)}, out of range (±${MAX_NUMBER}).`, n.start);
        }
        expr(n.left, scope, depth + 1);
        return expr(n.right, scope, depth + 1);
      }
      case 'UnaryExpression':
        if (n.operator !== '-' && n.operator !== '+') return r.error('syntax', `The operator ${n.operator} is not allowed.`, n.start);
        return expr(n.argument, scope, depth + 1);
      case 'SpreadElement':
        return r.error('syntax', 'Spread (...x) is not allowed.', n.start);
      case 'TaggedTemplateExpression':
        return r.error('syntax', 'Tagged templates (tidal`…`, mondo`…`) are not allowed.', n.start, 'Use "double-quoted" mini-notation.');
      case 'ConditionalExpression':
      case 'LogicalExpression':
        return r.error('syntax', 'Conditionals and logical operators are not allowed.', n.start, 'Use pattern functions such as .every(n, x => …), .sometimes(x => …) or "<a b>".');
      case 'AssignmentExpression':
      case 'UpdateExpression':
        return r.error('syntax', 'Assignments are not allowed.', n.start);
      case 'ChainExpression':
        return r.error('syntax', 'Optional chaining (?.) is not allowed.', n.start);
      case 'SequenceExpression':
        return r.error('syntax', 'Comma expressions are not allowed.', n.start, 'Combine patterns with stack(a, b).');
      case 'FunctionExpression':
      case 'ClassExpression':
        return r.error('syntax', 'function/class expressions are not allowed; use x => x.method().', n.start);
      case 'NewExpression':
        return r.error('syntax', '`new` is not allowed.', n.start);
      case 'ThisExpression':
        return r.error('syntax', '`this` is not allowed.', n.start);
      case 'ImportExpression':
      case 'MetaProperty':
        return r.error('syntax', 'import is not allowed.', n.start);
      case 'AwaitExpression':
      case 'YieldExpression':
        return r.error('syntax', 'await/yield are not allowed.', n.start);
      default:
        return r.error('syntax', `${n.type} is not allowed.`, n.start);
    }
  }

  function literal(n: Extract<Expression, { type: 'Literal' }>): void {
    if ('regex' in n && n.regex) return r.error('syntax', 'Regular expressions are not allowed.', n.start);
    if (typeof n.value === 'bigint') return r.error('syntax', 'BigInt literals are not allowed.', n.start);
    if (n.value === null) return r.error('syntax', 'null is not allowed.', n.start);
    if (typeof n.value === 'number') {
      if (!Number.isFinite(n.value) || Math.abs(n.value) > MAX_NUMBER) r.error('number', `The number ${n.raw} is out of range (±${MAX_NUMBER}).`, n.start);
      return;
    }
    if (typeof n.value !== 'string') return;
    if (n.value.length > MAX_STRING_CHARS) return r.error('size', `String longer than ${MAX_STRING_CHARS} characters.`, n.start);
    if (n.raw?.[0] === '"') {
      if (n.raw.includes('\\')) return r.error('syntax', 'Escape sequences are not allowed in mini-notation strings.', n.start);
      return mini(n.value, n.start);
    }
    if (MINI_LOOKING.test(n.value)) {
      r.error('quotes', `'${n.value}' is a plain JavaScript string: single quotes are not mini-notation.`, n.start,
        `Use double quotes: "${n.value.replace(/"/g, '')}".`);
    }
  }

  function mini(value: string, start: number): void {
    const m = checkMini(value);
    const at = (offset: number) => start + 1 + offset;
    if (!m.ok) return r.error('mini', `Mini-notation error in "${clip(value)}": ${m.message}.`, at(m.offset), m.hint);
    for (const p of m.problems) r.error('density', `In "${clip(value)}": ${p.message}.`, at(p.offset), p.hint);
    if (m.events > MAX_PART_ONSETS_PER_BAR) {
      r.error('density', `"${clip(value)}" can produce up to ${formatCount(m.events)} events per bar (a part may play ${MAX_PART_ONSETS_PER_BAR}).`, start,
        'Use smaller *n / !n values; 16 per bar is already busy.');
    }
  }

  function identifier(name: string, at: number, scope: ReadonlySet<string>, callee: boolean): void {
    if (scope.has(name)) {
      usedLocals.add(name);
      return;
    }
    if (name === 'knob') return r.error('knob', 'knob must be called with a knob name: knob("cut").', at);
    const reason = ALLOWLIST.denied.get(name) ?? (ALLOWLIST.scopeOnly.has(name) ? 'mini-notation internals' : undefined);
    if (reason !== undefined) return r.error('denied', `'${name}' is not available in part code: ${reason}.`, at, deniedHint(name));
    if (ALLOWLIST.globals.has(name)) return;
    const s = suggest(name, ALLOWLIST.globals);
    r.error(callee ? 'unknown-function' : 'unknown-identifier', `Unknown ${callee ? 'function' : 'name'} '${name}'.`, at,
      s.length ? `Did you mean ${s.map((x) => `${x}()`).join(', ')}?` : 'Only Strudel functions are available.');
  }

  function object(n: Extract<Expression, { type: 'ObjectExpression' }>, scope: ReadonlySet<string>, depth: number): void {
    for (const prop of n.properties) {
      if (prop.type !== 'Property' || prop.kind !== 'init' || prop.method || prop.computed || prop.shorthand) {
        r.error('syntax', 'Only plain { control: value } object literals are allowed.', prop.start);
        continue;
      }
      if (prop.key.type !== 'Identifier') {
        r.error('syntax', 'Object keys must be bare control names, like { s: "bd" }.', prop.key.start);
        continue;
      }
      const key = prop.key.name;
      const reason = ALLOWLIST.denied.get(key);
      if (reason !== undefined) r.error('denied', `The key '${key}' is not available: ${reason}.`, prop.key.start);
      else if (!ALLOWLIST.controls.has(key)) {
        const s = suggest(key, ALLOWLIST.controls);
        r.error('unknown-key', `'${key}' is not a Strudel control name.`, prop.key.start, s.length ? `Did you mean ${s.join(', ')}?` : undefined);
      }
      expr(prop.value, scope, depth + 1);
    }
  }

  function call(n: Call, scope: ReadonlySet<string>, depth: number): void {
    if (n.optional) return r.error('syntax', 'Optional calls (?.) are not allowed.', n.start);
    const callee = n.callee;
    let name: string | null = null;
    let method = false;
    if (callee.type === 'Identifier') {
      if (callee.name === 'knob' && !scope.has('knob')) return knob(n);
      identifier(callee.name, callee.start, scope, true);
      if (!scope.has(callee.name)) name = callee.name;
    } else if (callee.type === 'MemberExpression') {
      member(callee, scope, depth + 1, true);
      if (callee.property.type === 'Identifier') {
        name = callee.property.name;
        method = true;
      }
    } else if (callee.type === 'ArrowFunctionExpression') {
      return r.error('syntax', 'Immediately-invoked functions are not allowed.', n.start);
    } else if (callee.type === 'CallExpression') {
      expr(callee, scope, depth + 1);
    } else if (callee.type !== 'Super') {
      expr(callee, scope, depth + 1);
    } else {
      return r.error('syntax', 'super is not allowed.', n.start);
    }
    const spec = name !== null ? densitySpec(name) : undefined;
    if (spec && name !== null) densityArgs(n, name, spec, method);
    const bound = name !== null ? valueBound(name) : undefined;
    if (bound && name !== null) boundedValue(n, name, bound, method);
    for (const a of n.arguments) expr(a, scope, depth + 1);
  }

  function boundedValue(n: Call, name: string, bound: ValueBound, method: boolean): void {
    const arg = n.arguments[bound.index];
    if (!arg) return;
    const shown = method ? `.${name}()` : `${name}()`;
    const constant = numericValue(arg);
    const inMini = arg.type === 'Literal' && typeof arg.value === 'string' && arg.raw?.[0] === '"' ? miniNumbers(arg.value) : null;
    const largest = constant !== null ? Math.abs(constant) : inMini && !inMini.nonNumeric ? inMini.maxAbs : null;
    if (largest === null) {
      r.error('number', `The ${bound.label} of ${shown} must be a number or a mini-notation string of numbers: ${bound.why}.`, arg.start,
        `Write e.g. ${method ? '.' : ''}${name}("<0 -1 2>").`);
    } else if (!(largest <= bound.maxAbs)) {
      r.error('number', `The ${bound.label} of ${shown} reaches ${formatCount(largest)}; it must stay within ±${bound.maxAbs}: ${bound.why}.`, arg.start);
    }
  }

  function densityArgs(n: Call, name: string, spec: DensitySpec, method: boolean): void {
    const [lo, hi] = Array.isArray(spec.arity) ? spec.arity : [spec.arity, spec.arity];
    const count = n.arguments.length;
    const shown = method ? `.${name}()` : `${name}()`;
    if (count < lo || count > (method ? hi : hi + 1)) {
      return r.error('syntax', `${shown} takes ${lo === hi ? lo : `${lo}–${hi}`} argument${hi === 1 ? '' : 's'}, got ${count}.`, n.start,
        name === 'echo' ? 'echo(count, time, feedback) repeats events; for an audio delay use .delay(0.3).' : undefined);
    }
    const values: number[] = [];
    for (const rule of spec.args) {
      const arg = n.arguments[rule.index];
      if (!arg) { values.push(rule.fallback ?? rule.max); continue; }
      const v = constantValue(arg);
      if (v === null) {
        r.error('density', `The ${rule.label} of ${shown} must be a constant number: a patterned value (or a knob) can multiply events or work at any later bar.`, arg.start,
          `Write e.g. ${method ? '.' : ''}${name}(${Math.min(2, rule.max)}). For variation, put it in the mini-notation ("<hh*8 hh*16>") or use .every(4, x => x.${name}(…)).`);
        values.push(rule.max);
        continue;
      }
      values.push(v);
      if (v < rule.min || v > rule.max) {
        r.error('density', `The ${rule.label} of ${shown} is ${v}; it must be between ${fmtRange(rule.min)} and ${fmtRange(rule.max)}.`, arg.start,
          rule.max === MAX_DENSITY_FACTOR ? `Density factors are limited to ${MAX_DENSITY_FACTOR}.` : undefined);
      } else if (rule.minAbs !== undefined && Math.abs(v) < rule.minAbs) {
        r.error('density', `The ${rule.label} of ${shown} is ${v}; its size must be at least ${fmtRange(rule.minAbs)}.`, arg.start);
      }
    }
    const problem = spec.check?.(values);
    if (problem) r.error('density', `${shown}: ${problem}.`, n.start);
  }

  function knob(n: Call): void {
    const arg = n.arguments[0];
    const name =
      n.arguments.length === 1 && arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value
      : n.arguments.length === 1 && arg?.type === 'TemplateLiteral' && arg.expressions.length === 0 ? arg.quasis[0]!.value.cooked
      : null;
    if (name === null || name === undefined) {
      return r.error('knob', 'knob() takes exactly one string: the name of a declared knob, e.g. knob("cut").', n.start);
    }
    if (!KNOB_NAME.test(name) || !declared.has(name)) {
      const s = suggest(name, declared, 2);
      return r.error('knob-undeclared', `knob("${name}") is not declared for this part.`, arg!.start,
        declared.size
          ? `Declared knobs: ${[...declared].join(', ')}${s.length ? ` (did you mean "${s[0]}"?)` : ''}. Or add {name: "${name}", …} to the part's knobs.`
          : `Add {name: "${name}", default, min, max, follows} to the part's knobs.`);
    }
    if (!knobsUsed.includes(name)) knobsUsed.push(name);
  }

  function member(n: Member, scope: ReadonlySet<string>, depth: number, isCallee: boolean): void {
    if (n.optional) return r.error('syntax', 'Optional chaining (?.) is not allowed.', n.start);
    if (n.computed) return r.error('syntax', 'Computed member access x[…] is not allowed.', n.property.start);
    if (n.property.type !== 'Identifier') return r.error('syntax', 'Private fields are not allowed.', n.property.start);
    const prop = n.property.name;
    const at = n.property.start;
    const reason = ALLOWLIST.denied.get(prop);
    if (reason !== undefined) return r.error('denied', `.${prop}() is not available in part code: ${reason}.`, at, deniedHint(prop));

    const obj = n.object;
    // pat.add.squeeze(…): an operator accessor followed by its mode (pattern.mjs:1096-1150)
    if (isCallee && ALLOWLIST.operatorModes.has(prop) && obj.type === 'MemberExpression' && !obj.computed &&
      obj.property.type === 'Identifier' && ALLOWLIST.operators.has(obj.property.name)) {
      return member(obj, scope, depth + 1, true);
    }
    if (!ALLOWLIST.methods.has(prop)) {
      const s = suggest(prop, ALLOWLIST.methods);
      r.error('unknown-method', `Unknown Strudel method .${prop}().`, at, s.length ? `Did you mean ${s.map((x) => `.${x}()`).join(', ')}?` : undefined);
    } else if (!isCallee) {
      r.error('syntax', `.${prop} must be called, like .${prop}(…).`, at);
    }
    if (obj.type === 'Literal' && typeof obj.value === 'string' && obj.raw?.[0] === "'") {
      return r.error('quotes', `'${obj.value}'.${prop}(): single-quoted strings are plain JavaScript strings, not patterns.`, obj.start,
        `Write "${obj.value}".${prop}(…) with double quotes.`);
    }
    if (obj.type === 'Literal' && typeof obj.value === 'number') {
      return r.error('syntax', `.${prop}() cannot be called on a number.`, obj.start, `Wrap it: pure(${obj.raw}).${prop}(…).`);
    }
    if (obj.type === 'Super') return r.error('syntax', 'super is not allowed.', obj.start);
    expr(obj, scope, depth + 1);
  }
}

/** Value of arithmetic on number literals (possibly not finite), or null when anything else is involved. */
function numericValue(node: Node): number | null {
  const n = node as Expression;
  if (n.type === 'Literal') return typeof n.value === 'number' ? n.value : null;
  if (n.type === 'UnaryExpression' && (n.operator === '-' || n.operator === '+')) {
    const v = numericValue(n.argument);
    return v === null ? null : n.operator === '-' ? -v : v;
  }
  if (n.type === 'BinaryExpression' && ARITHMETIC.has(n.operator)) {
    const a = numericValue(n.left as Node);
    const b = numericValue(n.right);
    if (a === null || b === null) return null;
    const ops: Record<string, (x: number, y: number) => number> = {
      '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => x / y, '%': (x, y) => x % y, '**': (x, y) => x ** y,
    };
    return ops[n.operator]!(a, b);
  }
  return null;
}

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 37)}…` : s);
const fmtRange = (v: number) => (v > 0 && v < 1 ? `1/${Math.round(1 / v)}` : String(v));
const formatCount = (v: number) => (v >= 1e9 ? 'more than a billion' : v >= 1e6 ? `${(v / 1e6).toPrecision(2)} million` : String(Math.round(v)));

function describeStatement(type: string): string {
  const names: Record<string, string> = {
    ForStatement: 'A for loop', ForInStatement: 'A for loop', ForOfStatement: 'A for loop', WhileStatement: 'A while loop',
    DoWhileStatement: 'A loop', IfStatement: 'if', FunctionDeclaration: 'A function declaration', ClassDeclaration: 'A class',
    TryStatement: 'try', ThrowStatement: 'throw', ReturnStatement: 'return', BlockStatement: 'A block { … }',
    DebuggerStatement: 'debugger', WithStatement: 'with', SwitchStatement: 'switch', ImportDeclaration: 'import',
    ExportNamedDeclaration: 'export', ExportDefaultDeclaration: 'export', ExportAllDeclaration: 'export',
  };
  return names[type] ?? type;
}

// ─── Post-transpile invariant ────────────────────────────────────────────────────────────────────
// The transpiler is not a security tool; after it runs, re-check that its output only contains what
// validated source can produce: allowlisted names, `m("…", offset)` calls it emitted, `return`.

const TRANSPILED_NODES = new Set([
  'Program', 'VariableDeclaration', 'VariableDeclarator', 'ExpressionStatement', 'ReturnStatement', 'EmptyStatement',
  'CallExpression', 'MemberExpression', 'Identifier', 'Literal', 'ArrayExpression', 'ObjectExpression', 'Property',
  'ArrowFunctionExpression', 'BinaryExpression', 'UnaryExpression',
]);

/** Returns a description of the first violation, or null when the transpiled program is clean. */
export function checkTranspiled(output: string, scope: ReadonlySet<string>): string | null {
  let program: Program;
  try {
    program = parse(output, { ecmaVersion: 2022, allowReturnOutsideFunction: true });
  } catch (e) {
    return `unparseable (${(e as Error).message})`;
  }
  const bound = new Set<string>();
  let problem: string | null = null;
  const fail = (why: string) => {
    problem ??= why;
  };

  const visit = (node: Node | null | undefined, locals: ReadonlySet<string>): void => {
    if (!node || problem) return;
    if (!TRANSPILED_NODES.has(node.type)) return fail(node.type);
    const n = node as Expression | Program;
    switch (n.type) {
      case 'Program':
        for (const s of n.body) visit(s, locals);
        return;
      case 'Identifier':
        if (!locals.has(n.name) && !bound.has(n.name) && !scope.has(n.name)) fail(`free identifier ${n.name}`);
        return;
      case 'Literal':
        if ('regex' in n && n.regex) fail('regex');
        if (typeof n.value === 'bigint') fail('bigint');
        return;
      case 'MemberExpression': {
        if (n.computed || n.property.type !== 'Identifier') return fail('computed member');
        const p = n.property.name;
        if (ALLOWLIST.denied.has(p) || !(ALLOWLIST.methods.has(p) || ALLOWLIST.operatorModes.has(p))) return fail(`member .${p}`);
        return visit(n.object, locals);
      }
      case 'ObjectExpression':
        for (const prop of n.properties) {
          if (prop.type !== 'Property' || prop.computed || prop.key.type !== 'Identifier' || !ALLOWLIST.controls.has(prop.key.name)) return fail('object key');
          visit(prop.value, locals);
        }
        return;
      case 'ArrowFunctionExpression': {
        const inner = new Set(locals);
        for (const p of n.params) {
          if (p.type !== 'Identifier') return fail('arrow parameter');
          inner.add(p.name);
        }
        if (n.body.type === 'BlockStatement') return fail('arrow block body');
        return visit(n.body, inner);
      }
      case 'BinaryExpression':
        if (!ARITHMETIC.has(n.operator)) return fail(`operator ${n.operator}`);
        visit(n.left as Node, locals);
        return visit(n.right, locals);
      case 'UnaryExpression':
        if (n.operator !== '-' && n.operator !== '+') return fail(`operator ${n.operator}`);
        return visit(n.argument, locals);
      default:
        break;
    }
    const any = node as unknown as Record<string, unknown>;
    if (node.type === 'VariableDeclaration') {
      if ((any.kind as string) !== 'const') return fail('non-const declaration');
      for (const d of any.declarations as { id: Node; init: Node | null }[]) {
        if (d.id.type !== 'Identifier') return fail('destructuring');
        visit(d.init, locals);
        bound.add((d.id as unknown as { name: string }).name);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      const c = node as Call;
      if (c.optional) return fail('optional call');
      visit(c.callee as Node, locals);
      for (const a of c.arguments) visit(a, locals);
      return;
    }
    for (const key of ['expression', 'argument', 'elements'] as const) {
      const child = any[key];
      if (Array.isArray(child)) for (const c of child) visit(c as Node, locals);
      else visit(child as Node | undefined, locals);
    }
  };
  visit(program, new Set());
  return problem;
}
