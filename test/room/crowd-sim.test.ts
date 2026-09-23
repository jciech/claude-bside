// Crowd-steering scenarios, ported from research/scratch-steering/sim-steer.mjs and re-run with
// the ARCHITECTURE §8 parameters: τ = clamp(2 + 6·ln(1+N), 6, 60) s, slew = max(0.025, 0.12/√N)/s.
// 120 BPM: 1 bar = 2 s. Listeners are warmed up (trust 1) unless a scenario says otherwise.
import { describe, expect, it } from 'vitest';
import type { CrowdSignal } from '../../src/server/types.ts';
import { roomSlewPerSec, roomTauSec } from '../../src/server/room/params.ts';
import { Sim, type SimListener } from './sim.ts';

function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** What the conductor does with a replan: the next plan bends the baseline toward the room. */
const bendBaseline = (sim: Sim) => (s: CrowdSignal) => {
  if (s.type === 'replan-pressure') sim.baseline[s.axis] += (0.6 * s.pressure) / 2;
};

describe('smoothing parameters', () => {
  it('match ARCHITECTURE §8', () => {
    expect(roomTauSec(0)).toBe(6);
    expect(roomTauSec(1)).toBeCloseTo(2 + 6 * Math.log(2));
    expect(roomTauSec(1)).toBeCloseTo(6.16, 2);
    expect(roomTauSec(10)).toBeCloseTo(16.4, 1);
    expect(roomTauSec(1000)).toBeCloseTo(43.45, 2);
    expect(roomTauSec(1e6)).toBe(60);
    expect(roomSlewPerSec(1)).toBeCloseTo(0.12);
    expect(roomSlewPerSec(16)).toBeCloseTo(0.03);
    expect(roomSlewPerSec(400)).toBe(0.025);
  });
});

describe('A. solo listener', () => {
  it('hears the room move within seconds when dragging the puck fully', () => {
    const sim = new Sim();
    const [solo] = sim.join(1);
    sim.warmUp();
    const at: Record<number, number> = {};
    sim.run(30, (t) => {
      if (t === 0) sim.pad(solo!, 1, 1, true);
      at[t] = sim.pull().x;
    });
    // τ(1) ≈ 6.2 s under a 0.12/s slew: moving at once, half-way within 5 s, ≈ 0.8 at 10 s.
    expect(at[1]).toBeGreaterThan(0.1);
    expect(at[5]).toBeGreaterThan(0.5);
    expect(at[10]).toBeGreaterThan(0.75);
    expect(at[25]).toBeGreaterThan(0.9);
  });

  it('glides rather than jumps when the puck is flung across the pad', () => {
    const sim = new Sim();
    const [solo] = sim.join(1);
    sim.warmUp();
    sim.run(60, () => sim.pad(solo!, -1, -1, true));
    const at = [sim.pull().x];
    sim.run(20, () => {
      if (at.length === 1) sim.pad(solo!, 1, 1, true);
      at.push(sim.pull().x);
    });
    const steps = at.slice(1).map((x, i) => x - at[i]!);
    expect(at[0]).toBeLessThan(-0.9);
    expect(Math.max(...steps)).toBeLessThanOrEqual(roomSlewPerSec(1) + 1e-9);
    expect(at.at(-1)).toBeGreaterThan(0.5); // most of the way across within 20 s
  });

  it('one gesture bends the plan once, then relaxes back to centre', () => {
    const sim = new Sim();
    const [solo] = sim.join(1);
    sim.warmUp();
    let peak = 0;
    sim.run(300, (t) => {
      if (t === 5) sim.pad(solo!, 0.8, 0.6);
      peak = Math.max(peak, sim.pull().x);
    });
    expect(peak).toBeGreaterThan(0.65);
    expect(sim.count('replan-pressure')).toBe(1);
    const replan = sim.signals.find((s) => s.type === 'replan-pressure')!;
    expect(replan).toMatchObject({ axis: 'brightness' });
    expect(replan.t).toBeLessThan(60);
    // The puck relaxes 90 s after the gesture; the pull returns to centre.
    expect(Math.abs(sim.pull().x)).toBeLessThan(0.01);
  });
});

