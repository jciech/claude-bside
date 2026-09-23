// Server configuration from the environment (docs/ARCHITECTURE.md §16). Pure except for the
// listener-token secret: when BSIDE_SECRET is unset it is generated once and persisted in dataDir,
// so tokens issued before a restart stay valid.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DriverName } from '../shared/composer-api.ts';
import type { ServerConfig } from './types.ts';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DEFAULT_SOURCE_URL = 'https://github.com/jciech/claude-bside';
const SECRET_FILE = 'secret.key';
const MIN_SECRET_LENGTH = 16;
const MIN_ADMIN_TOKEN_LENGTH = 16;
const DRIVERS: readonly DriverName[] = ['claude', 'external', 'scripted'];
const SECTION_EFFORTS = ['low', 'medium', 'high'] as const;
const MOVEMENT_EFFORTS = ['medium', 'high', 'xhigh'] as const;

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^-?\d+$/.test(raw)) throw new ConfigError(`${name} must be an integer (got "${raw}")`);
  const value = Number(raw);
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max} (got ${value})`);
  return value;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new ConfigError(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
  return raw as T;
}

function nonEmpty(env: NodeJS.ProcessEnv, name: string): string | null {
  const raw = env[name]?.trim();
  return raw ? raw : null;
}

/** BSIDE_SECRET, or a random secret generated once and kept in dataDir (mode 0600). */
function loadSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = nonEmpty(env, 'BSIDE_SECRET');
  if (fromEnv) {
    if (fromEnv.length < MIN_SECRET_LENGTH) throw new ConfigError(`BSIDE_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    return fromEnv;
  }
  const file = join(dataDir, SECRET_FILE);
  const read = (): string | null => {
    try {
      const value = readFileSync(file, 'utf8').trim();
      return value.length >= MIN_SECRET_LENGTH ? value : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const existing = read();
  if (existing) return existing;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString('base64url');
  try {
    writeFileSync(file, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err) {
    // Another process created it first: use theirs.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = read();
      if (raced) return raced;
    }
    throw err;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[]): ServerConfig {
  const dev = argv.includes('--dev') || env.NODE_ENV !== 'production';
  const dataDir = resolve(env.BSIDE_DATA_DIR?.trim() || 'data');
  const hasApiKey = Boolean(nonEmpty(env, 'ANTHROPIC_API_KEY'));
  const requested = oneOf<DriverName>(env, 'BSIDE_COMPOSER', DRIVERS, hasApiKey ? 'claude' : 'scripted');
  const adminToken = nonEmpty(env, 'BSIDE_ADMIN_TOKEN');
  if (adminToken && !dev && (adminToken.length < MIN_ADMIN_TOKEN_LENGTH || adminToken === 'change-me')) {
    throw new ConfigError(`BSIDE_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters (and not the example value) in production`);
  }
  return {
    port: int(env, 'PORT', 3000, 0, 65535),
    dev,
    dataDir,
    catalogPath: resolve(env.BSIDE_CATALOG?.trim() || join(REPO_ROOT, 'palette', 'catalog.json')),
    // Without a key the Claude driver cannot run; the conductor starts on the autopilot instead.
    driver: requested === 'claude' && !hasApiKey ? 'scripted' : requested,
    model: nonEmpty(env, 'BSIDE_MODEL') ?? 'claude-opus-5',
    effort: {
      section: oneOf(env, 'BSIDE_EFFORT_SECTION', SECTION_EFFORTS, 'medium'),
      movement: oneOf(env, 'BSIDE_EFFORT_MOVEMENT', MOVEMENT_EFFORTS, 'high'),
    },
    maxPlansPerHour: int(env, 'BSIDE_MAX_PLANS_PER_HOUR', 90, 0, 3600),
    maxApiCallsPerPlan: int(env, 'BSIDE_MAX_API_CALLS_PER_PLAN', 8, 1, 32),
    adminToken,
    secret: loadSecret(env, dataDir),
    trustProxy: int(env, 'BSIDE_TRUST_PROXY', 0, 0, 16),
    ipv6Prefix: int(env, 'BSIDE_IPV6_PREFIX', 48, 16, 128),
    maxSocketsPerNetwork: int(env, 'BSIDE_MAX_SOCKETS_PER_NETWORK', 64, 1, 100_000),
    sourceUrl: nonEmpty(env, 'BSIDE_SOURCE_URL') ?? DEFAULT_SOURCE_URL,
  };
}

/**
 * Where to listen: BSIDE_HOST, else loopback in development (the dev server can read the whole
 * repository through Vite) and every interface in production.
 */
export function listenHost(env: NodeJS.ProcessEnv, config: Pick<ServerConfig, 'dev'>): string | undefined {
  return nonEmpty(env, 'BSIDE_HOST') ?? (config.dev ? 'localhost' : undefined);
}
