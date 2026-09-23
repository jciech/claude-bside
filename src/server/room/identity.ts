// Listener identity (docs/ARCHITECTURE.md §8): an anonymous client-chosen id plus a server-signed
// token binding it to a server-assigned listener id. A hello without a valid token gets a fresh
// listener id, so nobody can inherit another listener's trust by presenting their anonId.
// Also: the network a client address belongs to, for per-network caps.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const TOKEN_VERSION = 'v1';
/** Tokens are re-issued in every welcome; one unused for this long starts a new identity. */
export const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Listener identity hues (docs/DESIGN.md: 12 hues, hsl(h 55% 70%)). */
const HUE_STEPS = 12;

export interface Identity {
  /** A token for this (anonId, listenerId) pair. */
  issue(anonId: string, listenerId: string, nowMs: number): string;
  /** The listener id the token was issued for, or null when it is invalid, forged or expired. */
  verify(anonId: string, token: string | null, nowMs: number): string | null;
  newListenerId(): string;
}

export function createIdentity(secret: string): Identity {
  const sign = (anonId: string, listenerId: string, issuedAt: string): Buffer =>
    createHmac('sha256', secret).update(`${TOKEN_VERSION}|${anonId}|${listenerId}|${issuedAt}`).digest();

  return {
    issue(anonId, listenerId, nowMs) {
      const issuedAt = Math.floor(nowMs).toString(36);
      return [TOKEN_VERSION, listenerId, issuedAt, sign(anonId, listenerId, issuedAt).toString('base64url')].join('.');
    },
    verify(anonId, token, nowMs) {
      if (!token) return null;
      const parts = token.split('.');
      if (parts.length !== 4) return null;
      const [version, listenerId, issuedAt, signature] = parts as [string, string, string, string];
      if (version !== TOKEN_VERSION || !/^[A-Za-z0-9_-]{8,32}$/.test(listenerId) || !/^[0-9a-z]{1,12}$/.test(issuedAt)) return null;
      const issued = parseInt(issuedAt, 36);
      if (!Number.isFinite(issued) || issued > nowMs + 60_000 || nowMs - issued > TOKEN_MAX_AGE_MS) return null;
      const given = Buffer.from(signature, 'base64url');
      const expected = sign(anonId, listenerId, issuedAt);
      return given.length === expected.length && timingSafeEqual(given, expected) ? listenerId : null;
    },
    newListenerId: () => randomBytes(9).toString('base64url'),
  };
}

/** Deterministic identity hue in degrees (one of 12). */
export function hueOf(listenerId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < listenerId.length; i++) {
    h ^= listenerId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % HUE_STEPS) * (360 / HUE_STEPS);
}

/** Strips an IPv4-mapped IPv6 prefix and a zone id; returns '' for anything that isn't an IP. */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  let a = address.trim();
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(a);
  if (mapped) a = mapped[1]!;
  return isIP(a) ? a.toLowerCase() : '';
}

/** The eight 16-bit groups of a valid IPv6 address (embedded IPv4 tails included). */
function ipv6Hextets(address: string): number[] | null {
  const text = address.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_m, a: string, b: string, c: string, d: string) =>
    `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
  );
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s ? s.split(':').map((h) => (/^[0-9a-f]{1,4}$/i.test(h) ? parseInt(h, 16) : NaN)) : []);
  const left = parse(halves[0]!);
  const right = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - left.length - right.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...left, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...right];
  return all.every(Number.isFinite) ? all : null;
}

/**
 * The network an address counts toward for weight and connection caps: the /24 for IPv4, the
 * configured prefix (default /48) for IPv6. Unparseable addresses share one bucket.
 */
export function networkKey(address: string | undefined, ipv6Prefix: number): string {
  const a = normalizeAddress(address);
  if (!a) return 'unknown';
  if (isIP(a) === 4) return `${a.split('.').slice(0, 3).join('.')}.0/24`;
  const hextets = ipv6Hextets(a);
  if (!hextets) return 'unknown';
  const bits = Math.max(0, Math.min(128, ipv6Prefix));
  const masked = hextets.map((h, i) => {
    const keep = Math.max(0, Math.min(16, bits - i * 16));
    return keep === 0 ? 0 : h & (0xffff << (16 - keep)) & 0xffff;
  });
  return `${masked.map((h) => h.toString(16)).join(':')}/${bits}`;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopback(address: string | undefined): boolean {
  const a = normalizeAddress(address);
  return a === '::1' || LOOPBACK_V4.test(a);
}
