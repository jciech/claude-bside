import * as core from '@strudel/core';
import { describe, expect, it } from 'vitest';
import { createVmEvaluator } from '../../src/server/check/vm-evaluator.ts';
import { ALLOWLIST } from '../../src/strudel/allowlist.ts';
import { CompileError, allowedScope, compilePart } from '../../src/strudel/compile.ts';

type Hap = { value: Record<string, unknown>; context: { locations?: { start: number; end: number }[] }; hasOnset(): boolean };
const onsets = (pattern: any, from = 0, to = 1): Hap[] => (pattern.queryArc(from, to) as Hap[]).filter((h) => h.hasOnset());

describe('knob binding', () => {
  const binders = {
    pure: (value: number) => core.pure(value),
    signal: (value: number) => core.signal(() => value),
  };
  for (const [kind, bind] of Object.entries(binders)) {
    it(`knob("x") and knob('x') both set the control (${kind} binder)`, () => {
      for (const code of ['s("hh*4").lpf(knob("cut"))', "s(\"hh*4\").lpf(knob('cut'))"]) {
        const names: string[] = [];
        const { pattern } = compilePart(code, {
          knob: (name) => {
            names.push(name);
            return bind(800);
          },
        });
        expect(names).toEqual(['cut']);
        expect(onsets(pattern).map((h) => h.value.cutoff)).toEqual([800, 800, 800, 800]);
      }
    });
  }

  it('samples an engine-style knob at each hap, so automation is deterministic', () => {
    const { pattern } = compilePart('note("c3*4").s("sine").gain(knob("level"))', { knob: () => core.signal((t: number) => Number(t) / 10) });
    expect(onsets(pattern, 4, 5).map((h) => h.value.gain)).toEqual([0.4, 0.425, 0.45, 0.475]); // sampled at each onset
  });
});

describe('mini-notation locations', () => {
  const code = 'n("0 [2 4]")\n  .s("sawtooth")';
  const { pattern, miniLocations } = compilePart(code, { knob: () => null });

  it('returns source offsets for every mini atom', () => {
    expect(miniLocations.map(({ start, end }) => code.slice(start, end))).toEqual(['0', '2', '4', 'sawtooth']);
  });

  it('tags haps with the locations of the atoms that produced them', () => {
    const haps = onsets(pattern);
    expect(haps.map((h) => h.context.locations!.map(({ start, end }) => code.slice(start, end)).sort())).toEqual([
      ['0', 'sawtooth'],
      ['2', 'sawtooth'],
      ['4', 'sawtooth'],
    ]);
  });
});

describe('scope', () => {
  it('is exactly the allowlisted values plus m', () => {
    const scope = allowedScope();
    const expected = new Set([...ALLOWLIST.globals].filter((n) => n !== 'knob'));
    expected.add('m');
    expect(new Set(Object.keys(scope))).toEqual(expected);
    for (const [name, value] of Object.entries(scope)) {
      expect(value, name).toBeDefined();
      expect(ALLOWLIST.denied.has(name) && name !== 'm', name).toBe(false);
    }
  });

  it('passes the scope as parameters and never installs globals', () => {
    let seen: string[] = [];
    compilePart('s("bd")', {
      knob: () => null,
      evaluator: (source, names, values) => {
        seen = names;
        return new Function(...names, `"use strict";\n${source}`)(...values);
      },
    });
    expect(seen).toContain('m');
    expect(seen).toContain('knob');
    expect(seen).not.toContain('fetch');
    expect((globalThis as Record<string, unknown>).s).toBeUndefined();
    expect((globalThis as Record<string, unknown>).m).toBeUndefined();
  });
});

describe('the vm evaluator', () => {
  const evaluator = createVmEvaluator();

  it('evaluates parts to the same events as new Function', () => {
    const code = 'n("0 2 4 <[6,8] [7,9]>").scale("C4:minor").s("sawtooth").off(1/8, x => x.transpose(12))';
    const a = compilePart(code, { knob: () => null }).pattern;
    const b = compilePart(code, { knob: () => null, evaluator }).pattern;
    const values = (p: any) => onsets(p, 0, 2).map((h) => JSON.stringify(h.value));
    expect(values(b)).toEqual(values(a));
  });

  it('has no ambient globals and cannot generate code from strings', () => {
    expect(evaluator('return [typeof process, typeof fetch, typeof require];', [], [])).toEqual(['undefined', 'undefined', 'undefined']);
    expect(() => evaluator('return Function("return 1")();', [], [])).toThrow(/Code generation from strings disallowed/);
    expect(() => evaluator('return eval("1");', [], [])).toThrow(/Code generation from strings disallowed/);
  });

  it('times out runaway construction', () => {
    const slow = createVmEvaluator(20);
    expect(() => slow('while (true) {}', [], [])).toThrow(/timed out/);
  });
});

describe('errors', () => {
  const compileError = (code: string) => {
    try {
      compilePart(code, { knob: () => null });
    } catch (e) {
      if (e instanceof CompileError) return e.issue;
      throw e;
    }
    throw new Error('expected a CompileError');
  };

  it('re-checks the transpiled program even when validation was skipped', () => {
    expect(compileError("fetch('https://evil.example')")).toMatchObject({ rule: 'denied', message: expect.stringMatching(/free identifier fetch/) });
    expect(compileError('s("bd").worklet("x")')).toMatchObject({ rule: 'denied', message: expect.stringMatching(/member \.worklet/) });
  });

  it('explains values that are not patterns and runtime failures', () => {
    expect(compileError('1 + 2')).toMatchObject({ rule: 'not-pattern' });
    expect(compileError('s("bd").echo(0.5)')).toMatchObject({ rule: 'runtime', hint: expect.stringMatching(/\.delay\(0\.3\)/) });
    expect(compileError('s("bd").euclid(9, 8)')).toMatchObject({ rule: 'runtime', hint: expect.stringMatching(/pulses ≤ steps/) });
  });
});
