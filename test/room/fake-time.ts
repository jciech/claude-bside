// A deterministic clock + timer queue for room tests. `jitterMs` makes every timer fire late (or
// early, when negative) by that much, to exercise drift correction.
import type { ClockTimers } from '../../src/server/room/clock.ts';

interface Pending {
  id: number;
  at: number;
  fn: () => void;
  interval: number | null;
}

export class FakeTime {
  now: number;
  jitterMs = 0;
  #queue: Pending[] = [];
  #seq = 0;

  constructor(start = 1_000_000) {
    this.now = start;
  }

  readonly clock = (): number => this.now;

  readonly timers: ClockTimers & { setInterval: typeof setInterval; clearInterval: typeof clearInterval } = {
    setTimeout: ((fn: () => void, ms = 0) => this.#add(fn, ms, null)) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => this.#remove(id)) as unknown as typeof clearTimeout,
    setInterval: ((fn: () => void, ms = 0) => this.#add(fn, ms, ms)) as unknown as typeof setInterval,
    clearInterval: ((id: number) => this.#remove(id)) as unknown as typeof clearInterval,
  };

  get pending(): number {
    return this.#queue.length;
  }

  #add(fn: () => void, ms: number, interval: number | null): number {
    const id = ++this.#seq;
    this.#queue.push({ id, at: this.now + Math.max(0, ms) + this.jitterMs, fn, interval });
    return id;
  }

  #remove(id: number): void {
    this.#queue = this.#queue.filter((p) => p.id !== id);
  }

  /** Advances time to `now + ms`, running every timer that falls due, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.#queue.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.#queue[0];
      if (!next || next.at > end) break;
      this.#queue.shift();
      this.now = Math.max(this.now, next.at);
      if (next.interval !== null) this.#queue.push({ ...next, at: this.now + next.interval });
      next.fn();
    }
    this.now = end;
  }
}
