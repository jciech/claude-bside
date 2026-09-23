import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../src/client/ui/cooldown.ts';
import { RATE_LIMITS } from '../../src/shared/music.ts';

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
