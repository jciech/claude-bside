import { describe, expect, it } from 'vitest';
import { checkTranspiled, validatePart } from '../../src/strudel/validate.ts';
import { checkMini } from '../../src/strudel/mini.ts';
import { STATIC_EVENTS_CEILING } from '../../src/strudel/density.ts';
import { LEGIT, MALICIOUS } from './corpus.ts';

const KNOBS = { knobs: ['cut'] };

describe('validatePart security corpus', () => {
  it.each(MALICIOUS)('rejects %j (%s: %s)', (code, rule) => {
    const v = validatePart(code, KNOBS);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.rule)).toContain(rule);
  });

  it.each(LEGIT.map((c) => [c]))('accepts %j', (code) => {
    const v = validatePart(code, KNOBS);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('covers at least the prototype corpus sizes', () => {
    expect(MALICIOUS.length).toBeGreaterThanOrEqual(78 + 40);
    expect(LEGIT.length).toBeGreaterThanOrEqual(34);
  });
});

describe('issues are phrased for self-repair', () => {
  it('suggests the Strudel name for common hallucinations', () => {
    const v = validatePart('s("bd")\n  .reverb(0.5)', KNOBS);
    expect(v.errors).toHaveLength(1);
    const [e] = v.errors;
    expect(e).toMatchObject({ rule: 'unknown-method', line: 2, column: 4 });
    expect(e!.hint).toMatch(/^Did you mean \.room\(\)/);
    expect(e!.excerpt).toBe('  .reverb(0.5)\n   ^');
    expect(validatePart('s("bd").lowpass(800)', KNOBS).errors[0]!.hint).toMatch(/\.lpf\(\)/);
    expect(validatePart('s("bd").volume(0.5)', KNOBS).errors[0]!.hint).toMatch(/\.gain\(\)/);
    expect(validatePart('s("bd").reverse()', KNOBS).errors[0]!.hint).toMatch(/\.rev\(\)/);
  });

  it('points mini-notation errors at the offending character', () => {
    const v = validatePart('stack(\n  s("bd [sd"),\n  s("hh")\n)', KNOBS);
    expect(v.errors[0]).toMatchObject({ rule: 'mini', line: 2 });
    expect(v.errors[0]!.message).toMatch(/missing closing \]/);
    const pipe = validatePart('note("<c3|e3 g3>")', KNOBS).errors[0]!;
    expect(pipe).toMatchObject({ rule: 'mini', column: 10 });
    expect(pipe.hint).toMatch(/\[c3\|e3\]/);
  });

  it('explains labels, tempo and routing', () => {
    expect(validatePart('Snare: s("sd")', KNOBS).errors[0]!.message).toMatch(/one expression/);
    expect(validatePart('s("bd").fast(setcps(1))', KNOBS).errors.find((e) => e.rule === 'denied')!.hint).toMatch(/bpm/);
    expect(validatePart('s("bd").orbit(2)', KNOBS).errors[0]!.hint).toMatch(/duck field/);
  });

  it('names the multipliers when the static density bound is exceeded', () => {
    const v = validatePart('s("hh*16").lastOf(100, x => x.ply(16).ply(16))', KNOBS);
    const e = v.errors.find((x) => x.rule === 'density')!;
    expect(e.message).toContain(String(16 * 16 * 16));
    expect(e.message).toContain(String(STATIC_EVENTS_CEILING));
    expect(e.hint).toMatch(/ply\(16\) ×16/);
  });

  it('asks for constants in density arguments', () => {
    const e = validatePart('s("hh*8").fast("<1 2>")', KNOBS).errors[0]!;
    expect(e).toMatchObject({ rule: 'density', column: 16 });
    expect(e.hint).toMatch(/every\(4/);
    expect(validatePart('s("hh*8").fast(32)', KNOBS).errors[0]!.message).toMatch(/between 0 and 16/);
    expect(validatePart('s("hh*8").fast(2 * 4)', KNOBS).ok).toBe(true);
    expect(validatePart('s("hh*8").fast(4 * 8)', KNOBS).ok).toBe(false);
    expect(validatePart('s("bd").euclid(9, 8)', KNOBS).errors[0]!.message).toMatch(/pulses must not exceed steps/);
  });

  it('hints double quotes for single-quoted mini-notation', () => {
    const e = validatePart("n('0 2 4').s('sine')", KNOBS).errors[0]!;
    expect(e.rule).toBe('quotes');
    expect(e.hint).toBe('Use double quotes: "0 2 4".');
    expect(validatePart("s('bd').bank('RolandTR909').scale('C:minor')", KNOBS).ok).toBe(true);
  });

  it('keeps constants from hiding Strudel functions but lets arrow parameters shadow', () => {
    expect(validatePart('const s2 = s("bd")\ns2.fast(2)', KNOBS).ok).toBe(true);
    const e = validatePart('const note = s("bd")\nnote', KNOBS).errors[0]!;
    expect(e.message).toMatch(/hides the Strudel function note/);
    expect(validatePart('s("bd").every(2, n => n.fast(2))', KNOBS).ok).toBe(true);
  });

  it('warns about constants the pattern never uses', () => {
    const v = validatePart('const spare = s("hh*8")\ns("bd*4")', KNOBS);
    expect(v.ok).toBe(true);
    expect(v.warnings).toEqual([expect.objectContaining({ rule: 'unused', severity: 'warning', line: 1, column: 15 })]);
  });

  it('rejects empty, oversized and statement-only code', () => {
    expect(validatePart('', KNOBS).errors[0]!.rule).toBe('syntax');
    expect(validatePart('const a = s("bd")', KNOBS).errors[0]!.message).toMatch(/must end with a pattern/);
    expect(validatePart('s("bd")\ns("sd")', KNOBS).errors[0]!.message).toMatch(/Only one pattern expression/);
    expect(validatePart('s("bd"', KNOBS).errors[0]).toMatchObject({ rule: 'syntax', line: 1 });
  });
});

