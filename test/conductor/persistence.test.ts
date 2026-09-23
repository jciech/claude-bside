import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SectionFingerprint } from '../../src/shared/analysis.ts';
import { STORE_KEYS, type LedgerRow } from '../../src/server/types.ts';
import { createLedger, scaleRoot } from '../../src/server/conductor/ledger.ts';
import { createMemoryStore, createStore } from '../../src/server/conductor/store.ts';
import { catalog, createMemoryLog } from './harness.ts';

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'bside-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('store', () => {
  it('writes JSON atomically and reads it back; no temp files are left behind', () => {
    const dir = tempDir();
    const store = createStore(dir, createMemoryLog());
    store.writeJson('session.v1', { a: 1 });
    store.writeJson('session.v1', { a: 2 });
    expect(store.readJson('session.v1')).toEqual({ a: 2 });
    expect(readdirSync(dir)).toEqual(['session.v1.json']);
    expect(createStore(dir, createMemoryLog()).readJson('session.v1')).toEqual({ a: 2 });
  });

  it('ignores an unreadable JSON file instead of crashing', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'session.v1.json'), '{not json');
    const log = createMemoryLog();
    expect(createStore(dir, log).readJson('session.v1')).toBeUndefined();
    expect(log.lines.some((l) => l.level === 'warn')).toBe(true);
  });

  it('appends JSONL in order, visible before and after flush, and survives a torn last line', async () => {
    const dir = tempDir();
    const store = createStore(dir, createMemoryLog());
    for (let i = 0; i < 50; i++) store.append('ledger.v1', { i });
    expect(store.readJsonl<{ i: number }>('ledger.v1').map((r) => r.i)).toEqual([...Array(50).keys()]);
    await store.flush();
    appendFileSync(join(dir, 'ledger.v1.jsonl'), '{"i": 5'); // crash mid-append
    const reopened = createStore(dir, createMemoryLog());
    expect(reopened.readJsonl<{ i: number }>('ledger.v1').map((r) => r.i)).toEqual([...Array(50).keys()]);
    const lines = readFileSync(join(dir, 'ledger.v1.jsonl'), 'utf8').split('\n');
    expect(lines[0]).toBe('{"i":0}');
  });

  it('rejects keys that could escape the data directory', () => {
    const store = createStore(tempDir(), createMemoryLog());
    expect(() => store.writeJson('../x', 1)).toThrow();
    expect(() => store.append('a/b', 1)).toThrow();
  });
});

const fp = (shares: Record<string, number>, over: Partial<SectionFingerprint> = {}): SectionFingerprint => ({
  descriptors: { intensity: 0.5, brightness: 0.5, density: 0.5, tension: 0.3 },
  soundShares: shares,
  kickGrid16: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  backbeatGrid16: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  scale: 'D:dorian',
  bpm: 120,
  chordHash: 'c1',
  ...over,
});

const MIN = 60_000;
let seq = 0;
function row(over: Partial<LedgerRow> & { at: number; shares?: Record<string, number> }): LedgerRow {
  const shares = over.shares ?? { sbd: 0.5, triangle: 0.5 };
  const { at, shares: _, ...rest } = over;
  return {
    sectionId: `s${++seq}`,
    epoch: 'e',
    movementId: 'm1',
    name: 'Row',
    role: 'groove',
    startedAtWallMs: at,
    endedAtWallMs: at + MIN,
    startCycle: 0,
    bpm: 120,
    scale: 'D:dorian',
    sounds: Object.entries(shares).map(([id, share]) => ({ id, share })),
    fingerprint: fp(shares),
    measured: { intensity: 0.5, brightness: 0.5, density: 0.5, tension: 0.3 },
    parts: [{ id: 'kick', role: 'kick', code: 's("sbd*4")' }],
    crowd: null,
    author: 'claude',
    audible: 3,
    ...rest,
  };
}

