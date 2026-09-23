// The ledger: one row per section at its bar 0 (revoked sections never enter), closed with the
// crowd's verdict when it ends. Append-only JSONL (`ledger.v1`), replayed at boot into an
// in-memory window of the last 2 hours. Rows by the scripted autopilot or played to nobody
// (audible = 0) are history, but never count toward cooldown or similarity.
import { fingerprintDistance, type SectionFingerprint } from '../../shared/analysis.ts';
import { BLOCKED_SOUNDS, type Catalog, type CatalogSound, type SoundCategory } from '../../shared/catalog.ts';
import { STORE_KEYS, type CrateItem, type Ledger, type LedgerRow, type Logger, type Store } from '../types.ts';

const MIN = 60_000;
export const LEDGER_WINDOW_MS = 120 * MIN;
const COOLDOWN_MS = 20 * MIN;
const COOLDOWN_SHARE = 0.25;
const COOLDOWN_ROWS = 6;
const COOLDOWN_HITS = 3;
const SIMILAR_MS = 20 * MIN;
export const SIMILARITY_THRESHOLD = 0.15;
const CHORD_REPEAT_MS = 30 * MIN;
const KEY_CENTRE_MS = 12 * MIN;
const SAME_BEAT = 0.1;
const LOVED_Z = 2;
const CRATE_MAX_SECONDS = 20;
const MACHINE_FRESH_MS = 60 * MIN;

type Entry = { t: 'row'; row: LedgerRow } | { t: 'close'; sectionId: string; endedAtWallMs: number; crowd: LedgerRow['crowd'] };

const counts = (row: LedgerRow) => row.author !== 'scripted' && row.audible > 0;
const endOf = (row: LedgerRow, nowWallMs: number) => row.endedAtWallMs ?? nowWallMs;

