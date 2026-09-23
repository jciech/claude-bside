import { describe, expect, it } from 'vitest';
import { createClockSync, estimateOffset, SLEW_RATE } from '../../src/client/engine/clock-sync.ts';
import type { Timers } from '../../src/client/engine/timers.ts';

/** A deterministic event loop: timers fire as `advance` moves the clock; microtasks run in between. */
function world() {
  let now = 10_000;
  let wall = 1_700_000_000_000;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
    setInterval: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    clearInterval: (id) => void pending.delete(id as number),
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      wall += t.at - now;
      now = t.at;
      if (t.every) t.at += t.every;
      else pending.delete(id);
      t.fn();
    }
    wall += end - now;
    now = end;
    await flush();
  };
  return {
    timers,
    advance,
    perfNow: () => now,
    wallNow: () => wall,
    jumpWall: (ms: number) => (wall += ms),
    after: (ms: number) => new Promise<void>((r) => timers.setTimeout(r, ms)),
  };
}

/** A server whose clock is `offset` ahead of our performance clock, with configurable one-way delays. */
function server(w: ReturnType<typeof world>, offset: { value: number }, delays: () => [number, number]) {
  let probes = 0;
  const probe = async () => {
    probes++;
    const [up, down] = delays();
    await w.after(up);
    const serverMs = w.perfNow() + offset.value;
    await w.after(down);
    return serverMs;
  };
  return { probe, count: () => probes };
}

describe('estimateOffset', () => {
  it('needs 5 samples and averages the lowest-RTT third', () => {
    const s = (offset: number, rtt: number) => ({ offset, rtt, at: 0 });
    expect(estimateOffset([s(1, 10), s(1, 10), s(1, 10), s(1, 10)])).toBeNull();
    const est = estimateOffset([s(100, 20), s(102, 22), s(140, 300), s(80, 250), s(101, 21), s(99, 25)])!;
    expect(est.offset).toBeCloseTo(100.5);
    expect(est.rtt).toBeCloseTo(20.5);
  });
});

describe('ClockSync', () => {
  it('becomes ready after 5 good samples and estimates the offset despite asymmetric outliers', async () => {
    const w = world();
    const offset = { value: 123_456 };
    let i = 0;
    const srv = server(w, offset, () => (i++ % 3 === 2 ? [180, 20] : [15, 15]));
    const sync = createClockSync(srv.probe, { perfNow: w.perfNow, wallNow: w.wallNow, timers: w.timers });
    let ready = false;
    void sync.ready.then(() => (ready = true));
    await w.advance(150);
    expect(ready).toBe(false);
    await w.advance(2000);
    expect(ready).toBe(true);
    expect(Math.abs(sync.serverNow() - (w.perfNow() + offset.value))).toBeLessThan(1);
    expect(sync.rttMs()).toBeCloseTo(30);
    sync.stop();
  });

  it('discards probes slower than 500 ms round trip', async () => {
    const w = world();
    const srv = server(w, { value: 0 }, () => [300, 300]);
    const sync = createClockSync(srv.probe, { perfNow: w.perfNow, wallNow: w.wallNow, timers: w.timers });
    let ready = false;
    void sync.ready.then(() => (ready = true));
    await w.advance(20_000);
    expect(ready).toBe(false);
    sync.stop();
  });

  it('slews small corrections at ≤ 5 ms/s and steps large ones', async () => {
    const w = world();
    const offset = { value: 1000 };
    const srv = server(w, offset, () => [10, 10]);
    const sync = createClockSync(srv.probe, { perfNow: w.perfNow, wallNow: w.wallNow, timers: w.timers });
    const steps: number[] = [];
    sync.onStep((d) => steps.push(d));
    await w.advance(2000);
    expect(sync.offsetMs()).toBeCloseTo(1000, 0);

    offset.value = 1030; // server drifted 30 ms: slew
    sync.resync();
    await w.advance(1000);
    const moved = sync.offsetMs() - 1000;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThanOrEqual(1000 * SLEW_RATE + 1e-6);
    expect(steps).toEqual([]);
    await w.advance(10_000);
    expect(sync.offsetMs()).toBeCloseTo(1030, 0);

    offset.value = 1330; // 300 ms: step
    sync.resync();
    await w.advance(2000);
    expect(steps.length).toBe(1);
    expect(steps[0]).toBeCloseTo(300, -1);
    expect(sync.offsetMs()).toBeCloseTo(1330, 0);
    sync.stop();
  });

  it('re-bursts and replaces its samples when the machine slept', async () => {
    const w = world();
    const offset = { value: 500 };
    const srv = server(w, offset, () => [10, 10]);
    const sync = createClockSync(srv.probe, { perfNow: w.perfNow, wallNow: w.wallNow, timers: w.timers });
    const steps: number[] = [];
    sync.onStep((d) => steps.push(d));
    await w.advance(2000);
    const probes = srv.count();
    // performance.now() paused for a 60 s sleep while wall time and the server moved on.
    w.jumpWall(60_000);
    offset.value += 60_000;
    await w.advance(3000);
    expect(srv.count()).toBeGreaterThan(probes);
    expect(steps.length).toBe(1);
    expect(sync.offsetMs()).toBeCloseTo(60_500, 0);
    sync.stop();
  });

  it('probes periodically and on lifecycle events, and stops cleanly', async () => {
    const w = world();
    let fire: () => void = () => {};
    const srv = server(w, { value: 0 }, () => [5, 5]);
    const sync = createClockSync(srv.probe, { perfNow: w.perfNow, wallNow: w.wallNow, timers: w.timers, lifecycle: (l) => ((fire = l), () => {}) });
    await w.advance(2000);
    const initial = srv.count();
    await w.advance(31_000);
    const periodic = srv.count();
    expect(periodic).toBeGreaterThan(initial);
    fire();
    await w.advance(1000);
    expect(srv.count()).toBeGreaterThan(periodic);
    sync.stop();
    const stopped = srv.count();
    await w.advance(60_000);
    expect(srv.count()).toBe(stopped);
  });
});
