import { describe, expect, it } from 'vitest';
import {
  channelFiltersAt,
  channelGainAt,
  instanceFiltersAt,
  instanceGainAt,
  instanceKnobsAt,
  instanceLevelAt,
  OPEN_HIGHPASS_HZ,
  OPEN_LOWPASS_HZ,
} from '../../src/client/engine/envelope.ts';
import { buildScore } from '../../src/client/engine/score.ts';
import { EMPTY_MIXER, type MixerState } from '../../src/shared/program.ts';
import { part, section, sectionA, sectionB } from './fixtures.ts';

const score = buildScore([sectionA, sectionB], new Map());
const inst = (key: string) => score.byKey.get(key)!;
const gain = (key: string, c: number, mixer: MixerState = EMPTY_MIXER) => instanceGainAt(inst(key), c, mixer);

describe('instance gain', () => {
  it('is zero before the window and the level inside it', () => {
    expect(gain('fx01-0001:hats', 3.9)).toBe(0);
    expect(gain('fx01-0001:hats', 4)).toBeCloseTo(0.6);
    expect(gain('fx01-0001:kick', 8)).toBeCloseTo(0.9);
  });

  it('follows level automation (pad fades in over bars 0–4)', () => {
    expect(gain('fx01-0001:pad', 0)).toBe(0);
    expect(gain('fx01-0001:pad', 2)).toBeCloseTo(0.25);
    expect(gain('fx01-0001:pad', 8)).toBeCloseTo(0.5);
  });

  it('crossfades outgoing and incoming parts with equal power over two bars', () => {
    for (const c of [16, 16.5, 17, 17.5]) {
      const out = gain('fx01-0001:hats', c) / 0.6;
      const into = gain('fx01-0002:hats', c) / 0.6;
      expect(out ** 2 + into ** 2).toBeCloseTo(1);
    }
    expect(gain('fx01-0001:hats', 16)).toBeCloseTo(0.6);
    expect(gain('fx01-0002:hats', 16)).toBeCloseTo(0);
    expect(gain('fx01-0001:hats', 17)).toBeCloseTo(0.6 * Math.SQRT1_2);
    expect(gain('fx01-0001:hats', 18)).toBeCloseTo(0);
    expect(gain('fx01-0002:hats', 18)).toBeCloseTo(0.6);
  });

  it('hands a continuing part over without a dip', () => {
    const list = score.byOrbit.get(3)!; // bass: A (0.7) → B (0.75), same orbit
    expect(channelGainAt(list, 15.99, EMPTY_MIXER)).toBeCloseTo(0.7);
    expect(channelGainAt(list, 16, EMPTY_MIXER)).toBeCloseTo(0.75);
  });

  it('releases over a beat (percussive) after the pickup window closes', () => {
    expect(gain('fx01-0002:fill', 15.5)).toBeCloseTo(0.5);
    expect(gain('fx01-0002:fill', 16.125)).toBeCloseTo(0.25);
    expect(gain('fx01-0002:fill', 16.25)).toBe(0);
  });

  it('applies the intensity macro and trims', () => {
    const mixer: MixerState = { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 0, intensity: 1 }, trimsDb: { kick: -6 } }, safety: null };
    expect(gain('fx01-0001:kick', 8, mixer)).toBeCloseTo(0.9 * 10 ** (-3 / 20));
    expect(gain('fx01-0001:pad', 8, mixer)).toBeCloseTo(0.5 * 10 ** (-2 / 20));
  });

  it('cuts and releases over a bar for non-percussive parts at a cut, faster before a breath', () => {
    const a = section({ id: 'a', startCycle: 0, parts: [part({ id: 'pad', role: 'pad', level: 0.8 }), part({ id: 'hh', role: 'hats', orbit: 2, level: 0.8 })] });
    const cut = buildScore([a, section({ id: 'b', startCycle: 16, parts: [] })], new Map());
    expect(instanceGainAt(cut.byKey.get('a:pad')!, 16.5, EMPTY_MIXER)).toBeCloseTo(0.4);
    expect(instanceGainAt(cut.byKey.get('a:hh')!, 16.125, EMPTY_MIXER)).toBeCloseTo(0.4);
    const breath = buildScore([a, section({ id: 'b', startCycle: 16, transitionIn: { type: 'breath', bars: 2 }, parts: [] })], new Map());
    expect(instanceGainAt(breath.byKey.get('a:pad')!, 14.125, EMPTY_MIXER)).toBeCloseTo(0.4);
    expect(instanceGainAt(breath.byKey.get('a:pad')!, 15, EMPTY_MIXER)).toBe(0);
  });
});

describe('filter transitions', () => {
  const a = section({ id: 'a', startCycle: 0, parts: [part({ id: 'x', orbit: 1 })] });
  const b = section({ id: 'b', startCycle: 16, transitionIn: { type: 'filter', bars: 4 }, parts: [part({ id: 'y', orbit: 2 })] });
  const s = buildScore([a, b], new Map());

  it('closes the outgoing low-pass over the last n bars and opens the incoming high-pass over n/2', () => {
    expect(instanceFiltersAt(s.byKey.get('a:x')!, 11).lowpass).toBe(OPEN_LOWPASS_HZ);
    expect(instanceFiltersAt(s.byKey.get('a:x')!, 14).lowpass).toBeCloseTo(Math.sqrt(OPEN_LOWPASS_HZ * 180));
    expect(instanceFiltersAt(s.byKey.get('a:x')!, 16).lowpass).toBeCloseTo(180);
    expect(instanceFiltersAt(s.byKey.get('b:y')!, 16).highpass).toBeCloseTo(2500);
    expect(instanceFiltersAt(s.byKey.get('b:y')!, 18).highpass).toBeCloseTo(OPEN_HIGHPASS_HZ);
    expect(channelFiltersAt(s.byOrbit.get(2)!, 30)).toEqual({ lowpass: OPEN_LOWPASS_HZ, highpass: OPEN_HIGHPASS_HZ });
  });
});

describe('what an instance plays with (Engine.levelAt / knobValues)', () => {
  it('reads the fader from the level lane at the score bar, before transitions and macros', () => {
    expect(instanceLevelAt(inst('fx01-0001:pad'), 2)).toBeCloseTo(0.25);
    expect(instanceLevelAt(inst('fx01-0001:pad'), 12)).toBeCloseTo(0.5);
    // Mid-crossfade the channel is at cos(π/4) of the fader; the fader itself is unchanged.
    expect(instanceLevelAt(inst('fx01-0001:hats'), 17)).toBeCloseTo(0.6);
    expect(instanceLevelAt(inst('fx01-0002:hats'), 17)).toBeCloseTo(0.6);
  });

  it('reads knob lanes, carried values and the follow offset from the room', () => {
    expect(instanceKnobsAt(inst('fx01-0001:bass'), 4, EMPTY_MIXER)).toEqual({ cut: 800 });
    expect(instanceKnobsAt(inst('fx01-0001:bass'), 12, EMPTY_MIXER).cut).toBeCloseTo(Math.sqrt(400 * 1200));
    expect(instanceKnobsAt(inst('fx01-0002:bass'), 20, EMPTY_MIXER).cut).toBeCloseTo(1200);
    const brighter: MixerState = { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 0.5, intensity: 0 }, trimsDb: {} }, safety: null };
    expect(instanceKnobsAt(inst('fx01-0002:bass'), 20, brighter).cut).toBeCloseTo(1200 + 0.5 * 1050);
    expect(instanceKnobsAt(inst('fx01-0002:kick'), 20, brighter)).toEqual({});
  });
});