describe('B. one troll in a room of 40', () => {
  it('pinning the pad for 5 minutes moves the room by ≤ 0.1, and nothing fires', () => {
    const sim = new Sim();
    const [troll] = sim.join(40);
    sim.warmUp();
    let worst = 0;
    let nacked = 0;
    let requestsAccepted = 0;
    sim.run(300, (t) => {
      sim.pad(troll!, -1, -1, true);
      if (sim.crowd.react(troll!.socketId, { type: 'harsh', heardCycle: sim.cycle }, sim.cycle, sim.now)) nacked++;
      if (t % 5 === 0 && sim.crowd.request(troll!.socketId, { text: `make it darker ${t}` }, sim.now).ok) requestsAccepted++;
      worst = Math.min(worst, sim.pull().x, sim.pull().y);
    });
    expect(worst).toBeGreaterThan(-0.1);
    expect(sim.signals).toEqual([]); // no replan, no safety trim
    expect(nacked).toBeGreaterThan(150); // the reaction bucket (1 per 3 s)
    expect(requestsAccepted).toBeLessThanOrEqual(6); // 1 per minute
    const etched = sim.crowd.frame(sim.cycle, { x: 0, y: 0 }).etches.filter((e) => e.type === 'harsh');
    expect(etched.length).toBeLessThanOrEqual(5); // ≤ 1 per 4-bar window over the last 16 bars
  });
});

describe('C. a quarter of the room pushes', () => {
  it('12 of 40 pushing brightness moves the pull but stays under the replan trigger', () => {
    const sim = new Sim();
    const rnd = lcg(7);
    const who = sim.join(40).slice(0, 12);
    sim.warmUp();
    const start = who.map(() => Math.floor(rnd() * 60));
    let peak = 0;
    sim.run(780, (t) => {
      who.forEach((l, k) => {
        if (t >= start[k]! && t <= 180 && (t - start[k]!) % 45 === 0) sim.pad(l, 0.7 + 0.1 * (rnd() - 0.5), 0.1 * (rnd() - 0.5));
      });
      peak = Math.max(peak, sim.pull().x);
    }, bendBaseline(sim));
    expect(peak).toBeGreaterThan(0.3);
    expect(peak).toBeLessThan(0.45);
    expect(sim.count('replan-pressure')).toBe(0);
    expect(Math.abs(sim.pull().x)).toBeLessThan(0.02);
  });

  it('C2. half the room pushing strongly causes exactly one early replan', () => {
    const sim = new Sim();
    const rnd = lcg(11);
    const who = sim.join(40).slice(0, 20);
    sim.warmUp();
    const start = who.map(() => Math.floor(rnd() * 30));
    sim.run(420, (t) => {
      who.forEach((l, k) => {
        if (t >= start[k]! && t <= 240 && (t - start[k]!) % 40 === 0) sim.pad(l, 0.9, 0.3);
      });
    }, bendBaseline(sim));
    expect(sim.count('replan-pressure')).toBe(1);
    const replan = sim.signals[0]!;
    expect(replan).toMatchObject({ type: 'replan-pressure', axis: 'brightness' });
    expect(replan.t).toBeGreaterThan(60);
    expect(replan.t).toBeLessThan(100);
  });
});