describe('ledger', () => {
  const T = 1_700_000_000_000;

  it('records rows once, closes them with the crowd verdict, and replays both from the store', () => {
    const store = createMemoryStore();
    const ledger = createLedger({ store, log: createMemoryLog(), now: () => T + 10 * MIN });
    const r = row({ at: T, endedAtWallMs: null });
    ledger.record(r);
    ledger.record(r);
    ledger.close(r.sectionId, T + 2 * MIN, { fireZ: 2.5, boredZ: 0, harshZ: 0, keep: 1 });
    expect(store.readJsonl(STORE_KEYS.ledger)).toHaveLength(2);
    const replayed = createLedger({ store, log: createMemoryLog(), now: () => T + 10 * MIN });
    expect(replayed.recent(T - MIN)).toEqual([{ ...r, endedAtWallMs: T + 2 * MIN, crowd: { fireZ: 2.5, boredZ: 0, harshZ: 0, keep: 1 } }]);
    expect(replayed.lovedMoments(T + 10 * MIN)).toEqual([{ sectionId: r.sectionId, what: 'Row (groove; sbd, triangle)', fireZ: 2.5 }]);
  });

  it('keeps a 2-hour window in memory', () => {
    const ledger = createLedger({ store: createMemoryStore(), log: createMemoryLog(), now: () => T });
    ledger.record(row({ at: T - 3 * 60 * MIN }));
    ledger.record(row({ at: T }));
    expect(ledger.recent(0)).toHaveLength(1);
  });

  it('a row a restart left open is closed when the next section starts: it neither pins the window nor stays recent', () => {
    const store = createMemoryStore();
    const old = row({ at: T, endedAtWallMs: null });
    createLedger({ store, log: createMemoryLog(), now: () => T }).record(old);
    const DAY = 24 * 60 * MIN;
    let now = T + 60 * MIN;
    const later = createLedger({ store, log: createMemoryLog(), now: () => now });
    for (; now < T + DAY; now += 45_000) {
      const r = row({ at: now, endedAtWallMs: null, movementId: 'm2', shares: { vibraphone: 1 } });
      later.record(r);
      later.close(r.sectionId, now + 45_000, null);
    }
    // Two hours of 45 s sections, not a day's worth.
    expect(later.recent(0).length).toBeLessThanOrEqual(165);
    expect(later.recent(0).some((r) => r.sectionId === old.sectionId)).toBe(false);
    expect(later.similar(old.fingerprint, 'other', now)?.sectionId).not.toBe(old.sectionId);
    // The close was written down, bounded by how long a section can plausibly have played.
    const replayed = createLedger({ store, log: createMemoryLog(), now: () => T + 30 * MIN });
    expect(replayed.recent(0).find((r) => r.sectionId === old.sectionId)?.endedAtWallMs).toBe(T + 10 * MIN);
  });

  it('closes rows an older run left open behind later ones when the ledger is loaded', () => {
    const store = createMemoryStore();
    const a = row({ at: T, endedAtWallMs: null });
    const b = row({ at: T + 3 * MIN, endedAtWallMs: null });
    store.append(STORE_KEYS.ledger, { t: 'row', row: a });
    store.append(STORE_KEYS.ledger, { t: 'row', row: b });
    const ledger = createLedger({ store, log: createMemoryLog(), now: () => T + 5 * MIN });
    expect(ledger.recent(0).map((r) => [r.sectionId, r.endedAtWallMs])).toEqual([
      [a.sectionId, T + 3 * MIN],
      [b.sectionId, null],
    ]);
  });

  it('cooldown: loudness share ≥ 0.25 in 3 of the last 6 counted rows, for 20 minutes; autopilot and empty-room rows never count', () => {
    const ledger = createLedger({ store: createMemoryStore(), log: createMemoryLog(), now: () => T });
    ledger.record(row({ at: T, shares: { sbd: 0.6, vibraphone: 0.4 } }));
    ledger.record(row({ at: T + MIN, shares: { sbd: 0.6, casio: 0.4 } }));
    ledger.record(row({ at: T + 2 * MIN, shares: { sbd: 0.2, casio: 0.8 }, author: 'scripted' }));
    ledger.record(row({ at: T + 3 * MIN, shares: { sbd: 0.6, casio: 0.4 }, audible: 0 }));
    expect(ledger.cooldown(T + 4 * MIN)).toEqual([]);
    ledger.record(row({ at: T + 4 * MIN, shares: { sbd: 0.5, casio: 0.5 } }));
    expect(ledger.cooldown(T + 6 * MIN)).toEqual(['casio', 'sbd'].filter((id) => id === 'sbd'));
    expect(ledger.cooldown(T + 26 * MIN)).toEqual([]);
  });

  it('similarity looks only at earlier movements within 20 minutes, never at the autopilot', () => {
    const ledger = createLedger({ store: createMemoryStore(), log: createMemoryLog(), now: () => T });
    const a = row({ at: T, movementId: 'm1' });
    ledger.record(a);
    ledger.record(row({ at: T, movementId: 'm0', author: 'scripted' }));
    expect(ledger.similar(fp({ sbd: 0.5, triangle: 0.5 }), 'm2', T + 5 * MIN)).toEqual({ sectionId: a.sectionId, distance: 0 });
    expect(ledger.similar(fp({ sbd: 0.5, triangle: 0.5 }), 'm1', T + 5 * MIN)).toBeNull();
    expect(ledger.similar(fp({ sbd: 0.5, triangle: 0.5 }), 'm2', T + 30 * MIN)).toBeNull();
    expect(ledger.similar(fp({ wind: 1 }, { scale: 'E:phrygian', bpm: 90, kickGrid16: new Array(16).fill(0) }), 'm2', T + 5 * MIN)).toBeNull();
  });

  it('flags the same beat for three sections, a long-held key centre and repeated chord cycles', () => {
    const ledger = createLedger({ store: createMemoryStore(), log: createMemoryLog(), now: () => T });
    for (let i = 0; i < 4; i++) ledger.record(row({ at: T + i * 4 * MIN, movementId: i < 1 ? 'm0' : 'm1' }));
    const flags = ledger.flags('m1', T + 14 * MIN);
    expect(flags).toHaveLength(4);
    expect(flags.join(' ')).toMatch(/Same beat/);
    expect(flags.join(' ')).toMatch(/earlier side/);
    expect(flags.join(' ')).toMatch(/4 sections running/);
    expect(flags.join(' ')).toMatch(/Key centre D unchanged for 14 min/);
  });

  it('draws a deterministic, stratified crate biased toward fresh sounds and away from resting ones', () => {
    const ledger = createLedger({ store: createMemoryStore(), log: createMemoryLog(), now: () => T });
    const a = ledger.drawCrate('ep-m2', catalog, { brightness: 0.5 }, T);
    const b = ledger.drawCrate('ep-m2', catalog, { brightness: 0.5 }, T);
    expect(a).toEqual(b);
    expect(a).toHaveLength(16);
    expect(new Set(a.map((x) => x.id)).size).toBe(16);
    const category = (id: string) => catalog.sounds.find((s) => s.id === id)!.category;
    const counts = a.reduce<Record<string, number>>((m, x) => ({ ...m, [category(x.id)]: (m[category(x.id)] ?? 0) + 1 }), {});
    expect(counts.percussion).toBeGreaterThanOrEqual(4);
    expect(counts.bass).toBe(2); // the fixture has exactly two bass sounds
    expect(counts.texture).toBeGreaterThanOrEqual(2);
    expect(a.some((x) => catalog.sounds.find((s) => s.id === x.id)!.machine === 'RolandTR909')).toBe(true);
    expect(ledger.drawCrate('ep-m3', catalog, { brightness: 0.5 }, T)).not.toEqual(a);
    // A sound on cooldown never enters the crate.
    for (let i = 0; i < 3; i++) ledger.record(row({ at: T + i * MIN, shares: { rolandtr909_bd: 0.9, sbd: 0.1 } }));
    expect(ledger.drawCrate('ep-m2', catalog, { brightness: 0.5 }, T + 5 * MIN).map((x) => x.id)).not.toContain('rolandtr909_bd');
  });

  it('reads scale roots', () => {
    expect(scaleRoot('D:dorian')).toBe('D');
    expect(scaleRoot('<Eb4:major G:mixolydian>')).toBe('Eb');
    expect(scaleRoot('c#:minor')).toBe('C#');
  });
});
