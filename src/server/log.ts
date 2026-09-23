// Structured, leveled logging. BSIDE_LOG = debug | info (default) | warn | error | silent.
// Output is one JSON object per line unless stdout is a terminal (or BSIDE_LOG_FORMAT=pretty);
// warnings and errors go to stderr.
import { inspect } from 'node:util';
import type { Logger } from './types.ts';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, 'silent'>;

function threshold(): number {
  const raw = process.env.BSIDE_LOG?.trim().toLowerCase();
  return raw && raw in LEVELS ? LEVELS[raw as keyof typeof LEVELS] : LEVELS.info;
}

function pretty(): boolean {
  const raw = process.env.BSIDE_LOG_FORMAT?.trim().toLowerCase();
  if (raw === 'json') return false;
  if (raw === 'pretty') return true;
  return Boolean(process.stdout.isTTY);
}

/** Errors become {name, message, stack}; bigints become strings; cycles are cut. */
function toJson(record: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(record, (_key, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (typeof value === 'bigint') return value.toString();
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]';
      seen.add(value);
    }
    return value;
  });
}

const COLORS: Record<Level, string> = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

function formatPretty(level: Level, scope: string, msg: string, data: Record<string, unknown> | undefined): string {
  const time = new Date().toISOString().slice(11, 23);
  const fields = data
    ? Object.entries(data)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : inspect(v, { depth: 3, breakLength: Infinity, compact: true })}`)
        .join(' ')
    : '';
  return `${time} ${COLORS[level]}${level.toUpperCase().padEnd(5)}\x1b[0m \x1b[1m${scope}\x1b[0m ${msg}${fields ? ` ${fields}` : ''}`;
}

export function createLogger(scope: string): Logger {
  const min = threshold();
  const human = pretty();
  const write = (level: Level, msg: string, data?: Record<string, unknown>): void => {
    if (LEVELS[level] < min) return;
    const head = { time: new Date().toISOString(), level, scope, msg };
    const line = human ? formatPretty(level, scope, msg, data) : toJson(Object.assign({ ...head, ...data }, head));
    (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (msg, data) => write('debug', msg, data),
    info: (msg, data) => write('info', msg, data),
    warn: (msg, data) => write('warn', msg, data),
    error: (msg, data) => write('error', msg, data),
  };
}
