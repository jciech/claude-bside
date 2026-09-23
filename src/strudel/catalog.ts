// Catalog parsing and sound lookup, resolving names exactly like superdough: `bank` is applied as
// `${bank}_${s}` (superdough.mjs:538-541) and lookups are lower-cased (getSound, :160-165), with
// bank aliases (aliasBank, :86-116) registered as extra names for the same sound. Pure.
import { z } from 'zod';
import { BLOCKED_SOUNDS, SOUND_CATEGORIES, type Catalog, type CatalogSound } from '../shared/catalog.ts';
import { levenshtein } from './suggest.ts';

const LevelSchema = z.object({ rmsDb: z.number(), peakDb: z.number(), centroidHz: z.number() }).nullable();

const SoundSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['synth', 'sample', 'soundfont', 'wavetable']),
  category: z.enum(SOUND_CATEGORIES),
  family: z.string().regex(/^[\w-]+\/[\w.-]+$/, 'family must look like "category/detail"'),
  tags: z.string(),
  label: z.string().min(1),
  count: z.number().int().min(0),
  pitched: z.boolean(),
  source: z.string().min(1),
  machine: z.string().optional(),
  usage: z.looseObject({ s: z.string().min(1), bank: z.string().min(1).optional() }),
  range: z.tuple([z.number(), z.number()]).optional(),
  brightness: z.number().min(0).max(1),
  level: LevelSchema,
  bytes: z.number().optional(),
  durationSec: z.number().optional(),
  aliases: z.array(z.string().min(1)).optional(),
  license: z.string(),
});

const MapSchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['samples', 'bank-aliases']),
  path: z.string().min(1),
  upstream: z.string(),
  license: z.string(),
  order: z.number(),
});

const CatalogSchema = z.looseObject({
  version: z.string().min(1),
  generatedAt: z.string(),
  soundfontBase: z.string(),
  maps: z.array(MapSchema),
  sounds: z.array(SoundSchema),
});

/** Validates a catalog (shape, lower-case ids, unique names, resolvable usage). Throws on error. */
export function parseCatalog(json: unknown): Catalog {
  const parsed = CatalogSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid catalog: ${first.join('; ')}`);
  }
  const catalog = parsed.data as unknown as Catalog;
  const names = new Map<string, string>();
  const claim = (name: string, owner: string) => {
    const prev = names.get(name);
    if (prev !== undefined && prev !== owner) throw new Error(`Invalid catalog: the name "${name}" belongs to both "${prev}" and "${owner}"`);
    names.set(name, owner);
  };
  for (const s of catalog.sounds) {
    if (s.id !== s.id.toLowerCase()) throw new Error(`Invalid catalog: sound id "${s.id}" must be lower-case`);
    claim(s.id, s.id);
    for (const a of s.aliases ?? []) claim(a.toLowerCase(), s.id);
    if (resolvedName(s.usage.s, s.usage.bank) !== s.id && !(s.aliases ?? []).some((a) => a.toLowerCase() === resolvedName(s.usage.s, s.usage.bank))) {
      throw new Error(`Invalid catalog: usage of "${s.id}" resolves to "${resolvedName(s.usage.s, s.usage.bank)}"`);
    }
    if (s.range && s.range[0] > s.range[1]) throw new Error(`Invalid catalog: range of "${s.id}" is reversed`);
  }
  const orders = catalog.maps.map((m) => m.order);
  if (new Set(orders).size !== orders.length) throw new Error('Invalid catalog: map registration orders must be unique');
  return catalog;
}

export interface SoundIndex {
  get(id: string): CatalogSound | undefined;
  resolve(s: string, bank?: string): CatalogSound | undefined;
  ids(): string[];
}

/** The name superdough looks up for `s` (and optional `bank`). */
export function resolvedName(s: string, bank?: string): string {
  return (bank ? `${bank}_${s}` : s).toLowerCase();
}

export function createSoundIndex(catalog: Catalog): SoundIndex {
  const byName = new Map<string, CatalogSound>();
  for (const s of catalog.sounds) {
    byName.set(s.id, s);
    for (const a of s.aliases ?? []) byName.set(a.toLowerCase(), s);
  }
  const ids = catalog.sounds.map((s) => s.id);
  return {
    get: (id) => byName.get(id.toLowerCase()),
    resolve: (s, bank) => byName.get(resolvedName(s, bank)),
    ids: () => [...ids],
  };
}

/** Words composers reach for → catalog `s` names. */
const SOUND_SYNONYMS: Readonly<Record<string, string[]>> = {
  kick: ['bd', 'sbd'], bassdrum: ['bd'], snare: ['sd'], hihat: ['hh'], hat: ['hh'], closedhat: ['hh'], openhat: ['oh'],
  clap: ['cp'], crash: ['cr'], ride: ['rd'], tom: ['lt', 'mt', 'ht'], cowbell: ['cb'], noise: ['white', 'pink', 'brown'],
  saw: ['sawtooth'], sin: ['sine'], tri: ['triangle'], sqr: ['square'], piano: ['piano', 'gm_acoustic_grand_piano'],
  rhodes: ['gm_epiano1'], epiano: ['gm_epiano1'], strings: ['gm_string_ensemble_1'], bass: ['gm_acoustic_bass', 'gm_synth_bass_1'],
  organ: ['gm_drawbar_organ'], pad: ['gm_pad_warm'], break: ['breaks'], amen: ['breaks'],
};

/** A repair hint for an unknown `s` (and bank): the closest catalog sounds, written as code. */
export function suggestSounds(index: SoundIndex, s: string, bank?: string): string {
  const base = s.split(':')[0]!.toLowerCase();
  if (s.includes(':') || /\s/.test(s)) {
    return `Write the sample number inside double-quoted mini-notation: s("${base}:${s.split(':')[1] ?? '0'}"), one sound per event.`;
  }
  const synonyms = Object.hasOwn(SOUND_SYNONYMS, base) ? SOUND_SYNONYMS[base]! : [];
  const scored: [number, CatalogSound][] = [];
  for (const id of index.ids()) {
    const sound = index.get(id)!;
    if (BLOCKED_SOUNDS.has(sound.id)) continue;
    const name = sound.usage.s.toLowerCase();
    const sameBank = (sound.usage.bank ?? '').toLowerCase() === (bank ?? '').toLowerCase();
    const d = synonyms.includes(name) ? (sameBank ? -1 : 0) : levenshtein(base, name) + (sameBank ? 0 : bank ? 1 : 2);
    if (d <= Math.max(2, Math.floor(base.length / 3)) + (bank ? 1 : 0)) scored.push([d, sound]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].id.localeCompare(b[1].id));
  const code = (x: CatalogSound) => (x.usage.bank ? `s("${x.usage.s}").bank("${x.usage.bank}")` : `s("${x.usage.s}")`);
  const picks = scored.slice(0, 4).map(([, x]) => code(x));
  return picks.length ? `Closest catalog sounds: ${picks.join(', ')}.` : 'Use a sound from the catalog.';
}
