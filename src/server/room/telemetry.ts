// Audio telemetry from the sampled subset of clients. Robust statistics only (medians), and client
// errors reach the composer as coded, corroborated counts — never as free text.
import type { Telemetry, TelemetryErrorCode } from '../../shared/protocol.ts';
import { median } from './aggregate.ts';
import { CROWD } from './params.ts';

const MAX_SAMPLES_PER_LISTENER = 64;
const MAX_ERROR_REPORTS = 4000;
const KEEP_MS = 30 * 60_000;

interface Sample {
  cycle: number;
  at: number;
  rmsDb: number;
  centroidHz: number;
  clipPct: number;
}

interface ErrorReport {
  sectionId: string;
  partId: string;
  code: TelemetryErrorCode;
  listenerId: string;
  network: string;
  cycle: number;
  at: number;
}

export interface CorroboratedError {
  sectionId: string;
  partId: string;
  code: TelemetryErrorCode;
  clients: number;
}

export class TelemetryStore {
  readonly #samples = new Map<string, Sample[]>();
  /** Latest report per (listener, section, part, code), oldest first. */
  readonly #errors = new Map<string, ErrorReport>();

  add(listenerId: string, network: string, t: Telemetry, nowMs: number): void {
    const samples = this.#samples.get(listenerId) ?? [];
    samples.push({ cycle: t.cycle, at: nowMs, rmsDb: t.rmsDb, centroidHz: t.centroidHz, clipPct: t.clipPct });
    if (samples.length > MAX_SAMPLES_PER_LISTENER) samples.shift();
    this.#samples.set(listenerId, samples);
    for (const e of t.errors) {
      const key = [listenerId, e.sectionId, e.partId, e.code].join('\u0000');
      this.#errors.delete(key);
      this.#errors.set(key, { ...e, listenerId, network, cycle: t.cycle, at: nowMs });
    }
    for (const key of this.#errors.keys()) {
      if (this.#errors.size <= MAX_ERROR_REPORTS) break;
      this.#errors.delete(key);
    }
  }

  /** Per client: median over its samples in [from, to); then the median across clients. */
  digest(fromCycle: number, toCycle: number): { rmsDb: number; centroidHz: number; clipPct: number; clients: number } | null {
    const perClient: Sample[][] = [];
    for (const samples of this.#samples.values()) {
      const inWindow = samples.filter((s) => s.cycle >= fromCycle && s.cycle < toCycle);
      if (inWindow.length) perClient.push(inWindow);
    }
    if (!perClient.length) return null;
    const of = (key: 'rmsDb' | 'centroidHz' | 'clipPct') => median(perClient.map((samples) => median(samples.map((s) => s[key]))));
    return { rmsDb: of('rmsDb'), centroidHz: of('centroidHz'), clipPct: of('clipPct'), clients: perClient.length };
  }

  /**
   * Error codes reported for the same part by trusted listeners on ≥ 2 different networks, whatever
   * the size of the room: one listener never corroborates itself, and one network only when it is
   * `room`, the network holding most of the room (a venue, localhost), and two of its listeners
   * report. The most widely reported first, at most `CROWD.telemetry.maxCorroborated`.
   */
  corroborated(sinceCycle: number, isTrusted: (listenerId: string) => boolean, room: string | null = null): CorroboratedError[] {
    const groups = new Map<string, { head: ErrorReport; listeners: Set<string>; networks: Set<string> }>();
    for (const r of this.#errors.values()) {
      if (r.cycle < sinceCycle || !isTrusted(r.listenerId)) continue;
      const key = `${r.sectionId}\u0000${r.partId}\u0000${r.code}`;
      const g = groups.get(key) ?? { head: r, listeners: new Set<string>(), networks: new Set<string>() };
      g.listeners.add(r.listenerId);
      g.networks.add(r.network);
      groups.set(key, g);
    }
    const T = CROWD.telemetry;
    const out: CorroboratedError[] = [];
    for (const { head, listeners, networks } of groups.values()) {
      const byRoom = room !== null && networks.size === 1 && networks.has(room) && listeners.size >= 2;
      if (networks.size >= T.corroborateNetworks || byRoom) out.push({ sectionId: head.sectionId, partId: head.partId, code: head.code, clients: listeners.size });
    }
    return out.sort((a, b) => b.clients - a.clients).slice(0, T.maxCorroborated);
  }

  forget(listenerId: string): void {
    this.#samples.delete(listenerId);
  }

  prune(nowMs: number): void {
    for (const [key, r] of this.#errors) if (nowMs - r.at > KEEP_MS) this.#errors.delete(key);
    for (const [id, samples] of this.#samples) {
      const kept = samples.filter((s) => nowMs - s.at <= KEEP_MS);
      if (kept.length) this.#samples.set(id, kept);
      else this.#samples.delete(id);
    }
  }
}
