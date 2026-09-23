import { parse, type Node, type Program } from 'acorn';
import { describe, expect, it } from 'vitest';
import { checkTranspiled, validatePart } from '../../src/strudel/validate.ts';
import { compilePart } from '../../src/strudel/compile.ts';
import { checkMini } from '../../src/strudel/mini.ts';
import { cycleState } from '../../src/strudel/query.ts';
import { STATIC_EVENTS_CEILING, densityBound } from '../../src/strudel/density.ts';
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

describe('density bombs: every argument that multiplies events or work is bounded', () => {
  const K = { knobs: ['k'] };
  const stacked = (n: number) => `"[${Array.from({ length: n }, () => '1').join(',')}]"`;
  it.each([
    ['s("hh").inside(1000, x => x.segment(16))', /factor of \.inside\(\) is 1000; it must be between 1\/16 and 16/],
    ['s("hh").outside(0.001, x => x.segment(16))', /factor of \.outside\(\) is 0\.001/],
    ['s("hh").inside(knob("k"), x => x.segment(16))', /factor of \.inside\(\) must be a constant number/],
    ['s("hh").inside(knob("k").mul(knob("k").sub(2)).mul(-100000).add(1), x => x.segment(16))', /must be a constant number/],
    ['s("hh").inside(1e6*1e6, x => x.segment(16))', /1e6\*1e6 is 1000000000000, out of range/],
    ['s("hh").lastOf(64, x => x.inside(1e6, y => y.segment(16)))', /factor of \.inside\(\) is 1000000/],
    ['s("hh").inside(1000, x => stack(x, s("hh*16")))', /factor of \.inside\(\)/],
    ['s("hh").swing(1e6)', /slices of \.swing\(\) is 1000000/],
    ['s("hh").swingBy(1/3, 1e6)', /slices of \.swingBy\(\)/],
    ['s("hh").swing(knob("k"))', /slices of \.swing\(\) must be a constant/],
    ['s("hh*8").shuffle(20000)', /parts of \.shuffle\(\) is 20000/],
    ['s("hh*8").scramble(20000)', /parts of \.scramble\(\) is 20000/],
    ['s("hh*8").chunk(1000, x => x.hurry(2))', /count of \.chunk\(\) is 1000/],
    ['s("hh*8").chunkInto(knob("k"), x => x.hurry(2))', /count of \.chunkInto\(\) must be a constant/],
    ['s("hh").lastOf(knob("k"), x => x.fast(2))', /cycle count of \.lastOf\(\) must be a constant/],
    ['s("hh").every(pure(1e6).mul(1000), x => x.fast(2))', /cycle count of \.every\(\) must be a constant/],
    ['n("0 2").scale("C:major").scaleTranspose(knob("k"))', /offset of \.scaleTranspose\(\) must be a number/],
    ['n("0 2").scale("C:major").strans("<0 1e300>")', /offset of \.strans\(\) reaches/],
    ['n("0 2").scale("C:major").scaleTrans("<0 2>".mul(1e6))', /offset of \.scaleTrans\(\) must be a number/],
    ['s("sawtooth").partials(randL(1000000))', /length of randL\(\) is 1000000/],
    [`s("hh*16").gain(${stacked(16)}).pan(${stacked(16)})`, /up to 4640 events in a single bar/],
    [`s("hh*16").gain(${stacked(16)}).every(2, x => x.pan(${stacked(16)}))`, /up to 8720 events/],
    ['s("hh*16").bite(4, "0*16".fast(16))', /up to 4096 events/],
    ['n("[0,4,7]").s("sine").every(2, x => x.struct("[x,x,x,x]*16")).every(2, x => x.struct("[x,x,x,x]*16"))', /could produce up to/],
    ['s("hh*16").late("[0,0.01,0.02,0.03]").late("[0,0.01,0.02,0.03]").late("[0,0.01,0.02,0.03]").late("[0,0.01,0.02,0.03]")', /up to 12736 events/],
  ])('rejects %j', (code, message) => {
    const v = validatePart(code, K);
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => e.message).join('\n')).toMatch(message);
  });

  it('still accepts the idioms that use them', () => {
    for (const code of [
      's("hh*8").inside(2, x => x.rev())',
      'n("0 1 2 3").scale("C:major").s("sine").outside(2, rev)',
      's("hh*8").swingBy(1/3, 4)',
      's("hh*8").swing(4)',
      'n("0 1 2 3 4 5 6 7").scale("C:minor").s("sine").shuffle(8)',
      's("hh*8").scramble(4)',
      's("bd sd:2 [~ bd] sd").chunk(4, x => x.hurry(2))',
      's("hh*8").lastOf(64, x => x.ply(2))',
      'n("0 [2,4]").scale("C:major").scaleTranspose("<0 -1 2>").s("sine")',
      'chord("<Am7 Dm7>").voicing().s("piano").struct("x ~ x x")',
      'chord("<C Am F G>").voicing().s("piano").arp("0 1 2 3 2 1 0 2").fast(2)',
      'note("c e g").s("piano").add("[0,12]")',
    ]) {
      expect(validatePart(code, K).errors, code).toEqual([]);
    }
  });

  it('never under-estimates what an accepted part plays', () => {
    const codes = [
      `s("hh*16").gain(${stacked(16)})`,
      's("hh*16").late("[0,0.001,0.002,0.003]")',
      's("bd").inside(4, x => x.segment(16))',
      's("hh").outside(1/8, x => stack(x, s("hh*8")))',
      'n("[0,4,7]").s("sine").struct("x*16")',
      'n("[0,4,7]").s("sine").every(2, x => x.struct("x*16"))',
      'n("[0,2,4,6,8,10,12,14]").s("hh").arp("0*16")',
      'chord("<Am7 Dm7>").voicing().s("piano").struct("x*16")',
      '"<0 1>".pick([s("hh*16"), s("[bd,sd]*8")])',
      's("[hh*16] ~ ~ ~").scramble(4)',
      's("bd*4").every(2, x => x.gain("[1,1,1,1]"))',
      's("bd*4").off(0.125, x => x.add(n("[0,7]")))',
      'n("0 [2,4]").s("sine").echoWith(4, 0.125, x => x.add(n("[0,12]")))',
      'n("0 2").s("sine").every(2, struct("[x,x]*8"))',
      'note("c e g").s("piano").add.out("[0,12]*8")',
      'note("[c,e] g").s("piano").add.mix("[0,12] 7")',
      's("hh*8").bite(4, "0 [1,2] 3 0*2")',
      's("hh*4").superimpose(x => x.add(n("[0,12]")), x => x.late(0.125))',
      'n("0 [2,4]").s("sine").plyWith(4, x => x.add(n("[0,7]")))',
      's("bd*2").pickF("<0 1>", [x => x.ply(4), x => x.struct("[x,x]*4")])',
      'const stab = x => x.struct("[x,x] ~ x x")\nn("[0,4]").s("sine").every(2, stab)',
    ];
    for (const code of codes) {
      const v = validatePart(code, K);
      expect(v.errors, code).toEqual([]);
      const program = parse(code, { ecmaVersion: 2022 }) as unknown as Program;
      const declarations = program.body.slice(0, -1).flatMap((s) => (s.type === 'VariableDeclaration' ? s.declarations.map((d) => ({ name: (d.id as { name: string }).name, init: d.init! })) : []));
      const last = program.body[program.body.length - 1]!;
      const bound = densityBound(declarations, (last as { expression: Node }).expression).events;
      const { pattern } = compilePart(code, { knob: () => 1 });
      for (let bar = 0; bar < 32; bar++) {
        const onsets = (pattern.query(cycleState(bar, bar + 1, { _cps: 0.5 })) as { hasOnset(): boolean }[]).filter((h) => h.hasOnset()).length;
        expect(onsets, `${code} in bar ${bar}`).toBeLessThanOrEqual(bound);
      }
    }
  });
});

