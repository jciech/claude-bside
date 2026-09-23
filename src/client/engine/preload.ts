// Section preload (ARCHITECTURE §10): cold samples drop their first hit and cold GM presets their
// first note (superdough.mjs:580, sampler.mjs:296), so every section's sounds are decoded when it
// arrives — also before the unlock, into the suspended context. Each part is queried over its
// window; every hap's sound is resolved the way superdough resolves it (bank → `${bank}_${s}`,
// getSampleInfo for sample URLs, the preset for a GM note, the table for a wavetable).
// superdough caches a failed load forever, so each asset is first fetched here with retries.
import { freqToMidi, getSoundIndex, noteToMidi } from '@strudel/core';
import { getSampleInfo, getSound, loadBuffer } from '@strudel/webaudio';
import { getFontBufferSource } from '@strudel/soundfonts';
import { fetchWithRetry } from './fetch.ts';

export type AssetKind = 'sample' | 'soundfont' | 'wavetable';

export interface AssetRef {
  key: string;
  kind: AssetKind;
  /** Short human label for telemetry ("bd:3", "gm_epiano1@60"). */
  label: string;
  url: string;
  /** Soundfont preset name and MIDI note. */
  font?: string;
  midi?: number;
  /** The hap value that needs it (wavetables are warmed by triggering it silently). */
  value: Record<string, unknown>;
}

export type Resolved = { kind: 'asset'; asset: AssetRef } | { kind: 'synth' } | { kind: 'missing'; sound: string };

/** The sound name superdough looks up for a hap value. */
export function soundName(value: Record<string, unknown>): string {
  const s = typeof value.s === 'string' ? value.s : 'triangle';
  return (typeof value.bank === 'string' ? `${value.bank}_${s}` : s).toLowerCase();
}

function midiOf(value: Record<string, unknown>, fallback: number): number {
  if (typeof value.freq === 'number') return freqToMidi(value.freq);
  if (typeof value.note === 'string') return noteToMidi(value.note);
  if (typeof value.note === 'number') return value.note;
  return fallback;
}

export function resolveAsset(value: Record<string, unknown>, soundfontBase: string): Resolved {
  const name = soundName(value);
  if (['-', '~', '_'].includes(name)) return { kind: 'synth' };
  const sound = getSound(name) as { data?: { type?: string; samples?: unknown; tables?: unknown; fonts?: string[] } } | undefined;
  if (!sound) return { kind: 'missing', sound: name };
  const data = sound.data ?? {};
  const n = typeof value.n === 'number' ? value.n : 0;
  try {
    if (data.type === 'sample' && data.samples) {
      const { url, index } = getSampleInfo(value, data.samples) as { url: string; index: number };
      return { kind: 'asset', asset: { key: url, kind: 'sample', label: `${name}:${index}`, url, value } };
    }
    if (data.type === 'wavetable' && data.tables) {
      const { url } = getSampleInfo(value, data.tables) as { url: string };
      return { kind: 'asset', asset: { key: `wt:${url}`, kind: 'wavetable', label: name, url, value } };
    }
    if (data.type === 'soundfont' && data.fonts?.length) {
      const font = data.fonts[getSoundIndex(n, data.fonts.length)]!;
      const midi = midiOf(value, 48);
      return { kind: 'asset', asset: { key: `sf:${font}:${midi}`, kind: 'soundfont', label: `${name}@${Math.round(midi)}`, url: `${soundfontBase}/${font}.js`, font, midi, value } };
    }
  } catch {
    return { kind: 'missing', sound: name };
  }
  return { kind: 'synth' };
}

export interface PreloaderDeps {
  ac: () => AudioContext;
  /** Silently triggers a hap so superdough decodes a wavetable into its worklet (after initAudio). */
  warm(value: Record<string, unknown>): Promise<void>;
  concurrency?: number;
}

export class Preloader {
  private readonly deps: PreloaderDeps;
  private readonly jobs = new Map<string, Promise<boolean>>();
  private readonly fetched = new Map<string, Promise<void>>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private total = 0;
  private done = 0;

  constructor(deps: PreloaderDeps) {
    this.deps = deps;
  }

  progress(): { loaded: number; total: number } {
    return { loaded: this.done, total: this.total };
  }

  /**
   * Loads (once) and resolves true when the asset is decoded and cached. An asset whose fetch kept
   * failing never reached superdough, so a later section asking for it tries again.
   */
  load(asset: AssetRef): Promise<boolean> {
    let job = this.jobs.get(asset.key);
    if (!job) {
      this.total++;
      let reachedCache = false;
      job = this.limit(async () => {
        await this.probe(asset.url);
        reachedCache = true;
        await this.decode(asset);
      }).then(
        () => true,
        () => false,
      );
      void job.then((ok) => {
        this.done++;
        if (!ok && !reachedCache) this.jobs.delete(asset.key);
      });
      this.jobs.set(asset.key, job);
    }
    return job;
  }

  private async decode(asset: AssetRef): Promise<void> {
    const ac = this.deps.ac();
    if (asset.kind === 'sample') {
      const [s, n] = asset.label.split(':');
      await loadBuffer(asset.url, ac, s, Number(n));
    } else if (asset.kind === 'soundfont') {
      await getFontBufferSource(asset.font!, { note: asset.midi! }, ac);
    } else {
      await this.deps.warm(asset.value);
    }
  }

  /** Fetches with retries so a transient failure never reaches superdough's permanent caches. */
  private probe(url: string): Promise<void> {
    // The URL superdough's loadBuffer fetches (sampler.mjs:88, wavetable.mjs:112): a '#' in a file
    // name (dirt-samples' "mute/000_FH A#2 SCF.wav") would otherwise start a fragment.
    const target = url.replace('#', '%23');
    let p = this.fetched.get(target);
    if (!p) {
      p = fetchWithRetry(target)
        .then((r) => r.arrayBuffer())
        .then(() => undefined);
      p.catch(() => this.fetched.delete(target));
      this.fetched.set(target, p);
    }
    return p;
  }

  private limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.running++;
        task()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.queue.shift()?.();
          });
      };
      if (this.running < (this.deps.concurrency ?? 6)) run();
      else this.queue.push(run);
    });
  }
}
