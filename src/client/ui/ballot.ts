// The fork vote as the listener casts it (VoteCard). Arrowing through a radio group checks, and so
// votes for, every option on the way, so votes are coalesced to the server's bucket
// (RATE_LIMITS.vote) and the latest choice always goes out. The card shows the listener's own pick
// only while it is on its way; then, or once the server refuses it, the server's count (myVote).
import { RATE_LIMITS } from '../../shared/music.ts';
import type { ForkState } from '../../shared/protocol.ts';
import { ARRIVAL_SLACK_MS, TokenBucket } from './cooldown.ts';

export type VoteOption = ForkState['options'][number]['id'];

export interface Pick {
  forkId: string;
  option: VoteOption;
}

/** How long a sent pick is shown before the server's count takes over again. */
export const PICK_SETTLE_MS = 3000;

export interface BallotDeps {
  /** False when nothing could be sent (not in the room). */
  send: (forkId: string, option: VoteOption) => boolean;
  /** The pick to show instead of myVote changed; null shows myVote. */
  shown: (pick: Pick | null) => void;
  offline: () => void;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

export class Ballot {
  readonly #deps: BallotDeps;
  readonly #bucket: TokenBucket;
  #queued: Pick | null = null;
  #sendTimer: unknown = null;
  #settleTimer: unknown = null;
  #pick: Pick | null = null;

  constructor(deps: BallotDeps) {
    this.#deps = deps;
    this.#bucket = new TokenBucket(RATE_LIMITS.vote, deps.now());
  }

  choose(forkId: string, option: VoteOption): void {
    if (this.#pick && this.#pick.forkId !== forkId) this.reset();
    this.#queued = { forkId, option };
    this.#show(this.#queued);
    if (this.#sendTimer === null) this.#flush();
  }

  /** The server refused a vote: unless a newer choice is still on its way, show what it counted. */
  refused(): void {
    if (this.#queued) return;
    this.#clearSettle();
    this.#show(null);
  }

  /** A fork update: a different fork drops whatever was picked for the last one. */
  fork(fork: ForkState | null): void {
    if (this.#pick && fork?.id !== this.#pick.forkId) this.reset();
  }

  reset(): void {
    if (this.#sendTimer !== null) this.#deps.clearTimeout(this.#sendTimer);
    this.#sendTimer = null;
    this.#queued = null;
    this.#clearSettle();
    this.#show(null);
  }

  #flush(): void {
    this.#sendTimer = null;
    const q = this.#queued;
    if (!q) return;
    const now = this.#deps.now();
    if (!this.#bucket.take(now)) {
      this.#sendTimer = this.#deps.setTimeout(() => this.#flush(), this.#bucket.waitMs(now) + ARRIVAL_SLACK_MS);
      return;
    }
    this.#queued = null;
    this.#clearSettle();
    if (!this.#deps.send(q.forkId, q.option)) {
      this.#show(null);
      this.#deps.offline();
      return;
    }
    this.#settleTimer = this.#deps.setTimeout(() => {
      this.#settleTimer = null;
      if (!this.#queued) this.#show(null);
    }, PICK_SETTLE_MS);
  }

  #clearSettle(): void {
    if (this.#settleTimer !== null) this.#deps.clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
  }

  #show(pick: Pick | null): void {
    if (pick === this.#pick) return;
    this.#pick = pick;
    this.#deps.shown(pick);
  }
}
