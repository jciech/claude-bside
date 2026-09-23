import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSoundIndex, parseCatalog, resolvedName } from '../../src/strudel/catalog.ts';

const raw = () => JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'));

describe('parseCatalog', () => {
  it('accepts the fixture and keeps unknown fields', () => {
    const json = raw();
    json.sounds[0].extra = 'kept';
    const catalog = parseCatalog(json);
    expect(catalog.sounds).toHaveLength(json.sounds.length);
    expect((catalog.sounds[0] as unknown as { extra: string }).extra).toBe('kept');
  });

  it.each([
    ['a missing field', (c: any) => delete c.sounds[0].label, /sounds\.0\.label/],
    ['an unknown category', (c: any) => (c.sounds[0].category = 'drums'), /sounds\.0\.category/],
    ['an upper-case id', (c: any) => (c.sounds[0].id = 'Sine'), /must be lower-case/],
    ['an alias that collides with an id', (c: any) => (c.sounds.find((s: any) => s.id === 'rolandtr909_bd').aliases = ['bd']), /"bd" belongs to both/],
    ['usage that does not resolve to the id', (c: any) => (c.sounds.find((s: any) => s.id === 'rolandtr909_hh').usage.bank = 'RolandTR808'), /resolves to "rolandtr808_hh"/],
    ['a reversed range', (c: any) => (c.sounds.find((s: any) => s.kind === 'soundfont').range = [90, 20]), /reversed/],
    ['duplicate map orders', (c: any) => (c.maps[1].order = c.maps[0].order), /orders must be unique/],
  ])('rejects %s', (_label, mutate, message) => {
    const json = raw();
    mutate(json);
    expect(() => parseCatalog(json)).toThrow(message);
  });

  it('rejects non-objects', () => {
    expect(() => parseCatalog(null)).toThrow(/Invalid catalog/);
  });
});

describe('createSoundIndex', () => {
  const index = createSoundIndex(parseCatalog(raw()));

  it('resolves like superdough: bank_s, lower-cased', () => {
    expect(resolvedName('bd', 'RolandTR909')).toBe('rolandtr909_bd');
    expect(index.resolve('bd', 'RolandTR909')?.label).toBe('TR-909 kick');
    expect(index.resolve('BD', 'rolandtr909')?.id).toBe('rolandtr909_bd');
    expect(index.resolve('bd')?.id).toBe('bd');
    expect(index.resolve('bd', 'RolandTR808')).toBeUndefined();
  });

  it('finds bank aliases', () => {
    expect(index.resolve('bd', 'tr909')?.id).toBe('rolandtr909_bd');
    expect(index.get('TR909_BD')?.id).toBe('rolandtr909_bd');
  });

  it('lists registered ids once', () => {
    const ids = index.ids();
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('gm_epiano1');
    expect(ids).not.toContain('tr909_bd');
  });
});
