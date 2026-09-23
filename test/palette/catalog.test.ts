import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKED_SOUNDS, CATALOG_URL } from '../../src/shared/catalog.ts';
import type { Catalog, CatalogSound } from '../../src/shared/catalog.ts';
import { BUILTIN_SOURCE, FAMILIES, PINNED, SOUNDFONT_BASE, SOUNDFONT_SOURCE, SOURCES, registeredNames } from '../../scripts/build-catalog.ts';
import { catalogProblems } from './validate.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const catalog = read('palette/catalog.json') as Catalog;
const fixture = read('test/fixtures/catalog.small.json') as Catalog;
const byId = new Map(catalog.sounds.map((s) => [s.id, s]));
const PINNED_RAW = /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/[0-9a-f]{40}\//;

type SampleMap = Record<string, unknown>;
const vendored = catalog.maps.map((map) => ({ map, json: read(map.path.replace(/^\//, '')) as SampleMap }));

describe('palette/catalog.json', () => {
  it('satisfies the Catalog contract', () => {
    expect(catalogProblems(catalog)).toEqual([]);
    expect(CATALOG_URL).toBe('/palette/catalog.json');
  });

  it('has unique ids, and aliases that name nothing else', () => {
    const ids = catalog.sounds.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const aliases = catalog.sounds.flatMap((s) => s.aliases ?? []);
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const alias of aliases) expect(byId.has(alias), alias).toBe(false);
  });

  it('uses only the closed family list, with categories from the taxonomy', () => {
    for (const sound of catalog.sounds) expect(FAMILIES[sound.family], `${sound.id}: ${sound.family}`).toBeDefined();
  });

  it('documents every family and every source in palette/README.md', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'palette/README.md'), 'utf8');
    for (const family of Object.keys(FAMILIES)) expect(readme, family).toContain(`\`${family}\``);
    for (const map of catalog.maps) expect(readme, map.id).toContain(`\`${map.id}\``);
    for (const [repo, sha] of Object.entries(PINNED)) expect(readme, repo).toContain(sha);
  });

  it('excludes blocked sounds', () => {
    for (const blocked of BLOCKED_SOUNDS) {
      expect(byId.has(blocked), blocked).toBe(false);
      expect(catalog.sounds.some((s) => s.aliases?.includes(blocked)), blocked).toBe(false);
    }
  });

  it('pins every map, sample base and the soundfont base to a commit', () => {
    expect(catalog.soundfontBase).toBe(SOUNDFONT_BASE);
    expect(`${catalog.soundfontBase}/`).toMatch(PINNED_RAW);
    for (const { map, json } of vendored) {
      expect(map.upstream, map.id).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      if (map.kind === 'bank-aliases') {
        expect(json._base, map.id).toBeUndefined();
        continue;
      }
      expect(json._base, map.id).toMatch(PINNED_RAW);
      for (const [key, value] of Object.entries(json)) {
        if (key === '_base') continue;
        const files = typeof value === 'string' ? [value] : Array.isArray(value) ? value : Object.values(value as SampleMap).flat();
        for (const file of files) expect(String(file), `${map.id}/${key}`).not.toMatch(/^[a-z]+:|^\/\//i);
        if (!Array.isArray(value) && typeof value === 'object') expect((value as SampleMap)._base, `${map.id}/${key}`).toBeUndefined();
      }
    }
  });

  it('registers maps in a fixed order with the bank aliases right after the drum machines', () => {
    expect(catalog.maps.map((m) => m.order)).toEqual(catalog.maps.map((_, i) => i + 1));
    expect(catalog.maps.map((m) => m.id)).toEqual(SOURCES.map((s) => s.id));
    const ids = catalog.maps.map((m) => m.id);
    expect(ids.indexOf('tidal-drum-machines-alias')).toBe(ids.indexOf('tidal-drum-machines') + 1);
    for (const map of catalog.maps) expect(map.path).toBe(`/palette/maps/${map.id}.json`);
  });

  it('has no name collisions across maps, synths, soundfonts and derived bank aliases', () => {
    const { owners, aliases } = registeredNames(vendored.map(({ map, json }) => ({ spec: map, json })));
    // Every registered name is a catalog sound or a documented alias of one (blocked synths aside).
    const known = new Set([...byId.keys(), ...catalog.sounds.flatMap((s) => s.aliases ?? [])]);
    for (const name of owners.keys()) if (!BLOCKED_SOUNDS.has(name)) expect(known.has(name), name).toBe(true);
    for (const [target, names] of aliases) expect(byId.get(target)?.aliases, target).toEqual(expect.arrayContaining(names));
  });

  it('detects a collision between maps', () => {
    const maps = [
      { spec: { id: 'a', kind: 'samples' as const }, json: { _base: 'x', kick: ['k.wav'] } },
      { spec: { id: 'b', kind: 'samples' as const }, json: { _base: 'y', Kick: ['k2.wav'] } },
    ];
    expect(() => registeredNames(maps)).toThrow(/"kick" is registered by both a and b/);
    const aliasClash = [
      { spec: { id: 'm', kind: 'samples' as const }, json: { _base: 'x', Box_bd: ['a.wav'], bx_bd: ['b.wav'] } },
      { spec: { id: 'al', kind: 'bank-aliases' as const }, json: { Box: 'BX' } },
    ];
    expect(() => registeredNames(aliasClash)).toThrow(/"bx_bd"/);
  });

  it('lists every vendored sample key as a sound from that map', () => {
    for (const { map, json } of vendored) {
      if (map.kind !== 'samples') continue;
      for (const key of Object.keys(json)) {
        if (key === '_base') continue;
        expect(byId.get(key.toLowerCase())?.source, `${map.id}/${key}`).toBe(map.id);
      }
    }
    const sources = new Set([BUILTIN_SOURCE, SOUNDFONT_SOURCE, ...catalog.maps.filter((m) => m.kind === 'samples').map((m) => m.id)]);
    for (const sound of catalog.sounds) expect(sources.has(sound.source), sound.id).toBe(true);
  });

  it('describes drum-machine sounds as bank + instrument', () => {
    const machines = catalog.sounds.filter((s) => s.family.startsWith('drum-machine/'));
    expect(machines.length).toBeGreaterThan(600);
    for (const sound of machines) {
      expect(sound.machine, sound.id).toBe(sound.usage.bank);
      expect(`${sound.usage.bank}_${sound.usage.s}`.toLowerCase()).toBe(sound.id);
    }
    expect(byId.get('rolandtr909_bd')?.aliases).toEqual(['tr909_bd']);
  });

  it('gives every GM soundfont a playable range and nothing else one', () => {
    const fonts = catalog.sounds.filter((s) => s.kind === 'soundfont');
    expect(fonts).toHaveLength(125);
    for (const sound of catalog.sounds) {
      if (sound.kind !== 'soundfont') {
        expect(sound.range, sound.id).toBeUndefined();
        continue;
      }
      const [lo, hi] = sound.range!;
      expect(lo, sound.id).toBeGreaterThanOrEqual(21);
      expect(hi, sound.id).toBeLessThanOrEqual(108);
      expect(hi - lo, sound.id).toBeGreaterThanOrEqual(12);
    }
    // Known unplayable zones (research scan): vibraphone D6+ hangs, contrabass has nothing below C1.
    expect(byId.get('gm_vibraphone')!.range![1]).toBeLessThan(86);
    expect(byId.get('gm_contrabass')!.range![0]).toBeGreaterThanOrEqual(24);
    // Upstream gm.mjs names three presets that don't exist.
    expect(catalog.sounds.filter((s) => s.failingVariants).map((s) => [s.id, s.failingVariants])).toEqual([
      ['gm_electric_bass_finger', [1]],
      ['gm_slap_bass_2', [2]],
      ['gm_gunshot', [11]],
    ]);
    for (const sound of catalog.sounds) expect(sound.tags, sound.id).not.toMatch(/n=\d+ fails/);
  });

  it('has measured levels for the sounds the analyzer leans on most', () => {
    const mustMeasure = (s: CatalogSound): boolean =>
      s.kind === 'synth' ||
      s.kind === 'soundfont' ||
      (s.family.startsWith('drum-machine/') && ['bd', 'sd', 'hh', 'cp'].includes(s.usage.s)) ||
      (s.source === 'vcsl' && s.pitched);
    const missing = catalog.sounds.filter((s) => mustMeasure(s) && !s.level).map((s) => s.id);
    expect(missing).toEqual([]);
    for (const sound of catalog.sounds) {
      if (!sound.level) continue;
      expect(sound.level.peakDb, sound.id).toBeLessThanOrEqual(12);
      expect(sound.level.rmsDb, sound.id).toBeGreaterThan(-90);
      expect(sound.level.centroidHz, sound.id).toBeGreaterThan(0);
    }
  });

  it('keeps usage consistent with ids and pitch semantics', () => {
    for (const sound of catalog.sounds) {
      if (!sound.usage.bank) expect(sound.usage.s.toLowerCase(), sound.id).toBe(sound.id);
      if (sound.kind === 'soundfont' || sound.kind === 'wavetable') expect(sound.pitched, sound.id).toBe(true);
    }
  });
});

describe('test/fixtures/catalog.small.json', () => {
  it('satisfies the Catalog contract', () => {
    expect(catalogProblems(fixture)).toEqual([]);
  });

  it('is a consistent sample of the real catalog', () => {
    for (const sound of fixture.sounds) {
      const real = byId.get(sound.id);
      expect(real, sound.id).toBeDefined();
      const pick = (s: CatalogSound) => ({ label: s.label, kind: s.kind, category: s.category, family: s.family, usage: s.usage, pitched: s.pitched, source: s.source, machine: s.machine });
      expect(pick(sound), sound.id).toEqual(pick(real!));
    }
    const realMaps = new Map(catalog.maps.map((m) => [m.id, m]));
    for (const map of fixture.maps) {
      expect(realMaps.get(map.id)?.kind, map.id).toBe(map.kind);
      expect(realMaps.get(map.id)?.path, map.id).toBe(map.path);
    }
    expect(fixture.soundfontBase).toBe(catalog.soundfontBase);
  });
});
