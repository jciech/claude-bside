// HTTP hardening (docs/ARCHITECTURE.md §11.5, §11.8): the client address behind trusted proxies,
// security headers with the production CSP, the admin guard for /api/composer/*, rate limits.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import helmet from 'helmet';
import { isLoopback, normalizeAddress } from '../room/identity.ts';
import { KeyedBuckets, type Rate } from '../room/buckets.ts';
import type { ServerConfig } from '../types.ts';

type Headers = Record<string, string | string[] | undefined>;

/** The exact production policy (ARCHITECTURE §11.5). Strudel evaluates code; superdough's worklets are data URLs; worker-timers uses blob workers. */
export const PRODUCTION_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-eval' blob: data:; worker-src 'self' blob: data:; " +
  "connect-src 'self' https://raw.githubusercontent.com; img-src 'self' data:; media-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

/** Development adds what Vite's HMR client needs: inline scripts and its websocket. */
export const DEVELOPMENT_CSP = PRODUCTION_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'").replace(
  "connect-src 'self'",
  "connect-src 'self' ws: wss:",
);

const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'x-forwarded-proto'];

function forwardedFor(headers: Headers): string[] {
  const raw = headers['x-forwarded-for'];
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  return joined
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "[::1]:443" → "::1", "1.2.3.4:5678" → "1.2.3.4". */
function stripPort(entry: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1]!;
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(entry);
  return v4WithPort ? v4WithPort[1]! : entry;
}

/**
 * The client's address. With `trustProxy` = n, the n-th hop from our side of X-Forwarded-For is
 * trusted (Express semantics: n = 1 means the address our own proxy saw). Anything unparseable,
 * or a chain shorter than claimed, falls back to the closest trustworthy address.
 */
export function clientAddress(source: { remoteAddress?: string; headers: Headers }, trustProxy: number): string {
  const peer = normalizeAddress(source.remoteAddress);
  if (trustProxy <= 0) return peer;
  const chain = [peer, ...forwardedFor(source.headers).reverse().map(stripPort)];
  let address = peer;
  for (let hop = 1; hop <= Math.min(trustProxy, chain.length - 1); hop++) {
    const candidate = normalizeAddress(chain[hop]);
    if (!candidate) break;
    address = candidate;
  }
  return address;
}

export function securityHeaders(config: ServerConfig): RequestHandler {
  const csp = config.dev ? DEVELOPMENT_CSP : PRODUCTION_CSP;
  const others = helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    xFrameOptions: { action: 'deny' },
    strictTransportSecurity: config.dev ? false : { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false },
  });
  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    others(req, res, next);
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison of two strings of any length. */
export function tokensEqual(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

const AUTH_FAILURES: Rate = { perSec: 1 / 6, burst: 10 };

/**
 * /api/composer/* access. With BSIDE_ADMIN_TOKEN: `Authorization: Bearer <token>`, compared in
 * constant time, failures rate limited per client address. Without a token: in development only
 * direct loopback peers (the raw socket address, and no forwarding headers — a same-host reverse
 * proxy must not turn the internet into loopback); in production the routes do not exist.
 */
export function adminGuard(config: ServerConfig): RequestHandler {
  const failures = new KeyedBuckets(AUTH_FAILURES);
  return (req, res, next) => {
    if (config.adminToken) {
      const address = clientAddress({ remoteAddress: req.socket.remoteAddress, headers: req.headers }, config.trustProxy);
      const match = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
      if (match && tokensEqual(match[1]!, config.adminToken)) return next();
      if (!failures.take(address, Date.now())) {
        res.setHeader('Retry-After', String(failures.waitSeconds(address) || 1));
        return void res.status(429).json({ error: 'too many failed attempts' });
      }
      res.setHeader('WWW-Authenticate', 'Bearer realm="bside"');
      return void res.status(401).json({ error: match ? 'invalid token' : 'missing bearer token' });
    }
    if (!config.dev) return void res.status(404).json({ error: 'not found' });
    const forwarded = FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined);
    if (isLoopback(req.socket.remoteAddress) && !forwarded) return next();
    res.status(403).json({ error: 'without BSIDE_ADMIN_TOKEN the composer API only accepts direct connections from this machine' });
  };
}

/** A token bucket shared by every caller of the route (the admin API has one operator). */
export function rateLimit(rate: Rate, name: string): RequestHandler {
  const buckets = new KeyedBuckets(rate, 1);
  return (_req, res, next) => {
    if (buckets.take(name, Date.now())) return next();
    res.setHeader('Retry-After', String(buckets.waitSeconds(name) || 1));
    res.status(429).json({ error: `rate limited: at most ${rate.burst} ${name} requests at once, then ${rate.perSec}/s` });
  };
}
