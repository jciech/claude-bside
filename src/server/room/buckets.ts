// Token buckets: `burst` tokens, refilled continuously at `perSec`. Used for every rate limit in the
// room (RATE_LIMITS in src/shared/music.ts) and on the HTTP admin surface.

export interface Rate {
  perSec: number;
  burst: number;
}

export interface Bucket {
  tokens: number;
  at: number;
}

export function createBucket(rate: Rate, nowMs: number): Bucket {
  return { tokens: rate.burst, at: nowMs };
}

/** Takes one token if available. */
export function take(bucket: Bucket, rate: Rate, nowMs: number): boolean {
  const elapsed = Math.max(0, nowMs - bucket.at) / 1000;
  bucket.tokens = Math.min(rate.burst, bucket.tokens + elapsed * rate.perSec);
  bucket.at = Math.max(bucket.at, nowMs);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

/** Seconds until the next token is available (for Retry-After). */
export function waitSeconds(bucket: Bucket, rate: Rate): number {
  return bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / rate.perSec);
}

/**
 * Buckets keyed by a string (an address, a network), with the least recently used keys evicted
 * past `maxKeys` so an attacker rotating keys cannot grow memory without bound.
 */
export class KeyedBuckets {
  readonly #rate: Rate;
  readonly #maxKeys: number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(rate: Rate, maxKeys = 10_000) {
    this.#rate = rate;
    this.#maxKeys = maxKeys;
  }

  take(key: string, nowMs: number): boolean {
    let bucket = this.#buckets.get(key);
    if (bucket) this.#buckets.delete(key);
    else bucket = createBucket(this.#rate, nowMs);
    this.#buckets.set(key, bucket);
    if (this.#buckets.size > this.#maxKeys) this.#buckets.delete(this.#buckets.keys().next().value!);
    return take(bucket, this.#rate, nowMs);
  }

  waitSeconds(key: string): number {
    const bucket = this.#buckets.get(key);
    return bucket ? waitSeconds(bucket, this.#rate) : 0;
  }
}
