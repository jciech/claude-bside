import { describe, expect, it } from 'vitest';
import { instanceKnobsAt } from '../../src/client/engine/envelope.ts';
import { Performer, type PlannedHap } from '../../src/client/engine/performer.ts';
import { buildScore } from '../../src/client/engine/score.ts';
import type { PartError } from '../../src/client/engine/types.ts';
import { MAX_PART_ONSETS_PLAYED_PER_BAR } from '../../src/shared/limits.ts';
import type { Automation, Knob } from '../../src/shared/plan.ts';
import { EMPTY_MIXER, type MixerState } from '../../src/shared/program.ts';
import { part, section, sectionA, sectionB } from './fixtures.ts';

function setup(sections = [sectionA, sectionB], mixer: MixerState = EMPTY_MIXER) {
  const errors: PartError[] = [];
  const performer = new Performer({ mixer: () => mixer, onError: (e) => errors.push(e) });
  const score = buildScore(sections, new Map());
  performer.prepare([score]);
  return { performer, score, errors };
}

/** Plans [from, to) in scheduler-sized ticks, like the audio path does. */
function play(performer: Performer, score: ReturnType<typeof buildScore>, from: number, to: number, tick = 0.025, resumeAt: number | null = null): PlannedHap[] {
  const out: PlannedHap[] = [];
  for (let a = from; a < to - 1e-9; a += tick) out.push(...performer.plan(score, a, Math.min(to, a + tick), { cps: 0.5, guard: true, resumeAt: a === from ? resumeAt : null }));
  return out;
}

const onsets = (haps: PlannedHap[], key: string) => haps.filter((h) => h.inst.key === key || h.inst.part.id === key).map((h) => +h.onset.toFixed(4));

