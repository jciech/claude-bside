import { describe, expect, it } from 'vitest';
import { SyncedScheduler, splitAtSegments } from '../../src/client/engine/scheduler.ts';
import type { PlannedHap } from '../../src/client/engine/performer.ts';
import { createTimeline, withTempoAt, type Timeline } from '../../src/shared/timeline.ts';

/** A fake audio device: context time starts at perf time p0, output latency L. */
function rig(opts: { timeline?: Timeline; latency?: number; p0?: number } = {}) {
  const latency = opts.latency ?? 0.04;
  const p0 = opts.p0 ?? 1000;
  const env = { perf: p0, serverOffset: 5_000_000, timeline: opts.timeline ?? createTimeline(5_000_000 + p0, 0.5, 0) };
  const out: { onset: number; at: number; dur: number; cps: number }[] = [];
  const plans: [number, number, number, number | null][] = [];
  const audioNow = () => (env.perf - p0) / 1000;
  const scheduler = new SyncedScheduler({
    audio: {
      currentTime: audioNow,
      outputTimestamp: () => ({ contextTime: audioNow() - latency, performanceTime: env.perf }),
      latencySec: () => latency,
    },
    serverNow: () => env.perf + env.serverOffset,
    perfNow: () => env.perf,
    timeline: () => env.timeline,
    plan: (from, to, cps, resumeAt) => {
      plans.push([from, to, cps, resumeAt]);
      const haps: PlannedHap[] = [];
      for (let k = Math.ceil(from * 4 - 1e-9); k / 4 < to; k++) haps.push({ onset: k / 4, duration: 0.25, value: {}, locations: [] } as unknown as PlannedHap);
      return haps;
    },
    output: (hap, at, dur, cps) => out.push({ onset: hap.onset, at, dur, cps }),
  });
  const run = (ms: number, step = 50) => {
    for (let t = 0; t < ms; t += step) {
      env.perf += step;
      scheduler.tick();
    }
  };
  /** Server ms at which a hap scheduled at audio time `at` is heard. */
  const heardAt = (at: number) => (at + latency) * 1000 + p0 + env.serverOffset;
  return { env, out, plans, scheduler, run, heardAt };
}

describe('SyncedScheduler', () => {
  it('plays every onset once, on the server-clock grid, starting at the requested bar', () => {
    const r = rig();
    r.scheduler.start(2);
    r.run(10_000);
    const onsets = r.out.map((o) => o.onset);
    expect(onsets[0]).toBe(2);
    expect(new Set(onsets).size).toBe(onsets.length);
    expect(onsets).toEqual(Array.from({ length: onsets.length }, (_, i) => 2 + i / 4));
    for (const o of r.out) expect(r.heardAt(o.at)).toBeCloseTo(r.env.timeline.segments[0]!.startMs + o.onset * 2000, 3);
    expect(r.plans[0]![3]).toBe(2); // the first query re-triggers sustained notes at the start bar
  });

  it('keeps audio `lookahead` ahead and never schedules in the past', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(3000);
    const t = (r.env.perf - 1000) / 1000;
    const last = r.out[r.out.length - 1]!;
    expect(last.at - t).toBeLessThanOrEqual(0.26);
    for (const o of r.out) expect(o.at).toBeGreaterThan(0);
  });

  it('splits queries at tempo segments with each segment’s cps and durations from the timeline', () => {
    const base = createTimeline(5_001_000, 0.5, 0);
    const tl = withTempoAt(base, 2, 1);
    const r = rig({ timeline: tl });
    r.scheduler.start(1);
    r.run(6000);
    expect(r.plans.length).toBeGreaterThan(20);
    for (const [, to, cps] of r.plans) expect(cps).toBe(to <= 2 ? 0.5 : 1);
    expect(r.plans.some(([, to]) => to === 2) && r.plans.some(([from]) => from === 2)).toBe(true);
    expect(r.out.find((o) => o.onset === 1.75)!.dur).toBeCloseTo(0.5);
    expect(r.out.find((o) => o.onset === 2)!.dur).toBeCloseTo(0.25);
    for (const o of r.out) expect(r.heardAt(o.at)).toBeCloseTo(5_001_000 + (o.onset <= 2 ? o.onset * 2000 : 4000 + (o.onset - 2) * 1000), 3);
    expect(splitAtSegments(tl, 1.5, 2.5)).toEqual([
      [1.5, 2, 0.5],
      [2, 2.5, 1],
    ]);
  });

  it('skips forward on a forward clock step without playing late haps', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(2000);
    const before = r.out.length;
    r.env.serverOffset += 700; // server time jumps ahead by 700 ms
    r.run(2000);
    const after = r.out.slice(before);
    const t0 = r.out[before - 1]!.onset;
    expect(after[0]!.onset - t0).toBeGreaterThan(0.25); // some onsets skipped
    expect(new Set(r.out.map((o) => o.onset)).size).toBe(r.out.length);
    expect(r.scheduler.takeHealth().skips).toBe(1);
  });

  it('holds on a backward clock step instead of replaying handed-over cycles', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(2000);
    const handed = r.scheduler.lastEnd!;
    r.env.serverOffset -= 800;
    r.run(400);
    expect(r.scheduler.lastEnd).toBe(handed);
    r.run(2000);
    const onsets = r.out.map((o) => o.onset);
    expect(new Set(onsets).size).toBe(onsets.length);
    expect(onsets).toEqual(Array.from({ length: onsets.length }, (_, i) => onsets[0]! + i / 4));
  });

  it('re-anchors after a huge backward step rather than going silent for seconds', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(2000);
    r.env.serverOffset -= 20_000;
    r.run(200);
    expect(r.scheduler.lastEnd!).toBeLessThan(0);
    expect(r.scheduler.takeHealth().skips).toBe(1);
  });

  it('skips ahead after a stalled tab instead of flooding', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(1000);
    const before = r.out.length;
    r.env.perf += 5000; // no ticks for 5 s
    r.run(100);
    const burst = r.out.slice(before);
    expect(burst.length).toBeLessThanOrEqual(2);
    expect(r.scheduler.takeHealth().skips).toBe(1);
  });

  it('hands audio over earlier by the output chain delay', () => {
    const r = rig();
    const delayed = new SyncedScheduler({ ...(r.scheduler as unknown as { deps: ConstructorParameters<typeof SyncedScheduler>[0] }).deps, outputDelaySec: 0.006 });
    delayed.start(0);
    r.scheduler.start(0);
    r.run(100);
    delayed.tick();
    expect(r.scheduler.audioTimeAtCycle(3) - delayed.audioTimeAtCycle(3)).toBeCloseTo(0.006, 9);
  });

  it('smooths the output-timestamp mapping and snaps on real jumps', () => {
    const r = rig();
    r.scheduler.start(0);
    r.run(500);
    const at = r.scheduler.audioTimeAtCycle(10);
    r.run(500);
    expect(r.scheduler.audioTimeAtCycle(10)).toBeCloseTo(at, 6);
  });
});
