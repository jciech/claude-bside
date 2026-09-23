// Listener requests (docs/ARCHITECTURE.md §8): merged on a normalised key, weighed by decaying
// support, with a visible lifecycle. Raw text is only ever shown to its own author; everyone else
// sees the composer's paraphrase once decided.
import { randomBytes } from 'node:crypto';
import type { CrowdSummary } from '../../shared/composer-api.ts';
import type { RequestCard, RequestStatus } from '../../shared/protocol.ts';
import { requestMergeKey, sanitizePlainText } from '../../shared/text.ts';
import { CROWD } from './params.ts';

const P = CROWD.requests;
const UNDECIDED: ReadonlySet<RequestStatus> = new Set(['received', 'considered']);
const PROMISES: ReadonlySet<RequestStatus> = new Set(['next-movement', 'fork-option']);
const AWAITING_SECTION: ReadonlySet<RequestStatus> = new Set(['planned', 'next-movement', 'fork-option']);
const TERMINAL: ReadonlySet<RequestStatus> = new Set(['merged', 'declined', 'played', 'expired']);

export interface RequestRecord {
  id: string;
  key: string;
  /** The first author's sanitised text (reaches the composer inside an untrusted-data block). */
  text: string;
  createdAt: number;
  status: RequestStatus;
  publicReply: string | null;
  sectionId: string | null;
  decidedAt: number | null;
  /** Everyone who asked for it, with their own wording. */
  supporters: Map<string, { at: number; text: string }>;
  shownAt: number | null;
  notedUnseen: boolean;
  surged: boolean;
}

export type WeightOf = (listenerId: string) => number;

export class RequestBook {
  readonly #prefix = randomBytes(3).readUIntBE(0, 3).toString(36).slice(0, 4);
  #seq = 0;
  readonly #records = new Map<string, RequestRecord>();
  /** Merge key → id of the open (non-terminal) request with that key. */
  readonly #open = new Map<string, string>();
  /** Listener → ids of the requests they support, so cards never scan the whole book. */
  readonly #bySupporter = new Map<string, Set<string>>();
  /** Creation order, which breaks ties among a listener's own cards. */
  readonly #order = new WeakMap<RequestRecord, number>();
  /** Decided requests with a public reply, latest decision first (creation order on ties); null after a change. */
  #public: RequestRecord[] | null = null;

  has(id: string): boolean {
    return this.#records.has(id);
  }

  get(id: string): RequestRecord | undefined {
    return this.#records.get(id);
  }

  /** `text` must already be sanitised (sanitizeRequestText) and non-empty. */
  submit(listenerId: string, text: string, nowMs: number): { record: RequestRecord; merged: boolean } {
    const key = requestMergeKey(text) || text.toLowerCase();
    const openId = this.#open.get(key);
    const open = openId ? this.#records.get(openId) : undefined;
    if (open) {
      open.supporters.set(listenerId, { at: nowMs, text });
      this.#supports(listenerId, open.id);
      return { record: open, merged: true };
    }
    const seq = this.#seq++;
    const record: RequestRecord = {
      id: `rq-${this.#prefix}${seq.toString(36)}`,
      key,
      text,
      createdAt: nowMs,
      status: 'received',
      publicReply: null,
      sectionId: null,
      decidedAt: null,
      supporters: new Map([[listenerId, { at: nowMs, text }]]),
      shownAt: null,
      notedUnseen: false,
      surged: false,
    };
    this.#records.set(record.id, record);
    this.#order.set(record, seq);
    this.#open.set(key, record.id);
    this.#supports(listenerId, record.id);
    this.#prune();
    return { record, merged: false };
  }

  /** Σ w · exp(−age / 6 min) over supporters, with their current weights. */
  support(record: RequestRecord, weightOf: WeightOf, nowMs: number): number {
    let total = 0;
    for (const [listenerId, s] of record.supporters) total += weightOf(listenerId) * Math.exp(-Math.max(0, nowMs - s.at) / P.supportTauMs);
    return total;
  }

