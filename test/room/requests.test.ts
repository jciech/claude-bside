import { describe, expect, it } from 'vitest';
import type { RequestCard, RequestStatus } from '../../src/shared/protocol.ts';
import { CROWD } from '../../src/server/room/params.ts';
import { RequestBook, type RequestRecord } from '../../src/server/room/requests.ts';

function lcg(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** The cards as a full scan of the book in creation order would give them. */
function scannedCards(records: RequestRecord[], listenerId: string): RequestCard[] {
  const card = (r: RequestRecord, text: string | null, createdAt: number): RequestCard => ({
    id: r.id,
    mine: text !== null,
    text,
    status: r.status,
    supporters: r.supporters.size,
    publicReply: r.publicReply,
    sectionId: r.sectionId,
    createdAt,
  });
  const own: RequestCard[] = [];
  const decided: RequestRecord[] = [];
  for (const r of records) {
    const mine = r.supporters.get(listenerId);
    if (mine) own.push(card(r, mine.text, mine.at));
    else if (r.publicReply !== null && r.decidedAt !== null) decided.push(r);
  }
  own.sort((a, b) => b.createdAt - a.createdAt);
  decided.sort((a, b) => b.decidedAt! - a.decidedAt!);
  return [...own.slice(0, CROWD.requests.ownCards), ...decided.slice(0, CROWD.requests.publicCards).map((r) => card(r, null, r.createdAt))];
}

describe('request cards', () => {
  it('match a full scan of the book through submit, decide, sections, expiry, forgetting and pruning', () => {
    const rnd = lcg(42);
    const book = new RequestBook();
    const ids: string[] = [];
    const listeners = Array.from({ length: 12 }, (_, i) => `listener-${i}`);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const statuses: RequestStatus[] = ['planned', 'next-movement', 'declined', 'merged', 'fork-option'];
    let t = 1_000_000;
    const check = () => {
      const records = ids.map((id) => book.get(id)).filter((r): r is RequestRecord => r !== undefined);
      for (const l of [...listeners, 'stranger']) expect(book.cardsFor(l)).toEqual(scannedCards(records, l));
    };
    for (let step = 0; step < 4200; step++) {
      // Coarse time: many submissions and decisions share a millisecond.
      if (rnd() < 0.3) t += 1000;
      const roll = rnd();
      if (roll < 0.6) {
        const { record, merged } = book.submit(pick(listeners), `wish ${Math.floor(rnd() * (step < 200 ? 40 : 4000))}`, t);
        if (!merged) ids.push(record.id);
      } else if (roll < 0.85 && ids.length) {
        const id = pick(ids);
        book.decide({ requestId: id, status: pick(statuses), publicReply: rnd() < 0.8 ? `reply ${id}` : '', sectionId: rnd() < 0.5 ? `ep-${Math.floor(rnd() * 5)}` : null }, t);
      } else if (roll < 0.9) {
        book.markSection(`ep-${Math.floor(rnd() * 5)}`, rnd() < 0.5 ? 'playing' : 'played');
      } else if (roll < 0.95) {
        book.expire(t + Math.floor(rnd() * 60 * 60_000));
      } else {
        book.forget(pick(listeners));
      }
      if (step % 131 === 0) check();
    }
    expect(ids.length).toBeGreaterThan(CROWD.requests.maxKept);
    check();
  });

  it('cost the same per listener however many decided requests the book holds', () => {
    const decidedBook = (n: number) => {
      const book = new RequestBook();
      for (let i = 0; i < n; i++) {
        const { record } = book.submit(`author-${i}`, `wish ${i}`, 1000 + i);
        book.decide({ requestId: record.id, status: 'declined', publicReply: `reply ${i}`, sectionId: null }, 5000 + i);
      }
      return book;
    };
    const timeFor = (book: RequestBook) => {
      for (let i = 0; i < 200; i++) book.cardsFor(`warm-${i}`);
      const start = performance.now();
      for (let i = 0; i < 2000; i++) book.cardsFor(`listener-${i}`);
      return performance.now() - start;
    };
    const small = decidedBook(40);
    const full = decidedBook(CROWD.requests.maxKept);
    expect(full.cardsFor('someone')).toHaveLength(CROWD.requests.publicCards);
    // A full scan and sort per listener would make the full book ~50× slower than the small one.
    const ratio = Math.min(...[0, 1, 2].map(() => timeFor(full) / timeFor(small)));
    expect(ratio).toBeLessThan(8);
  });
});
