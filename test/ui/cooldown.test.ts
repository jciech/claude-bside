import { describe, expect, it } from 'vitest';
import { requestSpent, TokenBucket } from '../../src/client/ui/cooldown.ts';
import { RATE_LIMITS } from '../../src/shared/music.ts';
import { Sim } from '../room/sim.ts';

describe('TokenBucket (mirror of the server buckets)', () => {
  it('allows the burst, then one token per interval', () => {
    const b = new TokenBucket(RATE_LIMITS.reaction, 0);
    for (let i = 0; i < RATE_LIMITS.reaction.burst; i++) expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);
    expect(b.waitMs(0)).toBeCloseTo(3000, 6);
    expect(b.take(2999)).toBe(false);
    expect(b.take(3001)).toBe(true);
  });

  it('reports progress toward the next token for the ring', () => {
    const b = new TokenBucket(RATE_LIMITS.keep, 0);
    for (let i = 0; i < RATE_LIMITS.keep.burst; i++) b.take(0);
    expect(b.progress(0)).toBe(0);
    expect(b.progress(1000)).toBeCloseTo(0.5, 6);
    expect(b.progress(2500)).toBe(1);
  });

  it('never refills past the burst', () => {
    const b = new TokenBucket(RATE_LIMITS.request, 0);
    expect(b.level(10 * 60_000)).toBe(1);
    expect(b.take(10 * 60_000)).toBe(true);
    expect(b.ready(10 * 60_000 + 59_000)).toBe(false);
  });
});

describe('the ask cooldown', () => {
  it('is spent only on answers the server’s request bucket paid for', () => {
    expect(requestSpent({ ok: true, id: 'r1' })).toBe(true);
    // room-busy is checked after the listener's own bucket; a timed-out ask may well have arrived.
    for (const error of ['rate-limited', 'room-busy', 'timeout'] as const) expect(requestSpent({ ok: false, error })).toBe(true);
    for (const error of ['too-early', 'empty', 'invalid', 'hello-first', 'offline'] as const) expect(requestSpent({ ok: false, error })).toBe(false);
  });

  it('lets a listener ask again as soon as the warm-up that refused them is over', () => {
    const sim = new Sim();
    const [l] = sim.join(1);
    const mirror = new TokenBucket(RATE_LIMITS.request, sim.now);
    const ask = (): string => {
      if (!mirror.ready(sim.now)) return 'cooling down';
      const res = sim.crowd.request(l!.socketId, { text: 'more cowbell' }, sim.now);
      if (requestSpent(res)) mirror.take(sim.now);
      return res.ok ? 'ok' : res.error;
    };
    expect(ask()).toBe('too-early');
    sim.warmUp(12_000);
    expect(ask()).toBe('ok');
    expect(ask()).toBe('cooling down');
    sim.warmUp(60_000);
    expect(ask()).toBe('ok');
  });
});
