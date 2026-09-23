// The performer answers every part's query within the engine's query budget: a part whose query would
// build millions of haps is muted as a density problem within milliseconds, the others keep playing,
// and real music never trips it.
import { describe, expect, it, vi } from 'vitest';
import { Performer } from '../../src/client/engine/performer.ts';
import { buildScore } from '../../src/client/engine/score.ts';
import type { PartError } from '../../src/client/engine/types.ts';
import { LIBRARY } from '../../src/server/composer/library/index.ts';
import { fillScale } from '../../src/server/composer/library/scale.ts';
import { EMPTY_MIXER } from '../../src/shared/program.ts';
import { part, section } from './fixtures.ts';

// Code marked like this skips the validator, standing in for a pattern the static bound misses.
const UNVALIDATED = '// unvalidated\n';
vi.mock('../../src/strudel/validate.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/strudel/validate.ts')>();
  return {
    ...actual,
    validatePart: (code: string, opts: { knobs: string[] }) =>
      code.startsWith('// unvalidated') ? { ok: true, errors: [], warnings: [], knobsUsed: [] } : actual.validatePart(code, opts),
  };
});

function setup(parts: ReturnType<typeof part>[]) {
  const errors: PartError[] = [];
  const performer = new Performer({ mixer: () => EMPTY_MIXER, onError: (e) => errors.push(e) });
  const score = buildScore([section({ id: 's', startCycle: 0, parts })], new Map());
  performer.prepare([score]);
  return { performer, score, errors };
}

describe('the query budget in the performer', () => {
  it('mutes a part whose query blows up, within milliseconds, while the others keep playing', () => {
    const bomb = `${UNVALIDATED}s("bd").ply(16).ply(16).ply(16).ply(16).ply(16).struct("x")`;
    const { performer, score, errors } = setup([part({ id: 'k', role: 'kick', code: 's("sbd*4")' }), part({ id: 'b', role: 'perc', orbit: 2, code: bomb })]);
    const t0 = performance.now();
    const haps = performer.plan(score, 0, 0.025, { cps: 0.5, guard: true });
    expect(performance.now() - t0).toBeLessThan(500);
    expect(performer.isMuted('s:b')).toBe(true);
    expect(errors).toEqual([expect.objectContaining({ partId: 'b', code: 'density', message: expect.stringMatching(/query budget/) })]);
    expect(haps.map((h) => h.inst.part.id)).toEqual(['k']);
    expect(performer.plan(score, 0.25, 0.275, { cps: 0.5, guard: true }).map((h) => h.inst.part.id)).toEqual(['k']);
  });

  it('mutes it from a visual or preload query too', () => {
    const bomb = `${UNVALIDATED}s("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16).ply(16))).early(1023)`;
    const { performer, score, errors } = setup([part({ id: 'b', code: bomb })]);
    const t0 = performance.now();
    expect(performer.events(score, 0, 8, 0.5)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(errors).toEqual([expect.objectContaining({ partId: 'b', code: 'density' })]);
  });

  it('plays every autopilot template without tripping it', () => {
    const parts = LIBRARY.flatMap((ens) => ens.parts.map((p) => ({ ens, p })));
    const { performer, score, errors } = setup(
      parts.map(({ ens, p }, i) => part({ id: `p${i}`, role: p.role, orbit: i + 1, code: fillScale(p.code, `${ens.tonic}:${ens.modes[0]}`), knobs: p.knobs ?? [] })),
    );
    for (let a = 0; a < 1; a += 1 / 8) performer.plan(score, a, a + 1 / 8, { cps: 0.5, guard: true });
    performer.events(score, 0, 4, 0.5);
    expect(errors.filter((e) => e.code === 'density' || e.code === 'query' || e.code === 'eval')).toEqual([]);
  }, 60_000);
});