describe('performer on the fixture', () => {
  it('plays 4 kicks per bar across the A→B boundary with no double or missing onset', () => {
    const { performer, score } = setup();
    const haps = play(performer, score, 13, 19);
    const kicks = haps.filter((h) => h.inst.part.id === 'kick');
    expect(kicks.map((h) => h.onset)).toEqual(Array.from({ length: 24 }, (_, i) => 13 + i / 4));
    expect(kicks.filter((h) => h.onset < 16).every((h) => h.inst.key === 'fx01-0001:kick')).toBe(true);
    expect(kicks.filter((h) => h.onset >= 16).every((h) => h.inst.key === 'fx01-0002:kick')).toBe(true);
  });

  it('continues the carried bass line through the boundary (pattern time is not restarted)', () => {
    const { performer, score } = setup();
    const bass = play(performer, score, 12, 20).filter((h) => h.inst.part.id === 'bass');
    expect(bass.map((h) => h.onset)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(bass.map((h) => h.value.note)).toEqual(['D2', 'G2', 'B2', 'F2', 'D2', 'G2', 'B2', 'F2']);
  });

  it('anchors fresh parts at their section start and keeps the origin of continuing ones', () => {
    for (const s of [sectionA, sectionB]) {
      for (const p of s.parts) {
        const before = s === sectionB ? sectionA.parts.find((q) => q.id === p.id) : undefined;
        expect([p.id, p.originCycle]).toEqual([p.id, p.continues ? before!.originCycle : s.startCycle]);
      }
    }
  });

  it('plays a fresh part from its origin: P(cycle − originCycle)', () => {
    const code = 'note("<c3 d3 e3 f3 g3>")';
    const s = section({ id: 's', startCycle: 21, parts: [part({ id: 'p', code, originCycle: 21 })] });
    const { performer, score } = setup([s]);
    expect(play(performer, score, 21, 26).map((h) => [h.onset, h.value.note])).toEqual([
      [21, 'c3'],
      [22, 'd3'],
      [23, 'e3'],
      [24, 'f3'],
      [25, 'g3'],
    ]);
  });

  it('picks a continuing part up where the previous instance left off after a vamp', () => {
    // A (16 bars) vamps two extra bars; the conductor anchors B's part where A's pattern is (score bar 10).
    const code = 'note("<c3 d3 e3 f3 g3>")';
    const a = section({ id: 'a', startCycle: 0, parts: [part({ id: 'p', code, originCycle: 0 })] });
    const b = section({ id: 'b', startCycle: 18, parts: [part({ id: 'p', code, originCycle: 8, continues: true, carried: true })] });
    const { performer, score } = setup([a, b]);
    const notes = play(performer, score, 14, 21).map((h) => [h.onset, h.value.note]);
    // score bars 14, 15, then the vamp loop replays 8, 9; B continues with pattern bars 10, 11, 12
    expect(notes).toEqual([
      [14, 'g3'],
      [15, 'c3'],
      [16, 'f3'],
      [17, 'g3'],
      [18, 'c3'],
      [19, 'd3'],
      [20, 'e3'],
    ]);
  });

  it('applies knob automation per hap and carries the end value into B', () => {
    const { performer, score } = setup();
    const bass = play(performer, score, 8, 18).filter((h) => h.inst.part.id === 'bass');
    const cutoff = (bar: number) => bass.find((h) => h.onset === bar)!.value.cutoff as number;
    expect(cutoff(8)).toBeCloseTo(400);
    expect(cutoff(12)).toBeCloseTo(Math.sqrt(400 * 1200));
    expect(cutoff(15)).toBeCloseTo(400 * 3 ** (7 / 8));
    expect(cutoff(16)).toBeCloseTo(1200);
    expect(cutoff(17)).toBeCloseTo(1200);
  });

  it('samples a knob in the time frame where knob() is applied: a later .slow(2) stretches its lane', () => {
    const knobs: Knob[] = [{ name: 'cut', default: 100, min: 100, max: 2000, follows: 'none' }];
    const automation: Automation[] = [{ target: 'knob:cut', fromBar: 0, toBar: 16, from: 100, to: 1700, curve: 'linear' }];
    const s = section({ id: 's', startCycle: 16, parts: [part({ id: 'p', code: 'note("c3").lpf(knob("cut")).slow(2)', originCycle: 16, knobs, automation })] });
    const { performer, score } = setup([s]);
    const cutoff = play(performer, score, 16, 32).map((h) => [h.onset - 16, h.value.cutoff]);
    // Score bar b sounds the lane's value at bar b / 2.
    expect(cutoff).toEqual([0, 2, 4, 6, 8, 10, 12, 14].map((b) => [b, 100 + 100 * (b / 2)]));
  });

  it('follows the brightness macro (knob follow + per-hap cutoff scaling)', () => {
    const mixer: MixerState = { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 0.5, intensity: 0 } }, safety: null };
    const { performer, score } = setup([sectionA, sectionB], mixer);
    const lead = play(performer, score, 24, 25).filter((h) => h.inst.part.id === 'lead');
    expect(lead[0]!.value.cutoff).toBeCloseTo(1800 * 2 ** 0.5);
    expect(lead[0]!.value.room).toBeCloseTo(0.3 * 0.85);
    const bass = play(performer, score, 20, 21).filter((h) => h.inst.part.id === 'bass');
    // (1200 + 0.5·1050) knob, then × 2^0.5 on the hap
    expect(bass[0]!.value.cutoff).toBeCloseTo(Math.min(2400, 1200 + 525) * 2 ** 0.5);
  });

  it('starts the hats at bar 4 and the pickup fill in the bar before B', () => {
    const { performer, score } = setup();
    const haps = play(performer, score, 0, 17);
    expect(Math.min(...onsets(haps, 'fx01-0001:hats'))).toBe(4);
    const fill = onsets(haps, 'fill');
    expect(fill.length).toBe(16);
    expect(Math.min(...fill)).toBe(15);
    expect(Math.max(...fill)).toBe(15.9375);
  });

  it('keeps outgoing crossfade parts for two bars (looping their last phrase) alongside incoming ones', () => {
    const { performer, score } = setup();
    const haps = play(performer, score, 15, 19);
    const oldHats = onsets(haps, 'fx01-0001:hats');
    expect(Math.max(...oldHats)).toBeLessThan(18);
    expect(oldHats.filter((c) => c >= 16).length).toBe(16);
    expect(onsets(haps, 'fx01-0002:hats').filter((c) => c < 18).length).toBe(32);
    const pad = haps.filter((h) => h.inst.key === 'fx01-0001:pad');
    expect(pad.map((h) => [h.onset, h.duration])).toEqual([
      [16, 2],
      [16, 2],
      [16, 2],
    ]);
    expect(pad[0]!.value.note).toBe('D3'); // the loop replays score bar 8
  });

  it('routes haps with engine keys and keeps code locations', () => {
    const { performer, score } = setup();
    const kick = play(performer, score, 16, 16.1).find((h) => h.inst.part.id === 'kick')!;
    expect(kick.value).toMatchObject({ s: 'sbd', orbit: 1, decay: 0.35, gain: 0.9 });
    expect(kick.locations.length).toBeGreaterThan(0);
  });

  it('re-triggers sustained notes at the output start with their remaining length, and at window entries', () => {
    const { performer, score } = setup();
    const at9 = performer.plan(score, 9, 9.1, { cps: 0.5, resumeAt: 9 });
    const pad = at9.filter((h) => h.inst.part.id === 'pad');
    expect(pad.map((h) => [h.onset, h.duration])).toEqual([
      [9, 1],
      [9, 1],
      [9, 1],
    ]);
    const s = section({ id: 's', startCycle: 0, parts: [part({ id: 'p', code: 'note("c3").slow(8)', enterBar: 4, exitBar: 6 })] });
    const t = buildScore([s], new Map());
    performer.prepare([t]);
    const late = play(performer, t, 0, 8);
    expect(late.map((h) => [h.onset, h.duration, h.value.release])).toEqual([[4, 2, 0.05]]);
  });

  it('truncates notes at a cut with a short release', () => {
    const a = section({ id: 'a', startCycle: 0, parts: [part({ id: 'p', code: 'note("c3").slow(4)' })] });
    const b = section({ id: 'b', startCycle: 6, parts: [] });
    const { performer, score } = setup([a, b]);
    const haps = play(performer, score, 0, 8);
    expect(haps.map((h) => [h.onset, h.duration, h.value.release])).toEqual([
      [0, 4, undefined],
      [4, 2, 0.05],
    ]);
  });

  it('namespaces cut groups by orbit and sets the sidechain', () => {
    const s = section({
      id: 's',
      startCycle: 0,
      parts: [part({ id: 'k', orbit: 3, code: 's("sbd*2").cut(1)', duck: { orbits: [5, 6], depth: 0.7, releaseSec: 0.2 } })],
    });
    const { performer, score } = setup([s]);
    const [h] = performer.plan(score, 0, 0.1, { cps: 0.5 });
    expect(h!.value).toMatchObject({ orbit: 3, cut: 301, duckorbit: [5, 6], duckdepth: 0.7, duckattack: 0.2 });
  });

  it('strips engine-owned keys and clamps model values innermost', () => {
    const s = section({ id: 's', startCycle: 0, parts: [part({ id: 'p', code: 's("sbd").gain(1).room(1).speed(9)' })] });
    const { performer, score } = setup([s]);
    const [h] = performer.plan(score, 0, 0.5, { cps: 0.5 });
    expect(h!.value).toMatchObject({ gain: 1, room: 1, speed: 4, orbit: 1 });
  });
});