describe('D. split room', () => {
  it('is reported as a split, not averaged into mush', () => {
    const sim = new Sim();
    const rnd = lcg(3);
    const room = sim.join(40);
    sim.warmUp();
    sim.run(120, (t) => {
      if (t % 30 === 0) room.slice(0, 20).forEach((l, i) => sim.pad(l, 0.1 * (rnd() - 0.5), i < 10 ? 0.8 : -0.8));
    });
    const frame = sim.crowd.frame(sim.cycle, { x: 0, y: 0 });
    expect(Math.abs(frame.pull.y)).toBeLessThan(0.05);
    expect(frame.consensus).toBeLessThan(0.5);
    expect(frame.split).toMatchObject({ axis: 'y' });
    expect(frame.split!.low).toBeCloseTo(-0.8, 1);
    expect(frame.split!.high).toBeCloseTo(0.8, 1);
    const summary = sim.crowd.summary(sim.baseline, sim.now);
    expect(summary.pad.split).toMatchObject({ axis: 'intensity' });
    expect(summary.pad.split!.low).toBeCloseTo(0.1, 1);
    expect(summary.pad.split!.high).toBeCloseTo(0.9, 1);
    expect(sim.signals).toEqual([]);
  });
});

describe('E. sybils', () => {
  it('30 fresh sockets from one /24 are capped at a network weight of 2', () => {
    const sim = new Sim();
    sim.join(40);
    sim.warmUp();
    const sybils = sim.join(30, { address: (i) => `66.66.66.${i % 250}` });
    sim.run(300, () => {
      for (const s of sybils) sim.pad(s, -1, -1, true);
    });
    const pull = sim.pull();
    // −2 / (2 + β·40) = −0.167 at steady state.
    expect(pull.x).toBeGreaterThan(-0.18);
    expect(pull.x).toBeLessThan(-0.12);
    expect(sim.signals).toEqual([]);
  });

  it('the same sockets from 30 different networks would carry real weight (the cap is what resists)', () => {
    const sim = new Sim();
    sim.join(40);
    sim.warmUp();
    const spread = sim.join(30, { address: (i) => `77.${i}.1.1` });
    sim.run(300, () => {
      for (const s of spread) sim.pad(s, -1, -1, true);
    });
    expect(sim.pull().x).toBeLessThan(-0.5);
  });
});

describe('K. whiplash', () => {
  it('half the room flipping every 60 s causes zero replans', () => {
    const sim = new Sim();
    const flippers = sim.join(40).slice(0, 20);
    sim.warmUp();
    let swing = 0;
    sim.run(360, (t) => {
      if (t % 10 === 0) {
        const v = Math.floor(t / 60) % 2 ? 0.9 : -0.9;
        for (const l of flippers) sim.pad(l, v, v, true);
      }
      swing = Math.max(swing, Math.abs(sim.pull().x));
    });
    expect(swing).toBeGreaterThan(0.3); // the fast lane does follow the room…
    expect(sim.count('replan-pressure')).toBe(0); // …but structure doesn't whiplash
  });
});