/** FNV-1a, for seeding. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Root pitch class name of a scale ("D:dorian", "<Eb4:major G:mixolydian>") or null. */
export function scaleRoot(scale: string): string | null {
  const m = /^[<\s[]*([A-Ga-g](?:#|b|s)?)/.exec(scale.trim());
  return m ? m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1) : null;
}

function beatVector(fp: SectionFingerprint): number[] {
  return [...fp.kickGrid16, ...fp.backbeatGrid16];
}

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return na === nb ? 0 : 1;
  return 1 - dot / Math.sqrt(na * nb);
}

function pickWeighted<T>(items: { item: T; weight: number }[], n: number, rand: () => number): T[] {
  const pool = items.filter((x) => x.weight > 0);
  const out: T[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((a, x) => a + x.weight, 0);
    let r = rand() * total;
    let i = 0;
    for (; i < pool.length - 1; i++) {
      r -= pool[i]!.weight;
      if (r <= 0) break;
    }
    out.push(pool.splice(i, 1)[0]!.item);
  }
  return out;
}

const CRATE_STRATA: [SoundCategory, number][] = [
  ['bass', 2],
  ['harmonic', 3],
  ['melodic', 3],
  ['texture', 2],
];
const CRATE_PERCUSSION = 4;
const CRATE_WILDCARDS = 2;

export function createLedger(opts: { store: Store; log: Logger; now?: () => number }): Ledger {
  const { store, log } = opts;
  const wallNow = opts.now ?? Date.now;
  const rows: LedgerRow[] = [];
  const byId = new Map<string, LedgerRow>();

  function prune(nowWallMs: number): void {
    const cutoff = nowWallMs - LEDGER_WINDOW_MS;
    while (rows.length && endOf(rows[0]!, nowWallMs) < cutoff) byId.delete(rows.shift()!.sectionId);
  }

  function insert(row: LedgerRow): void {
    const existing = byId.get(row.sectionId);
    if (existing) Object.assign(existing, row);
    else {
      rows.push(row);
      byId.set(row.sectionId, row);
      rows.sort((a, b) => a.startedAtWallMs - b.startedAtWallMs);
    }
  }

  for (const e of store.readJsonl<Entry>(STORE_KEYS.ledger)) {
    if (e?.t === 'row' && e.row?.sectionId) insert(e.row);
    else if (e?.t === 'close') {
      const row = byId.get(e.sectionId);
      if (row) Object.assign(row, { endedAtWallMs: e.endedAtWallMs, crowd: e.crowd });
    }
  }
  prune(wallNow());
  if (rows.length) log.info('ledger: restored', { rows: rows.length });

  const recent = (sinceWallMs: number, nowWallMs = wallNow()) => rows.filter((r) => endOf(r, nowWallMs) >= sinceWallMs);

  function cooldown(nowWallMs: number): string[] {
    const eligible = rows.filter(counts);
    const cooled = new Set<string>();
    eligible.forEach((row, i) => {
      if (endOf(row, nowWallMs) < nowWallMs - COOLDOWN_MS) return;
      const hits = new Map<string, number>();
      for (const r of eligible.slice(Math.max(0, i - COOLDOWN_ROWS + 1), i + 1)) {
        for (const s of r.sounds) if (s.share >= COOLDOWN_SHARE) hits.set(s.id, (hits.get(s.id) ?? 0) + 1);
      }
      for (const [id, n] of hits) if (n >= COOLDOWN_HITS) cooled.add(id);
    });
    return [...cooled].sort();
  }

  return {
    record(row: LedgerRow): void {
      if (byId.has(row.sectionId)) return;
      insert({ ...row });
      store.append<Entry>(STORE_KEYS.ledger, { t: 'row', row });
      prune(row.startedAtWallMs);
    },

    close(sectionId: string, endedAtWallMs: number, crowd: LedgerRow['crowd']): void {
      const row = byId.get(sectionId);
      if (!row || row.endedAtWallMs !== null) return;
      row.endedAtWallMs = endedAtWallMs;
      row.crowd = crowd;
      store.append<Entry>(STORE_KEYS.ledger, { t: 'close', sectionId, endedAtWallMs, crowd });
    },

    recent: (sinceWallMs: number) => recent(sinceWallMs),

    cooldown,

    similar(fp: SectionFingerprint, currentMovementId: string, nowWallMs: number) {
      let best: { sectionId: string; distance: number } | null = null;
      for (const r of rows) {
        if (!counts(r) || r.movementId === currentMovementId || endOf(r, nowWallMs) < nowWallMs - SIMILAR_MS) continue;
        const distance = Math.round(fingerprintDistance(fp, r.fingerprint) * 1000) / 1000;
        if (distance < SIMILARITY_THRESHOLD && (!best || distance < best.distance)) best = { sectionId: r.sectionId, distance };
      }
      return best;
    },

    flags(currentMovementId: string, nowWallMs: number): string[] {
      const heard = recent(nowWallMs - CHORD_REPEAT_MS, nowWallMs).filter((r) => r.audible > 0);
      const out: string[] = [];
      const last3 = heard.slice(-3);
      if (last3.length === 3 && last3.every((r) => beatVector(r.fingerprint).some((x) => x > 0))) {
        const same = last3.slice(1).every((r, i) => cosineDistance(beatVector(r.fingerprint), beatVector(last3[i]!.fingerprint)) < SAME_BEAT);
        if (same) out.push('Same beat for the last 3 sections: change the kick/backbeat pattern.');
      }
      const latest = heard[heard.length - 1];
      const hash = latest?.fingerprint.chordHash;
      if (latest && hash) {
        const earlier = heard.find((r) => r !== latest && r.movementId !== currentMovementId && r.fingerprint.chordHash === hash);
        if (earlier) out.push(`Chord cycle repeats one from an earlier side ("${earlier.name}").`);
        const run = heard.slice(-4);
        if (run.length === 4 && run.every((r) => r.fingerprint.chordHash === hash)) out.push('Same chord cycle for 4 sections running.');
      }
      const root = latest ? scaleRoot(latest.scale) : null;
      if (latest && root) {
        let since = latest.startedAtWallMs;
        for (let i = rows.length - 1; i >= 0 && scaleRoot(rows[i]!.scale) === root; i--) since = rows[i]!.startedAtWallMs;
        const minutes = Math.floor((nowWallMs - since) / MIN);
        if (nowWallMs - since > KEY_CENTRE_MS) out.push(`Key centre ${root} unchanged for ${minutes} min: consider a pivot.`);
      }
      return out;
    },

    drawCrate(seed: string, catalog: Catalog, prefs: { brightness: number }, nowWallMs: number): CrateItem[] {
      const rand = seededRandom(hashString(seed));
      const lastUsed = new Map<string, number>();
      for (const r of rows) for (const s of r.sounds) if (s.share > 0) lastUsed.set(s.id, Math.max(lastUsed.get(s.id) ?? 0, endOf(r, nowWallMs)));
      const cooled = new Set(cooldown(nowWallMs));
      const candidates = [...catalog.sounds]
        .filter((s) => !BLOCKED_SOUNDS.has(s.id) && !(s.durationSec !== undefined && s.durationSec > CRATE_MAX_SECONDS) && !cooled.has(s.id))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const weight = (s: CatalogSound) => {
        const used = lastUsed.get(s.id);
        const fresh = used === undefined ? 3 : nowWallMs - used > MACHINE_FRESH_MS ? 1.5 : 0.4;
        const d = s.brightness - prefs.brightness;
        return fresh * (0.35 + Math.exp(-(d * d) / (2 * 0.2 * 0.2)));
      };
      const taken = new Set<string>();
      const take = (list: CatalogSound[], n: number) => {
        const picked = pickWeighted(list.filter((s) => !taken.has(s.id)).map((s) => ({ item: s, weight: weight(s) })), n, rand);
        for (const s of picked) taken.add(s.id);
        return picked;
      };

      const out: CatalogSound[] = [];
      const percussion = candidates.filter((s) => s.category === 'percussion');
      const usedMachines = new Set(
        percussion.filter((s) => s.machine && nowWallMs - (lastUsed.get(s.id) ?? -Infinity) < MACHINE_FRESH_MS).map((s) => s.machine!),
      );
      const freshMachines = [...new Set(percussion.filter((s) => s.machine && !usedMachines.has(s.machine)).map((s) => s.machine!))].sort();
      const machine = pickWeighted(freshMachines.map((m) => ({ item: m, weight: 1 })), 1, rand)[0];
      if (machine) out.push(...take(percussion.filter((s) => s.machine === machine), 2));
      out.push(...take(percussion, CRATE_PERCUSSION - out.length));
      let short = CRATE_PERCUSSION - out.length;
      for (const [category, n] of CRATE_STRATA) {
        const got = take(candidates.filter((s) => s.category === category), n);
        out.push(...got);
        short += n - got.length;
      }
      out.push(...take(candidates, CRATE_WILDCARDS + short));
      return out.map((s) => ({ id: s.id, family: s.family, tags: s.tags }));
    },

    lovedMoments(nowWallMs: number) {
      return recent(nowWallMs - LEDGER_WINDOW_MS, nowWallMs)
        .filter((r) => r.audible > 0 && r.crowd && r.crowd.fireZ >= LOVED_Z)
        .sort((a, b) => b.crowd!.fireZ - a.crowd!.fireZ)
        .slice(0, 5)
        .map((r) => ({
          sectionId: r.sectionId,
          what: `${r.name} (${r.role}; ${r.sounds.slice(0, 3).map((s) => s.id).join(', ')})`,
          fireZ: Math.round(r.crowd!.fireZ * 10) / 10,
        }));
    },
  };
}
