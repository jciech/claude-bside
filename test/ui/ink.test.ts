import { describe, expect, it } from 'vitest';
import { freshInk } from '../../src/client/ui/ink.ts';

const inked = (prev: string | null, next: string) => freshInk(prev, next).map((r) => next.slice(r.start, r.end));

describe('freshInk', () => {
  it('inks nothing when the code is carried unchanged', () => {
    expect(freshInk('s("bd*4")', 's("bd*4")')).toEqual([]);
  });

  it('inks a whole new part, without its surrounding whitespace', () => {
    expect(inked(null, '  s("bd*4")\n')).toEqual(['s("bd*4")']);
  });

  it('inks changed numbers and atoms as whole tokens', () => {
    const prev = 's("white*8")\n  .hpf(7000)\n  .decay(0.03)';
    const next = 's("white*16")\n  .hpf(8000)\n  .decay(0.03)';
    expect(inked(prev, next)).toEqual(['16', '8000']);
  });

  it('inks an added method call as one mark', () => {
    const prev = 'n("0 2 4")\n  .s("sawtooth")';
    const next = 'n("0 2 4")\n  .s("sawtooth")\n  .lpf(800)';
    expect(inked(prev, next)).toEqual(['.lpf(800)']);
  });

  it('keeps marks on separate lines apart', () => {
    const prev = 'note("c3")\n  .gain(0.5)';
    const next = 'note("e3")\n  .gain(0.7)';
    expect(inked(prev, next)).toEqual(['e3', '0.7']);
  });

  it('ranges always lie inside the new code', () => {
    const next = 's("bd ~ sd ~")\n  .bank("RolandTR909")';
    for (const r of freshInk('s("hh*8")', next)) {
      expect(r.start).toBeGreaterThanOrEqual(0);
      expect(r.end).toBeLessThanOrEqual(next.length);
      expect(r.end).toBeGreaterThan(r.start);
    }
  });
});