describe('F. Stay / Move on', () => {
  const SECTION_A = { id: 'ep-0001', startCycle: 0, bars: 32 as const, role: 'groove' as const };
  const SECTION_B = { id: 'ep-0002', startCycle: 24, bars: 32 as const, role: 'groove' as const };
  const moveOn = (sim: Sim, l: SimListener, sectionId: string, heardCycle = sim.cycle) =>
    sim.crowd.keep(l.socketId, { v: -1, sectionId, heardCycle }, sim.cycle, sim.now);

  it('15 of 40 pressing Move on shortens the section within ~30 s', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    sim.run(60, (t) => {
      for (let i = 0; i < 15; i++) if (t === Math.floor((i * 20) / 15)) expect(moveOn(sim, room[i]!, SECTION_A.id)).toBeNull();
    });
    const first = sim.signals.find((s) => s.type === 'keep')!;
    expect(first).toMatchObject({ type: 'keep', direction: -1, sectionId: SECTION_A.id });
    expect(first.t).toBeGreaterThan(15);
    expect(first.t).toBeLessThan(35);
  });

  it('F2. 3 of 40 pressing Move on does nothing', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    sim.run(60, (t) => {
      if (t === 2) for (let i = 0; i < 3; i++) moveOn(sim, room[i]!, SECTION_A.id);
    });
    expect(sim.count('keep')).toBe(0);
    expect(sim.crowd.frame(sim.cycle, { x: 0, y: 0 }).keep).toBeGreaterThan(-0.35);
  });

  it('F3. a solo listener pressing Move on once is enough', () => {
    const sim = new Sim();
    const [solo] = sim.join(1);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    sim.run(40, (t) => {
      if (t === 2) moveOn(sim, solo!, SECTION_A.id);
    });
    const first = sim.signals.find((s) => s.type === 'keep')!;
    expect(first.t).toBeLessThanOrEqual(24);
  });

  it('never double-skips: ballots are consumed, cleared at the next section and bound to the section heard', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    let nextStartsAt: number | null = null;
    const lateNacks: string[] = [];
    sim.run(
      120,
      (t) => {
        // 15 press early; 5 more keep hammering Move on all the time, some heard a bar late.
        for (let i = 0; i < 15; i++) if (t === Math.floor((i * 20) / 15)) moveOn(sim, room[i]!, SECTION_A.id);
        if (t % 3 === 0) {
          for (let i = 15; i < 20; i++) {
            const heard = Math.max(0, sim.cycle - 1);
            const section = heard < SECTION_B.startCycle || nextStartsAt === null ? SECTION_A.id : SECTION_B.id;
            const res = moveOn(sim, room[i]!, section, heard);
            if (res) lateNacks.push(res.reason);
          }
        }
        if (nextStartsAt !== null && sim.bar >= nextStartsAt) {
          sim.crowd.sectionStarted({ ...SECTION_B, startCycle: nextStartsAt });
          nextStartsAt = null;
        }
      },
      (signal) => {
        if (signal.type !== 'keep' || nextStartsAt !== null) return;
        // The conductor acts: consume the ballots and move on at the next 8-bar line.
        sim.crowd.consumeKeep();
        sim.crowd.setKeepPending({ kind: 'shorten', heldBars: 8, needBars: 8, atCycle: Math.ceil((sim.bar + 1) / 8) * 8, blocked: null });
        nextStartsAt = Math.ceil((sim.bar + 1) / 8) * 8;
      },
    );
    const keeps = sim.signals.filter((s) => s.type === 'keep');
    expect(keeps.length).toBe(1);
    expect(keeps[0]!.sectionId).toBe(SECTION_A.id);
    // Presses heard in A but arriving after B started are refused, not counted against B.
    expect(lateNacks).toContain('section-ended');
  });

  it('keeps signalling while blocked, until the next section clears the ballots', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    sim.run(40, (t) => {
      if (t === 0) for (let i = 0; i < 20; i++) moveOn(sim, room[i]!, SECTION_A.id);
    });
    expect(sim.count('keep')).toBeGreaterThan(1);
    sim.crowd.sectionStarted(SECTION_B);
    const before = sim.count('keep');
    sim.run(40);
    expect(sim.count('keep')).toBe(before);
    expect(sim.crowd.frame(sim.cycle, { x: 0, y: 0 }).keepPending).toBeNull();
  });

  it('rejects ballots for a section that was not audible at heardCycle', () => {
    const sim = new Sim();
    const [l] = sim.join(1);
    sim.warmUp();
    sim.crowd.sectionStarted(SECTION_A);
    sim.run(4);
    expect(moveOn(sim, l!, 'ep-9999')).toEqual({ event: 'keep', reason: 'wrong-section' });
    expect(moveOn(sim, l!, SECTION_A.id, sim.cycle - 20)).toEqual({ event: 'keep', reason: 'heard-cycle' });
    expect(moveOn(sim, l!, SECTION_A.id, sim.cycle + 3)).toEqual({ event: 'keep', reason: 'heard-cycle' });
  });
});

