// Registers the catalog's sounds in a fixed order so `s("bd:3")` means the same file for every
// listener and for the validator (ARCHITECTURE §10): synths and zzfx, GM soundfonts from the
// commit-pinned soundfontBase, then sample maps fetched in parallel from our server but registered
// sequentially in catalog order (superdough's registerSound overwrites, so fetch-completion order
// would otherwise decide who owns shared names), with bank aliases at their catalog position.
import { aliasBank, registerSynthSounds, registerZZFXSounds, samples } from '@strudel/webaudio';
import { registerSoundfonts, setSoundfontUrl } from '@strudel/soundfonts';
import type { Catalog } from '../../shared/catalog.ts';
import { parseCatalog } from '../../strudel/catalog.ts';
import { fetchWithRetry } from './fetch.ts';

export async function loadCatalog(url: string): Promise<Catalog> {
  const res = await fetchWithRetry(url);
  return parseCatalog(await res.json());
}

/** Registers every sound; resolves with the ids of maps that could not be fetched. */
export async function registerSounds(catalog: Catalog, resolveUrl: (path: string) => string = (p) => p): Promise<string[]> {
  registerSynthSounds();
  registerZZFXSounds();
  setSoundfontUrl(catalog.soundfontBase);
  registerSoundfonts();
  const maps = [...catalog.maps].sort((a, b) => a.order - b.order);
  const fetched = await Promise.all(
    maps.map((m) =>
      fetchWithRetry(resolveUrl(m.path))
        .then((r) => r.json() as Promise<Record<string, unknown>>)
        .catch(() => null),
    ),
  );
  const failed: string[] = [];
  for (let i = 0; i < maps.length; i++) {
    const map = maps[i]!;
    const json = fetched[i];
    if (!json) {
      failed.push(map.id);
      continue;
    }
    if (map.kind === 'bank-aliases') aliasBank(json);
    else await samples(json, typeof json._base === 'string' ? json._base : '');
  }
  return failed;
}
