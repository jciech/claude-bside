import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hash2code } from '@strudel/core';
import { bakeKnobs, mapsForSounds, sampleLines, strudelProgram, strudelUrl, STRUDEL_URL } from '../../src/client/ui/export.ts';
import type { Catalog } from '../../src/shared/catalog.ts';
import { parseCatalog } from '../../src/strudel/catalog.ts';
import { validatePart } from '../../src/strudel/validate.ts';
import { snapshot } from '../engine/fixtures.ts';

const catalog: Catalog = parseCatalog(JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8')));

describe('export to strudel.cc', () => {
  it('bakes declared knobs into numbers and leaves the rest alone', () => {
    const knobs = [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' as const }];
    expect(bakeKnobs('.lpf(knob("cut"))', knobs)).toBe('.lpf(800)');
    expect(bakeKnobs(".lpf(knob('cut'))", [{ ...knobs[0]!, default: 1234.56789 }])).toBe('.lpf(1234.5679)');
    expect(bakeKnobs('.lpf(knob("other"))', knobs)).toBe('.lpf(knob("other"))');
  });

  it('adds samples() only for maps strudel.cc does not preload, pinned to the commit', () => {
    const lines = sampleLines([
      { id: 'vcsl', kind: 'samples', path: '', upstream: 'sgossner/VCSL@c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e', license: '', order: 4 },
      { id: 'switchangel-breaks', kind: 'samples', path: '', upstream: 'switchangel/breaks@13784b105c6f55eb20653a510f70e6df1f1b6e32', license: '', order: 7 },
      { id: 'weird', kind: 'samples', path: '', upstream: 'not a repo', license: '', order: 9 },
    ]);
    expect(lines).toEqual(["samples('github:switchangel/breaks/13784b105c6f55eb20653a510f70e6df1f1b6e32')"]);
  });

  it('finds the maps behind the sounds a section plays', () => {
    const sample = catalog.sounds.find((s) => s.kind === 'sample');
    if (!sample) return;
    const maps = mapsForSounds(catalog, [sample.id, 'no-such-sound']);
    expect(maps.map((m) => m.id)).toEqual([sample.source]);
  });

  it('writes a program whose parts are still valid Strudel, and a URL strudel.cc can decode', () => {
    const section = snapshot.sections[0]!;
    const program = strudelProgram({
      title: 'First\nLight', // a newline must never escape the comment
      side: 'A',
      track: 1,
      bpm: 120,
      parts: section.parts.map((p) => ({ id: p.id, code: p.code, level: p.level, knobs: p.knobs })),
      maps: [],
      sourceUrl: 'https://example.org/src',
    });
    expect(program.split('\n')[0]).toBe('// "First Light" — Side A, track 1, cut live by Claude in B-Side');
    expect(program).toContain('setcpm(120/4)');
    expect(program).not.toContain('knob(');
    expect(program).toContain('bass: n("<0 3 5 2>")');
    const url = strudelUrl(program);
    expect(url.startsWith(`${STRUDEL_URL}#`)).toBe(true);
    expect(hash2code(url.slice(STRUDEL_URL.length + 1))).toBe(program);
    for (const p of section.parts) {
      const baked = bakeKnobs(p.code, p.knobs);
      expect(validatePart(baked, { knobs: [] }).errors).toEqual([]);
    }
  });
});
