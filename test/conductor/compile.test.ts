import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SectionCheck } from '../../src/shared/analysis.ts';
import { PlanSchema } from '../../src/shared/plan.ts';
import type { RoomSnapshot } from '../../src/shared/protocol.ts';
import type { SectionProgram } from '../../src/shared/program.ts';
import {
  assignOrbits,
  balanceTrims,
  carryPlan,
  checkInputFor,
  compileSection,
  continuingPatternBars,
  resolveSection,
  vampAllowed,
} from '../../src/server/conductor/compile.ts';
import { knobValuesAt, laneValue, levelAt } from '../../src/server/conductor/knobs.ts';
import { createFakeChecker, part, section } from './harness.ts';

const snapshot: RoomSnapshot = JSON.parse(readFileSync(new URL('../fixtures/snapshot.json', import.meta.url), 'utf8'));
const [first, second] = snapshot.sections as [SectionProgram, SectionProgram];

async function checkOf(input: ReturnType<typeof checkInputFor>): Promise<SectionCheck> {
  return createFakeChecker().checkSection(input);
}

describe('carried parts', () => {
  it('resolves code null to the previous code and knobs, and continues unless restarted', () => {
    const plan = section({
      parts: [
        part('bass', { code: null }),
        part('kick', { code: null, restart: true }),
        part('pad', { code: first.parts.find((p) => p.id === 'pad')!.code }),
        part('lead', { code: 's("square")' }),
      ],
    });
    const { parts, errors } = resolveSection(plan, first, 'sections[0]');
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(parts.map((p) => [p.id, p]));
    expect(byId.bass).toMatchObject({ code: first.parts[2]!.code, knobs: first.parts[2]!.knobs, carried: true, continues: true });
    expect(byId.kick).toMatchObject({ carried: true, continues: false });
    expect(byId.pad).toMatchObject({ carried: true, continues: false }); // identical code restated = restart
    expect(byId.lead).toMatchObject({ carried: false, continues: false });
  });

  it('restated knobs replace inherited ones by name', () => {
    const plan = section({ parts: [part('bass', { code: null, knobs: [{ name: 'cut', default: 1000, min: 200, max: 3000, follows: 'none' }] })] });
    const { parts } = resolveSection(plan, first, 'sections[0]');
    expect(parts[0]!.knobs).toEqual([{ name: 'cut', default: 1000, min: 200, max: 3000, follows: 'none' }]);
  });

  it('reports a carry of a part the previous section does not have', () => {
    const { errors } = resolveSection(section({ parts: [part('ghost', { code: null })] }), first, 'sections[1]');
    expect(errors[0]).toMatchObject({ rule: 'carry', path: 'sections[1].parts[0].code' });
    expect(errors[0]!.hint).toMatch(/kick, hats, bass, pad/);
  });

  it('gives continuing parts their pattern position for the checker', () => {
    const plan = section({ parts: [part('bass', { code: null }), part('lead', { code: 's("square")' })] });
    const { parts } = resolveSection(plan, first, 'sections[0]');
    const bars = continuingPatternBars(parts, first, 16);
    expect([...bars]).toEqual([['bass', 16]]);
    const input = checkInputFor(plan, parts, bars);
    expect(input.parts.map((p) => [p.id, p.patternBarAtStart])).toEqual([
      ['bass', 16],
      ['lead', 0],
    ]);
  });
});