describe('H. reactions', () => {
  it('a drop the room loves stands out (z ≥ 2); a spammer counts once per 4-bar window', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    const rnd = lcg(5);
    const fire = (l: SimListener) => sim.crowd.react(l.socketId, { type: 'fire', heardCycle: sim.cycle }, sim.cycle, sim.now);
    // Ten ordinary 32-bar sections: each listener fires ~0.05 per minute.
    for (let s = 0; s < 10; s++) {
      sim.crowd.sectionStarted({ id: `ep-${s}`, startCycle: sim.bar, bars: 32, role: 'groove' });
      sim.run(63, () => {
        for (const l of room) if (rnd() < 0.05 / 60) fire(l);
      });
    }
    const dropStart = sim.bar;
    sim.crowd.sectionStarted({ id: 'ep-drop', startCycle: dropStart, bars: 32, role: 'drop' });
    sim.run(63, () => {
      for (let i = 0; i < 12; i++) if (rnd() < 1 / 60) fire(room[i]!);
      fire(room[39]!); // the spammer, every second
    });
    const stats = sim.crowd.reactionStats(dropStart, sim.bar + 1);
    expect(stats.fire.z).toBeGreaterThanOrEqual(2);
    // The spammer alone: at most one per 4-bar window → ≤ 9 in 32 bars, i.e. ≤ 0.25/listener/min.
    const spam = new Sim();
    const [one, ...rest] = spam.join(40);
    spam.warmUp();
    spam.crowd.sectionStarted({ id: 'ep-x', startCycle: 0, bars: 32, role: 'groove' });
    spam.run(63, () => spam.crowd.react(one!.socketId, { type: 'fire', heardCycle: spam.cycle }, spam.cycle, spam.now));
    expect(rest.length).toBe(39);
    const spamStats = spam.crowd.reactionStats(0, spam.bar + 1);
    expect(spamStats.fire.perListenerPerMin).toBeLessThan(0.25);
    expect(spamStats.fire.z).toBeLessThan(2);
  });

  it('≥ 20 % of the room pressing Too much within 8 bars triggers one safety trim', () => {
    const sim = new Sim();
    const room = sim.join(40);
    sim.warmUp();
    sim.crowd.sectionStarted({ id: 'ep-1', startCycle: 0, bars: 32, role: 'drop' });
    sim.run(60, (t) => {
      if (t === 10) for (let i = 0; i < 8; i++) sim.crowd.react(room[i]!.socketId, { type: 'harsh', heardCycle: sim.cycle }, sim.cycle, sim.now);
    });
    expect(sim.count('harsh')).toBe(1);
    const few = new Sim();
    const small = few.join(40);
    few.warmUp();
    few.crowd.sectionStarted({ id: 'ep-1', startCycle: 0, bars: 32, role: 'drop' });
    few.run(60, (t) => {
      if (t === 10) for (let i = 0; i < 3; i++) few.crowd.react(small[i]!.socketId, { type: 'harsh', heardCycle: few.cycle }, few.cycle, few.now);
    });
    expect(few.count('harsh')).toBe(0);
  });

  it('a bored room raises one novelty signal per section', () => {
    const sim = new Sim();
    const room = sim.join(20);
    sim.warmUp();
    sim.crowd.sectionStarted({ id: 'ep-1', startCycle: 0, bars: 32, role: 'groove' });
    sim.run(60, (t) => {
      if (t === 20) for (let i = 0; i < 6; i++) sim.crowd.keep(room[i]!.socketId, { v: -1, sectionId: 'ep-1', heardCycle: sim.cycle }, sim.cycle, sim.now);
    });
    expect(sim.count('bored')).toBe(1);
  });
});

describe('requests', () => {
  it('a request several listeners share surges once', () => {
    const sim = new Sim();
    const room = sim.join(10);
    sim.warmUp();
    const ids = new Set<string>();
    sim.run(10, (t) => {
      if (t < 5) {
        const res = sim.crowd.request(room[t]!.socketId, { text: ['more jazz pls', 'More jazz!', 'jazz', 'jazz please', 'JAZZ'][t]! }, sim.now);
        if (res.ok) ids.add(res.id);
      }
    });
    expect(ids.size).toBe(1);
    const surges = sim.signals.filter((s) => s.type === 'request-surge');
    expect(surges).toEqual([expect.objectContaining({ requestId: [...ids][0] })]);
  });
});
