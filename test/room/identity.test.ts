import { describe, expect, it } from 'vitest';
import { createBucket, KeyedBuckets, take } from '../../src/server/room/buckets.ts';
import { createIdentity, hueOf, isLoopback, networkKey, normalizeAddress, TOKEN_MAX_AGE_MS } from '../../src/server/room/identity.ts';

const T0 = 1_750_000_000_000;

describe('listener tokens', () => {
  const identity = createIdentity('a-test-secret-of-some-length');

  it('verify returns the listener id the token was issued for', () => {
    const id = identity.newListenerId();
    const token = identity.issue('anon-12345678', id, T0);
    expect(token.length).toBeLessThanOrEqual(200);
    expect(identity.verify('anon-12345678', token, T0 + 1000)).toBe(id);
  });

  it('rejects a token presented with another anonId (no trust inheritance)', () => {
    const token = identity.issue('anon-12345678', 'listener-a1', T0);
    expect(identity.verify('anon-87654321', token, T0)).toBeNull();
  });

  it('rejects tampered, foreign, malformed and expired tokens', () => {
    const token = identity.issue('anon-12345678', 'listener-a1', T0);
    const [v, , issued, sig] = token.split('.');
    expect(identity.verify('anon-12345678', `${v}.listener-b2.${issued}.${sig}`, T0)).toBeNull();
    expect(identity.verify('anon-12345678', token.slice(0, -2) + 'AA', T0)).toBeNull();
    expect(createIdentity('another-secret-entirely').verify('anon-12345678', token, T0)).toBeNull();
    for (const junk of [null, '', 'x', 'v1.a.b', 'v1.listener-a1.zz.' + 'A'.repeat(43), 'v2.listener-a1.1.abc', '....']) {
      expect(identity.verify('anon-12345678', junk, T0)).toBeNull();
    }
    expect(identity.verify('anon-12345678', token, T0 + TOKEN_MAX_AGE_MS + 1)).toBeNull();
    expect(identity.verify('anon-12345678', token, T0 - 120_000)).toBeNull(); // issued in the future
  });

  it('mints distinct listener ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => identity.newListenerId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('hues are one of 12, stable per listener', () => {
    const hues = new Set(Array.from({ length: 500 }, () => hueOf(identity.newListenerId())));
    for (const h of hues) expect(h % 30).toBe(0);
    expect(hues.size).toBe(12);
    expect(hueOf('abc')).toBe(hueOf('abc'));
  });
});

describe('networks', () => {
  it('groups IPv4 by /24 and unwraps IPv4-mapped IPv6', () => {
    expect(networkKey('203.0.113.77', 48)).toBe('203.0.113.0/24');
    expect(networkKey('::ffff:203.0.113.5', 48)).toBe('203.0.113.0/24');
    expect(networkKey('203.0.114.5', 48)).not.toBe(networkKey('203.0.113.5', 48));
  });

  it('groups IPv6 by the configured prefix', () => {
    expect(networkKey('2001:db8:1234:5678::1', 48)).toBe('2001:db8:1234:0:0:0:0:0/48');
    expect(networkKey('2001:db8:1234:ffff:1:2:3:4', 48)).toBe(networkKey('2001:db8:1234::9', 48));
    expect(networkKey('2001:db8:1235::1', 48)).not.toBe(networkKey('2001:db8:1234::1', 48));
    expect(networkKey('2001:db8:1234:5678::1', 56)).toBe('2001:db8:1234:5600:0:0:0:0/56');
    expect(networkKey('fe80::1%eth0', 64)).toBe('fe80:0:0:0:0:0:0:0/64');
    expect(networkKey('::1', 128)).toBe('0:0:0:0:0:0:0:1/128');
    expect(networkKey('64:ff9b::192.0.2.33', 128)).toBe('64:ff9b:0:0:0:0:c000:221/128');
  });

  it('puts unparseable addresses in one bucket', () => {
    expect(networkKey(undefined, 48)).toBe('unknown');
    expect(networkKey('not-an-ip', 48)).toBe('unknown');
    expect(normalizeAddress('  10.0.0.1 ')).toBe('10.0.0.1');
  });

  it('knows loopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['10.0.0.1', '::2', '', undefined, 'localhost']) expect(isLoopback(a)).toBe(false);
  });
});

describe('token buckets', () => {
  it('allow a burst, then refill at the rate', () => {
    const rate = { perSec: 2, burst: 3 };
    const b = createBucket(rate, 0);
    expect([take(b, rate, 0), take(b, rate, 0), take(b, rate, 0), take(b, rate, 0)]).toEqual([true, true, true, false]);
    expect(take(b, rate, 400)).toBe(false);
    expect(take(b, rate, 500)).toBe(true);
    expect(take(b, rate, 10_000)).toBe(true);
    expect(b.tokens).toBeLessThanOrEqual(3);
  });

  it('keyed buckets evict the least recently used key', () => {
    const buckets = new KeyedBuckets({ perSec: 0, burst: 1 }, 2);
    expect(buckets.take('a', 0)).toBe(true);
    expect(buckets.take('a', 0)).toBe(false);
    buckets.take('b', 0);
    buckets.take('c', 0); // evicts 'a'
    expect(buckets.take('a', 0)).toBe(true);
  });
});
