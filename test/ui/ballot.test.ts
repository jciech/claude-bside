import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ballot, PICK_SETTLE_MS, type Pick, type VoteOption } from '../../src/client/ui/ballot.ts';
import { createBucket, take } from '../../src/server/room/buckets.ts';
import { RATE_LIMITS } from '../../src/shared/music.ts';

function setup(opts: { online?: () => boolean } = {}) {
  const sent: { forkId: string; option: VoteOption; at: number }[] = [];
  const state = { shown: null as Pick | null, offline: 0 };
  const ballot = new Ballot({
    send: (forkId, option) => {
      if (opts.online && !opts.online()) return false;
      sent.push({ forkId, option, at: Date.now() });
      return true;
    },
    shown: (p) => (state.shown = p),
    offline: () => state.offline++,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });
  return { ballot, sent, state };
}

/** What the server's vote bucket (crowd.ts vote()) makes of the votes, in order, each `latency(i)` ms on its way. */
function refusedByServer(sent: { at: number }[], latency: (i: number) => number = () => 0): number[] {
  const bucket = createBucket(RATE_LIMITS.vote, sent[0]?.at ?? 0);
  return sent.flatMap((v, i) => (take(bucket, RATE_LIMITS.vote, v.at + latency(i)) ? [] : [i]));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => vi.useRealTimers());

describe('casting a fork vote', () => {
  it('arrowing through the options never outruns the server’s bucket, and the last choice goes out', () => {
    const t = setup();
    for (const option of ['B', 'C', 'A', 'B'] as const) {
      t.ballot.choose('fork-1', option);
      expect(t.state.shown).toEqual({ forkId: 'fork-1', option });
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(2000);
    expect(refusedByServer(t.sent)).toEqual([]);
    expect(t.sent.at(-1)).toMatchObject({ forkId: 'fork-1', option: 'B' });
    // The vote that waited for a token still counts when it overtakes the others by 80 ms.
    expect(refusedByServer(t.sent, (i) => (i < t.sent.length - 1 ? 80 : 0))).toEqual([]);
  });

  it('coalesces a burst to the latest choice while the bucket refills', () => {
    const t = setup();
    for (const option of ['A', 'B', 'C', 'A', 'B', 'C', 'A'] as const) {
      t.ballot.choose('fork-1', option);
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(5000);
    expect(t.sent.map((s) => s.option)).toEqual(['A', 'B', 'C', 'A']);
    expect(refusedByServer(t.sent)).toEqual([]);
  });

  it('shows the pick while it is on its way, then the server’s count', () => {
    const t = setup();
    t.ballot.choose('fork-1', 'B');
    expect(t.state.shown).toEqual({ forkId: 'fork-1', option: 'B' });
    vi.advanceTimersByTime(PICK_SETTLE_MS);
    expect(t.state.shown).toBeNull();
  });

  it('falls back to the server’s count when a vote is refused, unless a newer one is queued', () => {
    const t = setup();
    t.ballot.choose('fork-1', 'B');
    t.ballot.refused();
    expect(t.state.shown).toBeNull();

    for (const option of ['A', 'B', 'C'] as const) t.ballot.choose('fork-1', option);
    t.ballot.choose('fork-1', 'A');
    // A refusal of an earlier vote: the queued A still shows, and still goes out.
    t.ballot.refused();
    expect(t.state.shown).toEqual({ forkId: 'fork-1', option: 'A' });
    vi.advanceTimersByTime(1500);
    expect(t.sent.at(-1)!.option).toBe('A');
  });

  it('does not show a pick that could not be sent', () => {
    let online = false;
    const t = setup({ online: () => online });
    t.ballot.choose('fork-1', 'C');
    expect(t.state.shown).toBeNull();
    expect(t.state.offline).toBe(1);
    online = true;
    t.ballot.choose('fork-1', 'C');
    expect(t.sent).toHaveLength(1);
  });

  it('drops a queued vote when the fork changes', () => {
    const t = setup();
    for (const option of ['A', 'B', 'C', 'A'] as const) t.ballot.choose('fork-1', option);
    t.ballot.fork({ id: 'fork-2' } as Parameters<Ballot['fork']>[0]);
    expect(t.state.shown).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(t.sent.map((s) => s.option)).toEqual(['A', 'B', 'C']);
  });
});
