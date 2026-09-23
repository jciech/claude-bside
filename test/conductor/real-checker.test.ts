// The conductor against the real checker (worker threads running Strudel): real validation errors
// reach the composer at plan paths, and accepted programs carry real measurements.
import { afterAll, describe, expect, it } from 'vitest';
import { createChecker } from '../../src/server/check/checker.ts';
import type { Checker } from '../../src/server/types.ts';
import { STORE_KEYS } from '../../src/server/types.ts';
import { catalog, createRoom, movement, part, plan, section } from './harness.ts';

const kick = part('kick', { role: 'kick', code: 's("sbd*4").decay(0.3).gain(0.9)', level: 0.9 });
const bass = part('bass', {
  role: 'bass',
  code: 'n("<0 3 5 2>").scale("D2:dorian").s("sawtooth").lpf(knob("cut")).decay(0.2).sustain(0.3).gain(0.6)',
  knobs: [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' }],
  level: 0.7,
});
const pad = part('pad', { role: 'pad', code: 'n("<[0,2,4] [3,5,7]>").scale("D3:dorian").s("triangle").attack(0.5).release(1).gain(0.35)', level: 0.5 });

describe('with the real checker', () => {
  let checker: Checker;
  afterAll(() => checker?.close());

  it('boots, rejects broken code with repair hints, and compiles real measurements into programs', async () => {
    checker = createChecker({ catalog, poolSize: 2 });
    const room = createRoom({ checker, config: { driver: 'external' } as never });
    room.scripted.make = () => plan([section({ name: 'First Light', role: 'groove', parts: [kick, pad] })], { movement: movement({ name: 'Harbour', blurb: 'Synth-only.' }) });
    await room.conductor.start();
    const boot = room.conductor.snapshot().sections[0]!;
    expect(boot.parts.map((p) => p.instrument)).toEqual(['Synth kick', 'Triangle']);
    expect(boot.parts.every((p) => p.digest !== null)).toBe(true);
    expect(boot.measured.intensity.start).toBeGreaterThan(0);

    const broken = await room.conductor.commit({ plan: plan([section({ role: 'bridge', parts: [part('pad', { code: 's("triangle").reverb(0.4)' })] })]) }, 'external');
    expect(broken.accepted).toBe(false);
    expect(broken.errors[0]).toMatchObject({ rule: 'unknown-method', path: 'sections[0].parts[0] (pad)', hint: expect.stringMatching(/room/) });

    const next = await room.conductor.commit(
      { plan: plan([section({ name: 'Glass Harbour', role: 'bridge', parts: [part('kick', { role: 'kick', code: null }), bass, part('pad', { role: 'pad', code: null })] })]) },
      'external',
    );
    expect(next.errors).toEqual([]);
    expect(next.accepted).toBe(true);
    const program = room.conductor.snapshot().sections.at(-1)!;
    const byId = Object.fromEntries(program.parts.map((p) => [p.id, p]));
    expect(byId.kick).toMatchObject({ continues: true, carried: true, orbit: boot.parts[0]!.orbit, originCycle: boot.startCycle });
    expect(byId.bass).toMatchObject({ continues: false, originCycle: program.startCycle, instrument: 'Sawtooth', digest: { register: 'bass', keyFit: 1 } });
    expect(boot.parts.map((p) => p.orbit)).not.toContain(byId.bass!.orbit);
    await room.clock.toCycle(program.startCycle);
    const rows = room.store.readJsonl<{ t: string; row?: { sectionId: string; sounds: { id: string }[] } }>(STORE_KEYS.ledger).filter((e) => e.t === 'row');
    expect(rows.map((r) => r.row!.sectionId)).toEqual([boot.id, program.id]);
    expect(rows[1]!.row!.sounds.map((s) => s.id).sort()).toEqual(['sawtooth', 'sbd', 'triangle']);
  }, 30_000);
});