describe('a re-issued section (same id, part and code)', () => {
  const performerFor = () => new Performer({ mixer: () => EMPTY_MIXER, onError: () => {} });

  it('plays the knob default the conductor re-derived (Stay / Move on), like a fresh client and the UI', () => {
    const knobs = (d: number): Knob[] => [{ name: 'cut', default: d, min: 100, max: 5000, follows: 'none' }];
    const code = 'note("c3 c3").lpf(knob("cut"))';
    const rev1 = section({ id: 'c2', startCycle: 16, parts: [part({ id: 'pad', code, originCycle: 16, knobs: knobs(1000), carried: true })] });
    const rev2 = { ...rev1, rev: 2, parts: [{ ...rev1.parts[0]!, knobs: knobs(3000) }] };
    const connected = performerFor();
    const score1 = buildScore([rev1], new Map());
    connected.prepare([score1]);
    expect(play(connected, score1, 16, 17).map((h) => h.value.cutoff)).toEqual([1000, 1000]);
    const score2 = buildScore([rev2], new Map());
    connected.prepare([score2]);
    const fresh = performerFor();
    fresh.prepare([score2]);
    expect(play(connected, score2, 17, 18).map((h) => h.value.cutoff)).toEqual([3000, 3000]);
    expect(play(fresh, score2, 17, 18).map((h) => h.value.cutoff)).toEqual([3000, 3000]);
    expect(instanceKnobsAt(score2.byKey.get('c2:pad')!, 17.5, EMPTY_MIXER)).toEqual({ cut: 3000 });
  });

  it('plays from the moved origin when a Stay pushes the section later', () => {
    const code = 'note("<c3 d3 e3 f3 g3 a3 b3 c4 d4 e4>")';
    const at = (start: number, rev: number) => section({ id: 'c2', rev, startCycle: start, parts: [part({ id: 'p', code, originCycle: start })] });
    const connected = performerFor();
    connected.prepare([buildScore([at(16, 1)], new Map())]);
    const score2 = buildScore([at(24, 2)], new Map());
    connected.prepare([score2]);
    const fresh = performerFor();
    fresh.prepare([score2]);
    const notes = (p: Performer) => play(p, score2, 24, 26).map((h) => h.value.note);
    expect(notes(fresh)).toEqual(['c3', 'd3']);
    expect(notes(connected)).toEqual(['c3', 'd3']);
  });
});

