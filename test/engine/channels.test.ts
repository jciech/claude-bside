import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudioContext, fakeSuperdoughController, stubAudioGlobals, type FakeGainNode } from './fake-audio.ts';

const env = vi.hoisted(() => ({ controller: null as unknown }));
vi.mock('superdough', () => ({ getSuperdoughAudioController: () => env.controller }));

const { ChannelBank } = await import('../../src/client/engine/channels.ts');
const { buildScore } = await import('../../src/client/engine/score.ts');
const { EMPTY_MIXER } = await import('../../src/shared/program.ts');
const { part, section } = await import('./fixtures.ts');
type Score = ReturnType<typeof buildScore>;

/** 120 BPM: a bar is 2 s of audio time; the loop plans like Engine.loop (every 50 ms, 0.4 s ahead). */
const BAR_SEC = 2;
function rig(scoreAt: (cycle: number) => Score) {
  const clock = { t: 0 };
  const ac = new FakeAudioContext(() => clock.t);
  const controller = fakeSuperdoughController(() => ac);
  env.controller = controller;
  const bank = new ChannelBank(ac as unknown as AudioContext, ac.destination as unknown as AudioNode);
  const ctx = { scoreAt, mixer: () => EMPTY_MIXER, audioTimeAt: (c: number) => c * BAR_SEC };
  const tick = () => bank.plan(clock.t / BAR_SEC, (clock.t + 0.4) / BAR_SEC, ctx);
  const runTo = (cycle: number) => {
    while (clock.t < cycle * BAR_SEC - 1e-9) {
      clock.t = Math.min(cycle * BAR_SEC, clock.t + 0.05);
      tick();
    }
  };
  /** The channel's nodes in routing order: orbit output → low-pass → high-pass → gain → mute. */
  const nodes = (orbit: number) => {
    const lowpass = controller.getOrbit(orbit).output.outputs[0]!;
    const gain = lowpass.outputs[0]!.outputs[0] as FakeGainNode;
    return { gain: gain.gain, mute: (gain.outputs[0] as FakeGainNode).gain };
  };
  return { clock, bank, runTo, nodes };
}

beforeEach(() => stubAudioGlobals());
afterEach(() => vi.unstubAllGlobals());

describe('a late schedule change (re-plan beyond the planned horizon)', () => {
  const lead = (code: string) =>
    section({ id: 's', startCycle: 0, parts: [part({ id: 'lead', orbit: 1, code, automation: [{ target: 'level', fromBar: 0, toBar: 8, from: 0, to: 1, curve: 'linear' }] })] });
  const before = buildScore([lead('note("c4")')], new Map());
  const after = buildScore([{ ...lead('note("d4")'), rev: 2 }], new Map());

  it('keeps the old curves running up to the switch bar, then carries on without a step', () => {
    let switchAt = Infinity;
    const { bank, runTo, nodes } = rig((c) => (c >= switchAt ? after : before));
    bank.ensure(1);
    runTo(2.48);
    const g = nodes(1).gain;
    const planned = g.log.length;
    // Engine.rebuild: handed ≈ 2.625, so the change applies from bar 3.
    switchAt = 3;
    bank.replanFrom(3);
    runTo(3.3);
    for (const c of [2.75, 2.9, 2.99, 3.01, 3.2]) expect(g.valueAt(c * BAR_SEC), `cycle ${c}`).toBeCloseTo(c / 8, 2);
    expect(g.log.slice(planned).filter((e) => e.kind !== 'lin')).toEqual([]);
  });

  it('still replaces what was already planned past the change', () => {
    let switchAt = Infinity;
    const quiet = buildScore([{ ...lead('note("d4")'), rev: 2, parts: [{ ...lead('').parts[0]!, code: 'note("d4")', automation: [], level: 0.2 }] }], new Map());
    const { bank, runTo, nodes } = rig((c) => (c >= switchAt ? quiet : before));
    bank.ensure(1);
    runTo(2.48);
    switchAt = 2.625;
    bank.replanFrom(2.625);
    runTo(3);
    const g = nodes(1).gain;
    expect(g.valueAt(2.62 * BAR_SEC)).toBeCloseTo(2.62 / 8, 2);
    expect(g.valueAt(2.7 * BAR_SEC)).toBeCloseTo(0.2);
  });
});

describe('the personal mix on the audio timeline', () => {
  // A muted part enters on a fresh orbit at bar 4, where an unmuted one enters on the orbit a muted part left.
  const s1 = section({ id: 'a', startCycle: 0, parts: [part({ id: 'lead', orbit: 1 }), part({ id: 'pad', role: 'pad', orbit: 3 })] });
  const s2 = section({ id: 'b', startCycle: 4, parts: [part({ id: 'lead', orbit: 2, code: 'note("e4")' }), part({ id: 'keys', role: 'chords', orbit: 1 })] });
  const score = buildScore([s1, s2], new Map());

  it('mutes a muted part from the audio time of its first note, and unmutes an entering part on time', () => {
    const { bank, runTo, nodes } = rig(() => score);
    for (const o of [1, 2, 3]) bank.ensure(o);
    bank.setMuted(new Set(['lead']));
    runTo(6);
    const entry = 4 * BAR_SEC;
    // Orbit 2: the rewritten lead is silent from its first sample.
    expect(nodes(2).mute.valueAt(entry - 0.1)).toBeCloseTo(1);
    expect(nodes(2).mute.valueAt(entry)).toBeCloseTo(0);
    // Orbit 1: the lead that owned it stays muted until bar 4, where the unmuted keys come in at full level.
    expect(nodes(1).mute.valueAt(entry - 0.1)).toBeLessThan(0.01);
    expect(nodes(1).mute.valueAt(entry)).toBeCloseTo(1);
    expect(nodes(3).mute.valueAt(entry)).toBeCloseTo(1);
  });

  it('applies a toggle at once and re-plans the entries after it', () => {
    const { clock, bank, runTo, nodes } = rig(() => score);
    for (const o of [1, 2, 3]) bank.ensure(o);
    runTo(3.9);
    bank.setMuted(new Set(['pad', 'lead']));
    runTo(6);
    // The next loop tick (50 ms later) starts a 30 ms ramp.
    const t = 3.9 * BAR_SEC;
    expect(nodes(3).mute.valueAt(t + 0.15)).toBeLessThan(0.05);
    expect(nodes(1).mute.valueAt(t + 0.15)).toBeLessThan(0.05);
    expect(nodes(2).mute.valueAt(4 * BAR_SEC)).toBeCloseTo(0);
    expect(nodes(1).mute.valueAt(4 * BAR_SEC)).toBeCloseTo(1);
    bank.setMuted(new Set());
    runTo(clock.t / BAR_SEC + 0.3);
    for (const o of [1, 2, 3]) expect(nodes(o).mute.valueAt(clock.t)).toBeGreaterThan(0.99);
  });
});