  undecided(): RequestRecord[] {
    return [...this.#records.values()].filter((r) => UNDECIDED.has(r.status));
  }

  waiting(): number {
    let n = 0;
    for (const r of this.#records.values()) if (UNDECIDED.has(r.status)) n++;
    return n;
  }

  /** The top undecided requests by support, for a turn context. Changes nothing. */
  top(weightOf: WeightOf, nowMs: number): CrowdSummary['requests'] {
    return this.undecided()
      .map((r) => ({ r, support: this.support(r, weightOf, nowMs) }))
      .sort((a, b) => b.support - a.support || a.r.createdAt - b.r.createdAt)
      .slice(0, P.topK)
      .map(({ r, support }) => ({
        id: r.id,
        text: r.text,
        support: Math.round(support * 100) / 100,
        supporters: r.supporters.size,
        ageSec: Math.round((nowMs - r.createdAt) / 1000),
      }));
  }

  /** A composer was shown these: undecided ones count as seen, and 'received' → 'considered'. Returns those whose status changed. */
  markShown(ids: Iterable<string>, nowMs: number): RequestRecord[] {
    const changed: RequestRecord[] = [];
    for (const id of new Set(ids)) {
      const r = this.#records.get(id);
      if (!r || !UNDECIDED.has(r.status)) continue;
      r.shownAt ??= nowMs;
      if (r.status === 'received') {
        r.status = 'considered';
        changed.push(r);
      }
    }
    return changed;
  }

  promises(nowMs: number): CrowdSummary['promises'] {
    return [...this.#records.values()]
      .filter((r) => PROMISES.has(r.status) && r.sectionId === null)
      .map((r) => ({
        id: r.id,
        decision: r.status as 'next-movement' | 'fork-option',
        publicReply: r.publicReply ?? '',
        ageSec: Math.round((nowMs - r.createdAt) / 1000),
      }));
  }

  decide(d: { requestId: string; status: RequestStatus; publicReply: string; sectionId: string | null }, nowMs: number): RequestRecord | null {
    const r = this.#records.get(d.requestId);
    if (!r) return null;
    this.#setStatus(r, d.status);
    r.publicReply = sanitizePlainText(d.publicReply, 140) || null;
    r.sectionId = d.sectionId;
    r.decidedAt = nowMs;
    this.#public = null;
    return r;
  }

  /** Requests realised by a section move to 'playing' when it starts and 'played' when it ends. */
  markSection(sectionId: string, phase: 'playing' | 'played'): RequestRecord[] {
    const changed: RequestRecord[] = [];
    for (const r of this.#records.values()) {
      if (r.sectionId !== sectionId) continue;
      if (phase === 'playing' ? AWAITING_SECTION.has(r.status) : r.status === 'playing') {
        this.#setStatus(r, phase);
        changed.push(r);
      }
    }
    return changed;
  }

  /** Undecided after 15 min, or decided but never realised after 45 min → expired. */
  expire(nowMs: number): RequestRecord[] {
    const changed: RequestRecord[] = [];
    for (const r of this.#records.values()) {
      const undecidedTooLong = UNDECIDED.has(r.status) && nowMs - r.createdAt > P.expireMs;
      const promiseTooLong = (AWAITING_SECTION.has(r.status) || r.status === 'playing') && nowMs - (r.decidedAt ?? r.createdAt) > P.promiseExpireMs;
      if (undecidedTooLong || promiseTooLong) {
        this.#setStatus(r, r.status === 'playing' ? 'played' : 'expired');
        changed.push(r);
      }
    }
    return changed;
  }

  /** Undecided requests the composer has not been shown for 5 minutes (each reported once). */
  unseen(nowMs: number): RequestRecord[] {
    const out: RequestRecord[] = [];
    for (const r of this.#records.values()) {
      if (UNDECIDED.has(r.status) && r.shownAt === null && !r.notedUnseen && nowMs - r.createdAt > P.unseenNoteMs) {
        r.notedUnseen = true;
        out.push(r);
      }
    }
    return out;
  }

  /**
   * The listener's own requests (with their own wording, newest first) plus up to 20 public decided
   * ones they don't support. Costs the listener's own requests plus a walk down the public list, so
   * sending everyone their cards doesn't scan the book once per listener.
   */
  cardsFor(listenerId: string): RequestCard[] {
    const own: { r: RequestRecord; at: number; text: string }[] = [];
    for (const id of this.#bySupporter.get(listenerId) ?? []) {
      const r = this.#records.get(id);
      const mine = r?.supporters.get(listenerId);
      if (r && mine) own.push({ r, ...mine });
    }
    own.sort((a, b) => b.at - a.at || this.#order.get(a.r)! - this.#order.get(b.r)!);
    const cards = own.slice(0, P.ownCards).map(({ r, text, at }) => toCard(r, text, at));
    let publicCards = 0;
    for (const r of this.#publicList()) {
      if (publicCards >= P.publicCards) break;
      if (r.supporters.has(listenerId)) continue;
      cards.push(toCard(r, null, r.createdAt));
      publicCards++;
    }
    return cards;
  }

  forget(listenerId: string): void {
    const ids = this.#bySupporter.get(listenerId);
    if (!ids) return;
    for (const id of ids) {
      const r = this.#records.get(id);
      if (r && !TERMINAL.has(r.status)) continue;
      r?.supporters.delete(listenerId);
      ids.delete(id);
    }
    if (!ids.size) this.#bySupporter.delete(listenerId);
  }

  #supports(listenerId: string, id: string): void {
    const ids = this.#bySupporter.get(listenerId) ?? new Set<string>();
    ids.add(id);
    this.#bySupporter.set(listenerId, ids);
  }

  #publicList(): RequestRecord[] {
    this.#public ??= [...this.#records.values()].filter((r) => r.publicReply !== null && r.decidedAt !== null).sort((a, b) => b.decidedAt! - a.decidedAt!);
    return this.#public;
  }

  #delete(r: RequestRecord): void {
    this.#records.delete(r.id);
    for (const listenerId of r.supporters.keys()) {
      const ids = this.#bySupporter.get(listenerId);
      if (ids?.delete(r.id) && ids.size === 0) this.#bySupporter.delete(listenerId);
    }
    this.#public = null;
  }

  #setStatus(r: RequestRecord, status: RequestStatus): void {
    r.status = status;
    if (TERMINAL.has(status) && this.#open.get(r.key) === r.id) this.#open.delete(r.key);
  }

  /** Bounded memory: the oldest finished requests go first. */
  #prune(): void {
    if (this.#records.size <= P.maxKept) return;
    for (const r of this.#records.values()) {
      if (this.#records.size <= P.maxKept) break;
      if (TERMINAL.has(r.status)) this.#delete(r);
    }
    // Everything open: drop the oldest regardless.
    for (const r of this.#records.values()) {
      if (this.#records.size <= P.maxKept) break;
      this.#setStatus(r, 'expired');
      this.#delete(r);
    }
  }
}

function toCard(r: RequestRecord, ownText: string | null, createdAt: number): RequestCard {
  return {
    id: r.id,
    mine: ownText !== null,
    text: ownText,
    status: r.status,
    supporters: r.supporters.size,
    publicReply: r.publicReply,
    sectionId: r.sectionId,
    createdAt,
  };
}