describe('guard', () => {
  it('mutes a density bomb and reports it while other parts keep playing', () => {
    const bomb = 's("white*16").fast(16).superimpose(x => x.late(0.001)).superimpose(x => x.late(0.002))';
    const s = section({ id: 's', startCycle: 0, parts: [part({ id: 'k', role: 'kick', code: 's("sbd*4")' }), part({ id: 'b', role: 'texture', orbit: 2, code: bomb })] });
    const { performer, score, errors } = setup([s]);
    const haps = play(performer, score, 0, 2);
    expect(errors).toEqual([expect.objectContaining({ sectionId: 's', partId: 'b', code: 'density' })]);
    expect(performer.isMuted('s:b')).toBe(true);
    expect(haps.filter((h) => h.inst.part.id === 'b').length).toBeLessThanOrEqual(128);
    expect(onsets(haps, 'k')).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75]);
  });

  it('mutes at the same onset of the same bar whatever the scheduler tick (per-bar backstop)', () => {
    const bomb = 's("white*16").fast(16).superimpose(x => x.late(0.001)).superimpose(x => x.late(0.002))';
    const run = (tick: number) => {
      const s = section({ id: 's', startCycle: 0, parts: [part({ id: 'b', role: 'texture', code: bomb })] });
      const { performer, score, errors } = setup([s]);
      const haps = play(performer, score, 0, 2, tick);
      return { count: haps.length, last: haps[haps.length - 1]!.onset, errors };
    };
    const fine = run(0.01);
    const coarse = run(0.03);
    expect(fine.count).toBe(MAX_PART_ONSETS_PLAYED_PER_BAR);
    expect(coarse.count).toBe(MAX_PART_ONSETS_PLAYED_PER_BAR);
    expect(coarse.last).toBe(fine.last);
    expect(fine.errors).toEqual([expect.objectContaining({ code: 'density', message: coarse.errors[0]!.message })]);
  });

  it('mutes a part with too many haps in one tick', () => {
    const s = section({ id: 's', startCycle: 0, parts: [part({ id: 'b', code: 's("white*16").fast(16).superimpose(x => x.late(0.001))' })] });
    const { performer, score, errors } = setup([s]);
    performer.plan(score, 0, 0.25, { cps: 0.5, guard: true });
    expect(errors[0]).toMatchObject({ code: 'density' });
  });

  it('mutes a part whose query throws, reports parts that fail validation', () => {
    const s = section({
      id: 's',
      startCycle: 0,
      parts: [part({ id: 'bad', code: 'note("c3").nosuchmethod()' }), part({ id: 'ok', orbit: 2, code: 'note("c3*2")' })],
    });
    const { performer, score, errors } = setup([s]);
    expect(errors).toEqual([expect.objectContaining({ partId: 'bad', code: 'eval' })]);
    expect(performer.plan(score, 0, 1, { cps: 0.5 }).map((h) => h.inst.part.id)).toEqual(['ok', 'ok']);
  });

  it('caps a tick at MAX_HAPS_PER_TICK, dropping texture before kick', () => {
    const parts = Array.from({ length: 6 }, (_, i) =>
      part({ id: `p${i}`, role: i === 0 ? 'kick' : 'texture', orbit: i + 1, code: 's("white*16").fast(4).superimpose(x => x.late(0.001))' }),
    );
    const { performer, score } = setup([section({ id: 's', startCycle: 0, parts })]);
    const all = performer.plan(score, 0, 0.45, { cps: 0.5 });
    const kicks = all.filter((h) => h.inst.part.role === 'kick').length;
    expect(all.length).toBeGreaterThan(256);
    expect(kicks).toBeLessThanOrEqual(64);
    const haps = performer.plan(score, 0, 0.45, { cps: 0.5, guard: true });
    expect(haps.length).toBe(256);
    expect(haps.filter((h) => h.inst.part.role === 'kick').length).toBe(kicks);
    expect(performer.takeDropped()).toBe(all.length - 256);
  });
});

describe('visual events', () => {
  it('describes onsets with instance keys, pitch, effective gain and locations', () => {
    const { performer, score } = setup();
    const events = performer.events(score, 16, 17, 0.5);
    const bass = events.find((e) => e.partId === 'bass')!;
    expect(bass).toMatchObject({ sectionId: 'fx01-0002', instance: 'fx01-0002:bass', role: 'bass', family: 'bass', cycle: 16, midi: 38, sound: 'sawtooth' });
    expect(bass.gain).toBeCloseTo(0.6 * 0.75);
    expect(bass.locations.length).toBeGreaterThan(0);
    const oldHat = events.find((e) => e.instance === 'fx01-0001:hats' && e.cycle === 16.5)!;
    expect(oldHat.gain).toBeCloseTo(0.12 * 0.6 * Math.cos(Math.PI / 8)); // second half of "0.3 0.12", a quarter into the fade
  });
});
