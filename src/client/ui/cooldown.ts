// Client mirror of the server's token buckets (RATE_LIMITS in src/shared/music.ts), so buttons show
// a draining cooldown ring instead of silently getting nacked.
import type { RequestResult } from '../room/types.ts';

export interface Rate {
  perSec: number;
  burst: number;
}

/**
 * Extra wait for a message held back until a token was due: the server's bucket counts arrivals,
 * and this message may travel faster than the ones that emptied it.
 */
export const ARRIVAL_SLACK_MS = 100;

export class TokenBucket {
  private tokens: number;
  private at: number;
  readonly rate: Rate;

  constructor(rate: Rate, nowMs: number) {
    this.rate = rate;
    this.tokens = rate.burst;
    this.at = nowMs;
  }

  private refill(nowMs: number): void {
    if (nowMs > this.at) {
      this.tokens = Math.min(this.rate.burst, this.tokens + ((nowMs - this.at) / 1000) * this.rate.perSec);
      this.at = nowMs;
    }
  }

  level(nowMs: number): number {
    this.refill(nowMs);
    return this.tokens;
  }

  ready(nowMs: number): boolean {
    return this.level(nowMs) >= 1;
  }

  take(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** 0 = just emptied, 1 = the next token is here (for the ring). */
  progress(nowMs: number): number {
    const l = this.level(nowMs);
    return l >= 1 ? 1 : l - Math.floor(l);
  }

  /** Milliseconds until one token is available. */
  waitMs(nowMs: number): number {
    const l = this.level(nowMs);
    return l >= 1 ? 0 : ((1 - l) / this.rate.perSec) * 1000;
  }
}

/**
 * Whether the server's request bucket paid for this answer: crowd.ts request() takes the token
 * after its empty and warm-up checks. An ask that timed out may have arrived, so it counts.
 */
export function requestSpent(res: RequestResult): boolean {
  return res.ok || res.error === 'rate-limited' || res.error === 'room-busy' || res.error === 'timeout';
}