describe('numbers', () => {
  it('bounds arithmetic on numbers like literals', () => {
    expect(validatePart('s("bd").late(1e6*1e6)', KNOBS).errors[0]).toMatchObject({ rule: 'number', message: '1e6*1e6 is 1000000000000, out of range (±1000000).' });
    expect(validatePart('s("bd").late(1/0)', KNOBS).errors[0]!.message).toMatch(/1\/0 is Infinity/);
    expect(validatePart('s("bd").late(1e6/4 * 2)', KNOBS).ok).toBe(true);
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
    // In <…> a replicated or weighted step lasts more cycles; it does not play more per cycle.
    expect(events('<C:minor!32 F:minor!32>')).toBe(1);
    expect(events('<a!24 [b c]!8>')).toBe(2);
    expect(events('<a@32 b@32>')).toBe(1);
    expect(checkMini('<C:minor!32 F:minor!32>')).toMatchObject({ ok: true, problems: [] });
    expect(checkMini('<C:minor@32 F:minor@32>')).toMatchObject({ ok: true, problems: [] });
    expect(checkMini('a!32')).toMatchObject({ ok: true, problems: [expect.objectContaining({ message: '"!" count 32 is outside 0…16' })] });
  });

  it('computes the longest event in cycles', () => {
    const span = (s: string) => {
      const m = checkMini(s);
      if (!m.ok) throw new Error(m.message);
      return m.span;
    };
    expect(span('a')).toBe(1);
    expect(span('a b')).toBe(0.5);
    expect(span('bd*4')).toBe(0.25);
    expect(span('a@3 b')).toBe(0.75);
    expect(span('a/4')).toBe(4);
    expect(span('[a b]/2')).toBe(1);
    expect(span('<a@3 b>')).toBe(3);
    expect(span('<a!3 b>')).toBe(1);
    expect(span('<a b>/2')).toBe(2);
    expect(span('a*0.001')).toBe(1000);
    expect(span('a/<2 1000>')).toBe(1000);
    expect(span('{a b c}%2')).toBe(0.5);
    expect(span('~')).toBe(0);
  });

  it('computes how many events can sound at once, and list lengths', () => {
    const of = (s: string) => {
      const m = checkMini(s);
      if (!m.ok) throw new Error(m.message);
      return [m.polyphony, m.listLength];
    };
    expect(of('0.8 0.5 0.7 0.6')).toEqual([1, 1]);
    expect(of('[1,1,1] 0')).toEqual([3, 1]);
    expect(of('<[c,e,g] [d,f]>, c2')).toEqual([4, 1]);
    expect(of('{a b, c d e}%4')).toEqual([2, 1]);
    expect(of('[a|[b,c]]*4')).toEqual([2, 1]);
    expect(of('1:0:1:0 1:1')).toEqual([1, 4]);
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

  it('bounds functions repeated inside repeated functions without re-applying them endlessly', () => {
    const nested = 's("hh")' + Array.from({ length: 12 }, (_, i) => `.echoWith(16, 0.1, a${i} => a${i}`).join('') + '.add(n("[0,1]"))' + ')'.repeat(12);
    const chain = ['const f0 = x => x.rev()', ...Array.from({ length: 7 }, (_, i) => `const f${i + 1} = x => x${`.every(2, f${i})`.repeat(10)}`), 's("hh").every(2, f7)'].join('\n');
    for (const code of [nested, chain]) {
      const t0 = performance.now();
      const v = validatePart(code, KNOBS);
      expect(performance.now() - t0).toBeLessThan(500);
      expect(v.errors.map((e) => e.rule)).toContain('density');
    }
  });
});
