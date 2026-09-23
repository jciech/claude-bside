import { describe, expect, it } from 'vitest';
import { atomLocations, segmentPart } from '../../src/client/ui/segments.ts';
import { compilePart } from '../../src/strudel/compile.ts';
import { snapshot } from '../engine/fixtures.ts';

describe('code view segments', () => {
  it('reproduces the text exactly, label first', () => {
    const code = 's("sbd*4")\n  .decay(0.35)';
    const segs = segmentPart('kick', code, atomLocations(code), []);
    expect(segs.map((s) => s.text).join('')).toBe(`kick: ${code}`);
    expect(segs[0]).toMatchObject({ text: 'kick: ', cls: 'label' });
  });

  it('keys atoms by the same offsets the engine compiles with (hap locations)', () => {
    for (const section of snapshot.sections) {
      for (const part of section.parts) {
        const knob = () => 0;
        const engineLocs = compilePart(part.code, { knob }).miniLocations.map((l) => `${l.start}:${l.end}`).sort();
        const viewLocs = atomLocations(part.code).map((l) => `${l.start}:${l.end}`).sort();
        expect(viewLocs).toEqual(engineLocs);
        const keyed = new Set(segmentPart(part.id, part.code, atomLocations(part.code), []).flatMap((s) => (s.atom ? [s.atom] : [])));
        expect([...keyed].sort()).toEqual([...new Set(engineLocs)].sort());
      }
    }
  });

  it('lights sound and note strings fully; other mini strings only underline', () => {
    const code = 's("white*16")\n  .decay("0.02 0.05")';
    const segs = segmentPart('hats', code, atomLocations(code), []);
    const atom = (text: string) => segs.find((s) => s.text === text && s.atom);
    expect(atom('white')?.primary).toBe(true);
    expect(atom('16')?.primary).toBe(true);
    expect(atom('0.02')?.primary).toBe(false);
  });

  it('marks fresh ink on exactly the given range', () => {
    const code = '.hpf(8000)';
    const segs = segmentPart('hats', code, [], [{ start: 5, end: 9 }]);
    expect(segs.filter((s) => s.fresh).map((s) => s.text)).toEqual(['8000']);
  });

  it('survives code that does not parse', () => {
    const code = 's("bd*4"';
    expect(segmentPart('x', code, atomLocations(code), []).map((s) => s.text).join('')).toBe(`x: ${code}`);
  });
});
