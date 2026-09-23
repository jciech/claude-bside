// Carried knob values as one fact: the conductor checks a carried part at the values it compiles into
// the program (and the performer plays), in both sections of a plan, and the build rule reads them.
import { describe, expect, it } from 'vitest';
import type { Automation, Knob } from '../../src/shared/plan.ts';
import { createRoom, movement, part, plan, section, type Room } from './harness.ts';

const cut: Knob = { name: 'cut', default: 300, min: 200, max: 9000, follows: 'brightness' };
const sweep: Automation = { target: 'knob:cut', fromBar: 0, toBar: 16, from: 300, to: 8000, curve: 'exp' };
const hold: Automation = { target: 'knob:cut', fromBar: 8, toBar: 16, from: 8000, to: 8000, curve: 'exp' };
const lead = part('lead', { role: 'lead', code: 'note("d3 f3 a3 c4").s("sawtooth").lpf(knob("cut"))', knobs: [cut], automation: [sweep] });

async function sweptRoom(): Promise<Room> {
  const room = createRoom({ config: { driver: 'external' } as never });
  room.scripted.make = () => plan([section({ name: 'First Light', parts: [part('kick'), lead] })], { movement: movement() });
  await room.conductor.start();
  return room;
}

const knobsOf = (parts: readonly { id: string; knobs: Knob[] }[], id: string) => parts.find((p) => p.id === id)!.knobs;

describe('carried knob values in the room', () => {
  it('are checked as the program plays them: from where the section before left them', async () => {
    const room = await sweptRoom();
    const held = section({ name: 'Held', role: 'bridge', parts: [part('kick', { code: null }), part('lead', { role: 'lead', code: null, automation: [hold] })] });
    const r = await room.conductor.commit({ plan: plan([held]) }, 'external');
    expect(r.errors).toEqual([]);
    const program = room.conductor.snapshot().sections.at(-1)!;
    expect(knobsOf(program.parts, 'lead')).toEqual([{ ...cut, default: 8000 }]);
    expect(knobsOf(room.checker.calls.at(-1)!.parts, 'lead')).toEqual(knobsOf(program.parts, 'lead'));
  });

  it('reach the second section of a plan from where the first one ends', async () => {
    const room = await sweptRoom();
    const down: Automation = { target: 'knob:cut', fromBar: 0, toBar: 16, from: 8000, to: 1000, curve: 'linear' };
    const r = await room.conductor.commit(
      {
        plan: plan([
          section({ name: 'Down', role: 'bridge', parts: [part('kick', { code: null }), part('lead', { role: 'lead', code: null, automation: [down] })] }),
          section({ name: 'Under', role: 'interlude', parts: [part('lead', { role: 'lead', code: null })] }),
        ]),
      },
      'external',
    );
    expect(r.errors).toEqual([]);
    const [, first, second] = room.conductor.snapshot().sections;
    expect(knobsOf(first!.parts, 'lead')[0]!.default).toBe(8000);
    expect(knobsOf(second!.parts, 'lead')[0]!.default).toBe(1000);
    const inputs = room.checker.calls.slice(-2);
    expect(inputs.map((input) => knobsOf(input.parts, 'lead'))).toEqual([knobsOf(first!.parts, 'lead'), knobsOf(second!.parts, 'lead')]);
  });

  it('a build whose only sweep holds a carried knob where it already was does not rise', async () => {
    const room = await sweptRoom();
    const build = section({ name: 'Flat Build', role: 'build', parts: [part('kick', { code: null }), part('lead', { role: 'lead', code: null, automation: [hold] })] });
    const r = await room.conductor.commit({ plan: plan([build]) }, 'external');
    expect(r.accepted).toBe(false);
    expect(r.errors).toEqual([expect.objectContaining({ rule: 'dramaturgy', message: expect.stringMatching(/A build must measure .* automation \+0\)/) })]);
  });
});