describe('orbits', () => {
  it('matches the fixture: continuing parts keep theirs, others take the lowest unused by both sections', () => {
    const plan = section({
      parts: [part('kick', { code: null }), part('hats', { code: 's("white*16")' }), part('bass', { code: null }), part('lead', { code: 's("square")' }), part('fill', { code: 's("white")', enterBar: -1 })],
    });
    const { parts } = resolveSection(plan, first, 'sections[0]');
    const orbits = assignOrbits(parts, first);
    expect(Object.fromEntries(orbits)).toEqual(Object.fromEntries(second.parts.map((p) => [p.id, p.orbit])));
  });

  it('a rewritten same-id part never shares its orbit with the outgoing instance (crossfade)', () => {
    const plan = section({ transitionIn: { type: 'crossfade', bars: 4 }, parts: [part('pad', { code: 's("sawtooth")' }), part('kick', { code: null })] });
    const { parts } = resolveSection(plan, first, 'sections[0]');
    const orbits = assignOrbits(parts, first);
    expect(orbits.get('kick')).toBe(1);
    expect(orbits.get('pad')).not.toBe(4);
    expect(first.parts.map((p) => p.orbit)).not.toContain(orbits.get('pad'));
  });

  it('stays within 1..24 with eight parts on each side', () => {
    const prev = { ...first, parts: Array.from({ length: 8 }, (_, i) => ({ ...first.parts[0]!, id: `p${i}`, orbit: i + 1 })) };
    const plan = section({ parts: Array.from({ length: 8 }, (_, i) => part(`q${i}`, { code: 's("sine")' })) });
    const orbits = [...assignOrbits(resolveSection(plan, prev, 's').parts, prev).values()];
    expect(orbits).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
});

describe('compileSection', () => {
  it('compiles the fixture\'s second section: origins, flags, duck orbits, vamp, measured', async () => {
    const plan = section({
      bars: 32,
      transitionIn: { type: 'crossfade', bars: 2 },
      parts: [
        part('kick', { code: null, duck: { targets: ['bass'], depth: 0.5, releaseSec: 0.2 } }),
        part('hats', { code: 's("white*16")' }),
        part('bass', { code: null }),
        part('lead', { code: 's("square")', enterBar: 8 }),
      ],
    });
    const { parts } = resolveSection(plan, first, 'sections[0]');
    const check = await checkOf(checkInputFor(plan, parts, continuingPatternBars(parts, first, 16)));
    const { program } = compileSection({ id: 'x-0002', index: 2, track: 2, movementId: 'm', author: 'claude', startCycle: 16, plan, parts, provisional: true, prev: first, check });
    const byId = Object.fromEntries(program.parts.map((p) => [p.id, p]));
    expect(byId.kick).toMatchObject({ orbit: 1, originCycle: 0, continues: true, carried: true, duck: { orbits: [3], depth: 0.5, releaseSec: 0.2 } });
    expect(byId.bass).toMatchObject({ orbit: 3, originCycle: 0, continues: true, knobs: first.parts[2]!.knobs });
    expect(byId.hats).toMatchObject({ orbit: 5, originCycle: 16, continues: false, carried: false });
    expect(byId.lead).toMatchObject({ orbit: 6, originCycle: 16 });
    expect(program).toMatchObject({ provisional: true, vamp: { allowed: true, loopBars: 8 }, jumps: [], rev: 1, measured: check.mix!.spans });
  });

  it('a continuing part picks up where a vamping predecessor was', async () => {
    const plan = section({ parts: [part('bass', { code: null })] });
    const { parts } = resolveSection(plan, first, 's');
    // first (16 bars, loop 8) vamped until 20: pattern bar 12 → origin 20 − 12 = 8.
    const check = await checkOf(checkInputFor(plan, parts, continuingPatternBars(parts, first, 20)));
    const { program } = compileSection({ id: 'x', index: 2, track: 2, movementId: 'm', author: 'claude', startCycle: 20, plan, parts, provisional: false, prev: first, check });
    expect(program.parts[0]!.originCycle).toBe(8);
  });

  it('vamp is off for build/intro/outro/transition and when the held state is silent', () => {
    const p = resolveSection(section({ parts: [part('pad')] }), null, 's').parts;
    expect(vampAllowed('groove', 16, p, [])).toBe(true);
    for (const role of ['build', 'intro', 'outro', 'transition'] as const) expect(vampAllowed(role, 16, p, [])).toBe(false);
    const faded = resolveSection(section({ parts: [part('pad', { automation: [{ target: 'level', fromBar: 8, toBar: 16, from: 0.8, to: 0, curve: 'linear' }] })] }), null, 's').parts;
    expect(vampAllowed('groove', 16, faded, [])).toBe(false);
    const exited = resolveSection(section({ parts: [part('pad', { exitBar: 8 })] }), null, 's').parts;
    expect(vampAllowed('groove', 16, exited, [])).toBe(false);
  });

  it('trims toward role loudness targets only beyond ±4 dB, and only with measured levels', () => {
    const parts = [
      { id: 'kick', role: 'kick' as const, level: 1 },
      { id: 'pad', role: 'pad' as const, level: 1 },
      { id: 'lead', role: 'lead' as const, level: 0.5 },
    ];
    const check = (est: number | null) => ({ analysis: { loudness: { estRmsDb: est } } }) as never;
    // kick −4 dB (8 over −12 → trim −4); pad −21 (in band); lead −8 at level 0.5 ≈ −14 (in band)
    expect(balanceTrims(parts, [check(-4), check(-21), check(-8)])).toEqual({ kick: -4 });
    expect(balanceTrims(parts, [check(null), check(null), check(null)])).toEqual({});
    expect(balanceTrims([{ id: 'pad', role: 'pad', level: 1 }], [check(-40)])).toEqual({ pad: 3 });
  });

  it('the carry plan is a valid plan that continues every sounding part', () => {
    const p = carryPlan(second);
    expect(PlanSchema.safeParse(p).success).toBe(true);
    const s = p.sections[0]!;
    expect(s.parts.every((x) => x.code === null && !x.restart && x.enterBar === 0)).toBe(true);
    expect(s).toMatchObject({ bpm: 120, scale: 'D:dorian', transitionIn: { type: 'cut', bars: 0 } });
  });
});

describe('automation lanes', () => {
  const lanes = [
    { target: 'knob:cut', fromBar: 4, toBar: 8, from: 400, to: 1600, curve: 'exp' as const },
    { target: 'knob:cut', fromBar: 12, toBar: 16, from: 1600, to: 800, curve: 'linear' as const },
  ];
  it('holds the base before, interpolates within, holds between and after', () => {
    expect(laneValue(lanes, 0, 1000)).toBe(1000);
    expect(laneValue(lanes, 6, 1000)).toBeCloseTo(800, 6); // geometric midpoint of 400 → 1600
    expect(laneValue(lanes, 10, 1000)).toBe(1600);
    expect(laneValue(lanes, 14, 1000)).toBe(1200);
    expect(laneValue(lanes, 20, 1000)).toBe(800);
  });
  it('knob values at the end chain from inherited values and clamp to range', () => {
    const p = { knobs: [{ name: 'cut', default: 500, min: 300, max: 1200, follows: 'none' as const }, { name: 'q', default: 2, min: 0, max: 10, follows: 'none' as const }], automation: lanes };
    expect(knobValuesAt(p, 16, { q: 7 })).toEqual({ cut: 800, q: 7 });
    expect(knobValuesAt(p, 10, null)).toEqual({ cut: 1200, q: 2 });
  });
  it('level lanes are absolute', () => {
    expect(levelAt({ level: 0.7, automation: [{ target: 'level', fromBar: 0, toBar: 4, from: 0, to: 0.5, curve: 'linear' }] }, 2)).toBe(0.25);
  });
});