describe('knobs', () => {
  it('reports which declared knobs the code reads', () => {
    const v = validatePart('s("bd").lpf(knob("cut")).gain(knob(\'amt\')).room(knob("cut"))', { knobs: ['cut', 'amt', 'spare'] });
    expect(v.ok).toBe(true);
    expect(v.knobsUsed).toEqual(['cut', 'amt']);
  });

  it('lists the declared knobs when one is missing', () => {
    const e = validatePart('s("bd").lpf(knob("cutt"))', { knobs: ['cut'] }).errors[0]!;
    expect(e.rule).toBe('knob-undeclared');
    expect(e.hint).toMatch(/Declared knobs: cut \(did you mean "cut"\?\)/);
    expect(validatePart('s("bd").lpf(knob("cut"))', { knobs: [] }).errors[0]!.hint).toMatch(/Add \{name: "cut"/);
  });
});

describe('mini-notation bounds', () => {
  it('computes worst-case events per bar', () => {
    const events = (s: string) => {
      const m = checkMini(s);
      if (!m.ok) throw new Error(m.message);
      return m.events;
    };
    expect(events('bd*4')).toBe(4);
    expect(events('bd sd [~ bd] sd')).toBe(4);
    expect(events('<bd [sd sd] [hh*8]>')).toBe(8);
    expect(events('<a!3 b>')).toBe(1);
    expect(events('{a b c}%4')).toBe(4);
    expect(events('bd(3,8), hh*8')).toBe(11);
    expect(events('0 .. 7')).toBe(8);
    expect(events('[a|b*4|c]')).toBe(4);
    expect(events('~ ~')).toBe(0);
  });

  it('knows single-number strings are constants', () => {
    expect(checkMini('2')).toMatchObject({ ok: true, constant: 2 });
    expect(checkMini('<1 2>')).toMatchObject({ ok: true, constant: null });
  });
});

describe('post-transpile invariant', () => {
  const scope = new Set(['s', 'm', 'knob', 'stack']);
  it('accepts what the transpiler produces from validated code', () => {
    expect(checkTranspiled("const a = s(m('bd', 2));\nreturn stack(a, s(m('sd', 20)).fast(2));", scope)).toBeNull();
  });
  it.each([
    ["return fetch('x');", 'free identifier fetch'],
    ["return s(m('bd', 2))['constructor'];", 'computed member'],
    ["return s(m('bd', 2)).constructor;", 'member .constructor'],
    ["return s(m('bd', 2)).worklet('x');", 'member .worklet'],
    ['let a = 1; return a;', 'non-const declaration'],
    ['x = 1; return s(1);', 'AssignmentExpression'],
    ["return s({ workletSrc: 'x' });", 'object key'],
    ['return new s();', 'NewExpression'],
    ['return `x`;', 'TemplateLiteral'],
    ["return s(m('bd', 2)).p('x');", 'member .p'],
  ])('rejects %j', (output, problem) => {
    expect(checkTranspiled(output, scope)).toBe(problem);
  });
});

describe('performance', () => {
  it('validates a typical part in about a millisecond', () => {
    const code = LEGIT[10]!;
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) validatePart(code, KNOBS);
    expect((performance.now() - t0) / 200).toBeLessThan(5);
  });
});
