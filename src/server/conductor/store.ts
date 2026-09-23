// Persistence under BSIDE_DATA_DIR: one JSON file per key, written atomically (temp file + fsync +
// rename, so a crash leaves either the old or the new file), and append-only JSONL streams.
// Appends are buffered and written by a single in-flight async write per stream (order preserved,
// the event loop never blocks on the ledger); `flush()` drains them. A stream rotates to `.1` once
// it passes ROTATE_BYTES, and readJsonl reads the rotated file first so recent rows survive a
// rotation. A torn last line (crash mid-append) is skipped.
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger, Store } from '../types.ts';

const ROTATE_BYTES = 32 * 1024 * 1024;
const NAME = /^[a-z][a-z0-9._-]{0,63}$/i;

interface Stream {
  pending: string[];
  /** Lines being appended right now; the file is only trusted up to `bytes` until they land. */
  inFlight: string[];
  writing: Promise<void> | null;
  bytes: number;
}

function safeName(name: string): string {
  if (!NAME.test(name) || name.includes('..')) throw new Error(`Invalid store key "${name}"`);
  return name;
}

function parseLines<T>(text: string, log: Logger, file: string): T[] {
  const out: T[] = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Only the last line can be torn by a crash; anything else is corruption worth a warning.
      if (i < lines.length - 1) log.warn('store: skipped an unreadable line', { file, line: i + 1 });
    }
  });
  return out;
}

export function createStore(dataDir: string, log: Logger): Store {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const streams = new Map<string, Stream>();
  const jsonPath = (key: string) => join(dataDir, `${safeName(key)}.json`);
  const jsonlPath = (stream: string) => join(dataDir, `${safeName(stream)}.jsonl`);

  function streamOf(name: string): Stream {
    let s = streams.get(name);
    if (!s) {
      const file = jsonlPath(name);
      s = { pending: [], inFlight: [], writing: null, bytes: existsSync(file) ? statSync(file).size : 0 };
      streams.set(name, s);
    }
    return s;
  }

  function pump(name: string, s: Stream): void {
    if (s.writing || !s.pending.length) return;
    s.inFlight = s.pending;
    s.pending = [];
    const chunk = s.inFlight.join('');
    const file = jsonlPath(name);
    s.writing = (async () => {
      try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        if (s.bytes > ROTATE_BYTES) {
          renameSync(file, `${file}.1`);
          s.bytes = 0;
        }
        await appendFile(file, chunk, { mode: 0o600 });
        s.bytes += Buffer.byteLength(chunk);
      } catch (e) {
        log.error('store: append failed', { stream: name, error: (e as Error).message });
      } finally {
        s.inFlight = [];
        s.writing = null;
        pump(name, s);
      }
    })();
  }

  return {
    readJson<T>(key: string): T | undefined {
      const file = jsonPath(key);
      if (!existsSync(file)) return undefined;
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch (e) {
        log.warn('store: unreadable json, ignoring it', { key, error: (e as Error).message });
        return undefined;
      }
    },

    writeJson<T>(key: string, value: T): void {
      const file = jsonPath(key);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flush: true });
        renameSync(tmp, file);
      } catch (e) {
        log.error('store: write failed', { key, error: (e as Error).message });
        try {
          unlinkSync(tmp);
        } catch {
          // nothing to clean up
        }
      }
    },

    append<T>(stream: string, record: T): void {
      const s = streamOf(stream);
      s.pending.push(`${JSON.stringify(record)}\n`);
      pump(stream, s);
    },

    readJsonl<T>(stream: string): T[] {
      const file = jsonlPath(stream);
      const s = streams.get(stream);
      const out: T[] = [];
      if (existsSync(`${file}.1`)) out.push(...parseLines<T>(readFileSync(`${file}.1`, 'utf8'), log, `${file}.1`));
      if (existsSync(file)) {
        const buf = readFileSync(file);
        out.push(...parseLines<T>((s?.writing ? buf.subarray(0, s.bytes) : buf).toString('utf8'), log, file));
      }
      if (s) for (const line of [...(s.writing ? s.inFlight : []), ...s.pending]) out.push(JSON.parse(line) as T);
      return out;
    },

    async flush(): Promise<void> {
      for (;;) {
        const busy = [...streams].filter(([, s]) => s.writing || s.pending.length);
        if (!busy.length) return;
        for (const [name, s] of busy) pump(name, s);
        await Promise.all(busy.map(([, s]) => s.writing));
      }
    },
  };
}

/** In-memory Store for tests and tools (same semantics, values deep-copied like a round trip). */
export function createMemoryStore(): Store & { dump(): { json: Record<string, unknown>; jsonl: Record<string, unknown[]> } } {
  const json = new Map<string, string>();
  const jsonl = new Map<string, string[]>();
  return {
    readJson<T>(key: string): T | undefined {
      const v = json.get(key);
      return v === undefined ? undefined : (JSON.parse(v) as T);
    },
    writeJson<T>(key: string, value: T): void {
      json.set(key, JSON.stringify(value));
    },
    append<T>(stream: string, record: T): void {
      const list = jsonl.get(stream) ?? [];
      list.push(JSON.stringify(record));
      jsonl.set(stream, list);
    },
    readJsonl<T>(stream: string): T[] {
      return (jsonl.get(stream) ?? []).map((l) => JSON.parse(l) as T);
    },
    async flush(): Promise<void> {},
    dump() {
      return {
        json: Object.fromEntries([...json].map(([k, v]) => [k, JSON.parse(v)])),
        jsonl: Object.fromEntries([...jsonl].map(([k, v]) => [k, v.map((l) => JSON.parse(l))])),
      };
    },
  };
}
