// `npm run catalog [-- --measure | --offline]` — builds palette/catalog.json (src/shared/catalog.ts)
// and vendors every sample map into palette/maps/ with `_base` rewritten to commit-pinned raw GitHub
// URLs (see palette/README.md).
//
// Maps are registered in the fixed order of SOURCES; the build asserts that no two maps (nor the
// synths, the soundfonts or the names aliasBank() derives) register the same name, after the
// deliberate drops and path fixes listed in SOURCES, and that every file every map references
// resolves. Every sound gets a category, a family from the closed list in FAMILIES, curated tags and
// a label. With --measure, headless Chromium (scripts/render-audio.ts) renders each sound (gain 1, C4
// or n=0, 1 s) to measure its level and spectral centroid, and decodes every zone of every GM
// soundfont (variant 0) to find its playable range. Verifications, file sizes, zone scans and levels
// are cached in palette/levels.json, so reruns are incremental and `--offline` rebuilds the same
// catalog from the vendored maps without the network.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import * as acorn from 'acorn';
import gm from '@strudel/soundfonts/gm.mjs';
import { BLOCKED_SOUNDS } from '../src/shared/catalog.ts';
import type { Catalog, CatalogMap, CatalogSound, SoundCategory, SoundKind } from '../src/shared/catalog.ts';
import { analyzeAudio, openRenderer } from './render-audio.ts';
import type { Renderer, RenderEvent } from './render-audio.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PALETTE_DIR = path.join(REPO_ROOT, 'palette');
const RAW = 'https://raw.githubusercontent.com';

// ─── Sources ──────────────────────────────────────────────────────────────────────────────────────

/** Commits pinned with `git ls-remote https://github.com/<repo> HEAD` on 2026-09-23. */
export const PINNED = {
  'felixroos/dough-samples': '9eacfc86ec4393e68a463ff52b01c19cfaa77f38',
  'tidalcycles/Dirt-Samples': 'c74fc80f8db8038f6a33648ffef5ac00a07ad402',
  'felixroos/webaudiofontdata': '23ca907d4370a04fd89ca483a92915e4d6159ab9',
  'switchangel/breaks': '13784b105c6f55eb20653a510f70e6df1f1b6e32',
  'switchangel/pad': '4f1b7bbddc72556a4246cc24e5ef282812f44d80',
  'yaxu/clean-breaks': 'df569e8de311c8f042f6e53f89d08c6162d32c9b',
  'ritchse/tidal-drum-machines': '15eac73c5e878550f91d864a4863e014799403f1',
  'sgossner/VCSL': 'c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e',
  'yaxu/mrid': '5ba409cabb2893e6e8a52a15a2812c35585cdadb',
  'todepond/samples': 'f58b317308194e9a8523a4ccd687684375f72da5',
  'eddyflux/crate': '11c0a953128f2026b0c1c477188c49311de1bbf5',
  'tidalcycles/uzu-wavetables': '3432ce3f35746356728f9bea3fea4b76624f98cd',
  'Bubobubobubobubo/Dough-Waveforms': '125801fa9a799117fd0a0350a195ab7c2f4cdf13',
} as const;
type Repo = keyof typeof PINNED;

const pinned = (repo: Repo, file = ''): string => `${RAW}/${repo}/${PINNED[repo]}/${file}`;
const upstream = (repo: Repo): string => `${repo}@${PINNED[repo]}`;

export const SOUNDFONT_BASE = pinned('felixroos/webaudiofontdata', 'sound');

interface SourceSpec {
  id: string;
  kind: CatalogMap['kind'];
  /** Commit-pinned URL of the upstream map JSON. */
  map: string;
  /** Commit-pinned sample base written into the vendored map's `_base` (samples maps). */
  base?: string;
  /** Repository the audio comes from (the map itself may live elsewhere). */
  repo: Repo;
  license: string;
  /** Keys deliberately left out of the vendored map, with the reason. */
  drop?: Record<string, string>;
  /** Upstream path bugs corrected in the vendored map, per key: every file path goes through `path`. */
  fix?: Readonly<Record<string, { reason: string; path: (file: string) => string }>>;
}

/** Registration order. The bank-alias map must follow the drum machines (aliasBank walks registered keys). */
export const SOURCES: readonly SourceSpec[] = [
  {
    id: 'dirt-samples',
    kind: 'samples',
    map: pinned('tidalcycles/Dirt-Samples', 'strudel.json'),
    base: pinned('tidalcycles/Dirt-Samples'),
    repo: 'tidalcycles/Dirt-Samples',
    license: 'unspecified',
    drop: { sax: "collides with VCSL's pitched `sax`, which is what `s(\"sax\")` means on strudel.cc" },
    fix: {
      h: {
        reason: "two file names contain a bare '%' (\"da0-50%_1000\"), an invalid URL escape (HTTP 400 upstream)",
        path: (file) => file.replace(/%(?![0-9a-f]{2})/gi, '%25'),
      },
    },
  },
  {
    id: 'tidal-drum-machines',
    kind: 'samples',
    map: pinned('felixroos/dough-samples', 'tidal-drum-machines.json'),
    base: pinned('ritchse/tidal-drum-machines', 'machines/'),
    repo: 'ritchse/tidal-drum-machines',
    license: 'unspecified',
    drop: { OberheimDMX_: 'empty instrument name; not addressable with s()/bank()' },
  },
  {
    id: 'tidal-drum-machines-alias',
    kind: 'bank-aliases',
    map: pinned('todepond/samples', 'tidal-drum-machines-alias.json'),
    repo: 'todepond/samples',
    license: 'unspecified',
  },
  {
    id: 'vcsl',
    kind: 'samples',
    map: pinned('felixroos/dough-samples', 'vcsl.json'),
    base: pinned('sgossner/VCSL'),
    repo: 'sgossner/VCSL',
    license: 'CC0-1.0',
    fix: {
      tom_mallet: {
        reason: 'the dough-samples map drops the top-level folder, so every tom_mallet file is a 404 upstream',
        path: (file) => (file.startsWith('Struck%20Membranophones/') ? `Membranophones/${file}` : file),
      },
    },
  },
  {
    id: 'salamander-piano',
    kind: 'samples',
    map: pinned('felixroos/dough-samples', 'piano.json'),
    base: pinned('felixroos/dough-samples', 'piano/'),
    repo: 'felixroos/dough-samples',
    license: 'CC-BY-3.0',
  },
  {
    id: 'mridangam',
    kind: 'samples',
    map: pinned('felixroos/dough-samples', 'mridangam.json'),
    base: pinned('yaxu/mrid'),
    repo: 'yaxu/mrid',
    license: 'CC-BY-SA-4.0',
  },
  {
    id: 'switchangel-breaks',
    kind: 'samples',
    map: pinned('switchangel/breaks', 'strudel.json'),
    base: pinned('switchangel/breaks'),
    repo: 'switchangel/breaks',
    license: 'Unlicense',
  },
  {
    id: 'switchangel-pad',
    kind: 'samples',
    map: pinned('switchangel/pad', 'strudel.json'),
    base: pinned('switchangel/pad'),
    repo: 'switchangel/pad',
    license: 'Unlicense',
  },
  {
    id: 'clean-breaks',
    kind: 'samples',
    map: pinned('yaxu/clean-breaks', 'strudel.json'),
    base: pinned('yaxu/clean-breaks'),
    repo: 'yaxu/clean-breaks',
    license: 'unspecified',
  },
  {
    id: 'crate',
    kind: 'samples',
    map: pinned('eddyflux/crate', 'strudel.json'),
    base: pinned('eddyflux/crate'),
    repo: 'eddyflux/crate',
    license: 'unspecified',
  },
  {
    id: 'uzu-wavetables',
    kind: 'samples',
    map: pinned('tidalcycles/uzu-wavetables', 'strudel.json'),
    base: pinned('tidalcycles/uzu-wavetables'),
    repo: 'tidalcycles/uzu-wavetables',
    license: 'unspecified',
    drop: { wt_vgame: "collides with AKWF's wt_vgame (137 frames, a superset: uzu's 11 are AKWF vgame waves too)" },
  },
  {
    id: 'akwf',
    kind: 'samples',
    map: pinned('Bubobubobubobubo/Dough-Waveforms', 'strudel.json'),
    base: pinned('Bubobubobubobubo/Dough-Waveforms'),
    repo: 'Bubobubobubobubo/Dough-Waveforms',
    license: 'CC0-1.0',
  },
];

export const BUILTIN_SOURCE = 'builtin';
export const SOUNDFONT_SOURCE = 'soundfonts';

// ─── Families (closed list) ───────────────────────────────────────────────────────────────────────

interface FamilySpec {
  /** Default category; a sound may override it. */
  category: SoundCategory;
  /** Brightness prior 0..1 used when the sound wasn't measured. */
  brightness: number;
  about: string;
}

const fam = (category: SoundCategory, brightness: number, about: string): FamilySpec => ({ category, brightness, about });

export const FAMILIES: Readonly<Record<string, FamilySpec>> = {
  'synth/basic': fam('harmonic', 0.3, 'plain oscillators: sine, triangle, square, sawtooth'),
  'synth/detuned': fam('harmonic', 0.7, 'supersaw (detuned saw stack)'),
  'synth/pulse': fam('melodic', 0.55, 'pulse wave with pulse-width modulation'),
  'synth/kick': fam('percussion', 0.12, "superdough's synthesized kick (sbd)"),
  'synth/noise': fam('texture', 0.8, 'white, pink and brown noise, crackle'),
  'synth/zzfx': fam('melodic', 0.5, 'ZzFX procedural chip/sfx synths'),
  'wavetable/uzu': fam('harmonic', 0.55, 'uzu wavetables (wt_digital)'),
  'wavetable/akwf': fam('harmonic', 0.55, 'Adventure Kid single-cycle waveforms (wt_*)'),
  'drum-machine/kick': fam('percussion', 0.12, 'drum-machine bass drums (bd)'),
  'drum-machine/snare': fam('percussion', 0.55, 'drum-machine snares (sd)'),
  'drum-machine/clap': fam('percussion', 0.62, 'drum-machine claps (cp)'),
  'drum-machine/hat': fam('percussion', 0.88, 'drum-machine closed and open hats (hh, oh)'),
  'drum-machine/cymbal': fam('percussion', 0.85, 'drum-machine crashes and rides (cr, rd)'),
  'drum-machine/tom': fam('percussion', 0.3, 'drum-machine toms (ht, mt, lt)'),
  'drum-machine/rim': fam('percussion', 0.6, 'drum-machine rimshots (rim)'),
  'drum-machine/perc': fam('percussion', 0.55, 'drum-machine cowbell, shaker, tambourine, percussion (cb, sh, tb, perc)'),
  'drum-machine/fx': fam('percussion', 0.5, 'drum-machine misc and fx slots (misc, fx)'),
  'dirt/kick': fam('percussion', 0.12, 'Dirt-Samples kicks'),
  'dirt/snare': fam('percussion', 0.55, 'Dirt-Samples snares'),
  'dirt/clap': fam('percussion', 0.62, 'Dirt-Samples claps'),
  'dirt/hat': fam('percussion', 0.88, 'Dirt-Samples hats'),
  'dirt/cymbal': fam('percussion', 0.85, 'Dirt-Samples cymbals'),
  'dirt/tom': fam('percussion', 0.3, 'Dirt-Samples toms'),
  'dirt/perc': fam('percussion', 0.55, 'Dirt-Samples single percussion'),
  'dirt/kit': fam('percussion', 0.5, 'Dirt-Samples mixed kits (n picks kick/snare/hat/…)'),
  'dirt/bass': fam('bass', 0.25, 'Dirt-Samples bass hits and notes'),
  'dirt/synth': fam('melodic', 0.5, 'Dirt-Samples synth notes and hits'),
  'dirt/stab': fam('melodic', 0.55, 'Dirt-Samples stabs and hip-hop/rave snippets'),
  'dirt/toy': fam('melodic', 0.5, 'Dirt-Samples toy keyboards'),
  'dirt/instrument': fam('melodic', 0.45, 'Dirt-Samples acoustic/electric instrument notes'),
  'dirt/loop': fam('texture', 0.45, 'Dirt-Samples longer melodic or textural loops'),
  'crate/kick': fam('percussion', 0.12, 'eddyflux crate kicks'),
  'crate/snare': fam('percussion', 0.55, 'eddyflux crate snares'),
  'crate/clap': fam('percussion', 0.62, 'eddyflux crate claps and snaps'),
  'crate/hat': fam('percussion', 0.88, 'eddyflux crate hats'),
  'crate/cymbal': fam('percussion', 0.85, 'eddyflux crate crashes and rides'),
  'crate/perc': fam('percussion', 0.55, 'eddyflux crate percussion'),
  'break/loop': fam('percussion', 0.55, 'whole drum breaks (use .fit(), .loopAt() or .splice())'),
  'break/slices': fam('percussion', 0.55, 'pre-chopped break slices'),
  'pad/sampled': fam('harmonic', 0.4, 'long sampled pads'),
  'piano/salamander': fam('harmonic', 0.4, 'Salamander grand piano (use .piano() or note())'),
  'vcsl/keys': fam('harmonic', 0.4, 'VCSL pianos and TX81Z FM keys'),
  'vcsl/organ': fam('harmonic', 0.45, 'VCSL pipe and renaissance organs'),
  'vcsl/mallet': fam('melodic', 0.55, 'VCSL mallets, bells and thumb pianos'),
  'vcsl/plucked': fam('melodic', 0.5, 'VCSL harps, zithers and strumstick'),
  'vcsl/bowed': fam('harmonic', 0.5, 'VCSL bowed psaltery and wine glasses'),
  'vcsl/wind': fam('melodic', 0.45, 'VCSL recorders, ocarinas, saxes and harmonicas'),
  'vcsl/drum': fam('percussion', 0.3, 'VCSL orchestral drums: bass drums, snares, toms, timpani'),
  'vcsl/hand-drum': fam('percussion', 0.35, 'VCSL hand drums: bongo, conga, darbuka, frame drum, cajon'),
  'vcsl/hand-perc': fam('percussion', 0.7, 'VCSL shakers, claps, claves, woodblocks, scrapers'),
  'vcsl/metal': fam('percussion', 0.8, 'VCSL cymbals, gongs, bells, cowbells, anvils'),
  'vcsl/fx': fam('texture', 0.6, 'VCSL whistles, siren, ocean drum, didgeridoo'),
  'gm/keys': fam('harmonic', 0.4, 'General MIDI pianos and keyboards'),
  'gm/mallet': fam('melodic', 0.6, 'General MIDI chromatic percussion'),
  'gm/organ': fam('harmonic', 0.45, 'General MIDI organs, accordion, harmonica'),
  'gm/guitar': fam('harmonic', 0.45, 'General MIDI guitars'),
  'gm/bass': fam('bass', 0.2, 'General MIDI basses'),
  'gm/strings': fam('harmonic', 0.4, 'General MIDI solo strings and string ensembles'),
  'gm/choir': fam('vocal', 0.4, 'General MIDI choirs and voices'),
  'gm/brass': fam('melodic', 0.5, 'General MIDI brass'),
  'gm/reed': fam('melodic', 0.45, 'General MIDI saxes and double reeds'),
  'gm/pipe': fam('melodic', 0.45, 'General MIDI flutes and whistles'),
  'gm/lead': fam('melodic', 0.6, 'General MIDI synth leads'),
  'gm/pad': fam('harmonic', 0.4, 'General MIDI synth pads'),
  'gm/fx': fam('texture', 0.55, 'General MIDI synth effects'),
  'gm/ethnic': fam('melodic', 0.5, 'General MIDI world instruments'),
  'gm/percussion': fam('percussion', 0.45, 'General MIDI tuned and orchestral percussion'),
  'gm/sfx': fam('texture', 0.55, 'General MIDI sound effects'),
  'world/percussion': fam('percussion', 0.45, 'tabla, mridangam, Japanese percussion'),
  'found/object': fam('percussion', 0.6, 'found sounds: bottles, cans, lighters, metal'),
  'field/nature': fam('texture', 0.5, 'field recordings: wind, birds, insects, fire, water, animals'),
  'fx/arcade': fam('texture', 0.55, 'vintage arcade game sound effects'),
  'fx/electronic': fam('texture', 0.55, 'bleeps, zaps, glitches and processed sounds'),
  'fx/noise': fam('texture', 0.75, 'sampled noise bursts'),
  'voice/speech': fam('vocal', 0.5, 'spoken words, letters, numbers, synthetic speech'),
  'voice/vocal': fam('vocal', 0.5, 'sung or shouted vocal snippets, breaths, mouth sounds'),
};

// ─── Curation ─────────────────────────────────────────────────────────────────────────────────────

/** [family, label, tags, category override] */
type Curated = readonly [family: string, label: string, tags: string, category?: SoundCategory];

interface SynthSpec {
  id: string;
  family: string;
  label: string;
  tags: string;
  category?: SoundCategory;
  pitched: boolean;
  aliases?: string[];
}

const SYNTHS: readonly SynthSpec[] = [
  { id: 'sine', family: 'synth/basic', label: 'Sine', tags: 'pure, soft, sub', pitched: true, aliases: ['sin'] },
  { id: 'triangle', family: 'synth/basic', label: 'Triangle', tags: 'soft, hollow, mellow', pitched: true, aliases: ['tri'] },
  { id: 'square', family: 'synth/basic', label: 'Square', tags: 'hollow, retro, chiptune', category: 'melodic', pitched: true, aliases: ['sqr'] },
  { id: 'sawtooth', family: 'synth/basic', label: 'Sawtooth', tags: 'bright, buzzy, analog', category: 'bass', pitched: true, aliases: ['saw'] },
  { id: 'supersaw', family: 'synth/detuned', label: 'Supersaw', tags: 'wide, lush, trance', pitched: true },
  { id: 'pulse', family: 'synth/pulse', label: 'Pulse', tags: 'pwm, reedy, retro', pitched: true },
  { id: 'sbd', family: 'synth/kick', label: 'Synth kick', tags: 'synth kick, punchy, tunable', pitched: false },
  { id: 'white', family: 'synth/noise', label: 'White noise', tags: 'noise, hiss, bright', pitched: false },
  { id: 'pink', family: 'synth/noise', label: 'Pink noise', tags: 'noise, softer, airy', pitched: false },
  { id: 'brown', family: 'synth/noise', label: 'Brown noise', tags: 'noise, rumble, dark', pitched: false },
  { id: 'crackle', family: 'synth/noise', label: 'Crackle', tags: 'vinyl crackle, dust, sparse', pitched: false },
  { id: 'zzfx', family: 'synth/zzfx', label: 'ZzFX', tags: 'procedural sfx, 8-bit', category: 'texture', pitched: true },
  { id: 'z_sine', family: 'synth/zzfx', label: 'ZzFX sine', tags: 'chip, soft, 8-bit', pitched: true },
  { id: 'z_triangle', family: 'synth/zzfx', label: 'ZzFX triangle', tags: 'chip, mellow, 8-bit', pitched: true },
  { id: 'z_square', family: 'synth/zzfx', label: 'ZzFX square', tags: 'chip, hollow, 8-bit', pitched: true },
  { id: 'z_sawtooth', family: 'synth/zzfx', label: 'ZzFX sawtooth', tags: 'chip, buzzy, 8-bit', pitched: true },
  { id: 'z_tan', family: 'synth/zzfx', label: 'ZzFX tangent', tags: 'chip, harsh, clipped', pitched: true },
  { id: 'z_noise', family: 'synth/zzfx', label: 'ZzFX noise', tags: 'chip noise, 8-bit, percussive', category: 'texture', pitched: true },
];

/** Every soundfont-backed name registerSoundfonts() creates: [label, family, tags, category override]. */
const GM: Readonly<Record<string, readonly [label: string, family: string, tags: string, category?: SoundCategory]>> = {
  gm_piano: ['Piano (GM)', 'gm/keys', 'acoustic grand, bright'],
  gm_epiano1: ['Electric piano (GM)', 'gm/keys', 'rhodes, warm, electric piano'],
  gm_epiano2: ['Electric piano 2 (GM)', 'gm/keys', 'fm, dx7, glassy'],
  gm_harpsichord: ['Harpsichord (GM)', 'gm/keys', 'baroque, plucked, bright'],
  gm_clavinet: ['Clavinet (GM)', 'gm/keys', 'funk, percussive, bright'],
  gm_celesta: ['Celesta (GM)', 'gm/mallet', 'bell-like, twinkly'],
  gm_glockenspiel: ['Glockenspiel (GM)', 'gm/mallet', 'bright, bell, mallet'],
  gm_music_box: ['Music box (GM)', 'gm/mallet', 'delicate, twinkly, lullaby'],
  gm_vibraphone: ['Vibraphone (GM)', 'gm/mallet', 'jazz, mellow, mallet'],
  gm_marimba: ['Marimba (GM)', 'gm/mallet', 'woody, warm, mallet'],
  gm_xylophone: ['Xylophone (GM)', 'gm/mallet', 'woody, bright, mallet'],
  gm_tubular_bells: ['Tubular bells (GM)', 'gm/mallet', 'church bell, chime'],
  gm_dulcimer: ['Dulcimer (GM)', 'gm/mallet', 'hammered, folk, shimmering'],
  gm_drawbar_organ: ['Drawbar organ (GM)', 'gm/organ', 'hammond, soul, jazz'],
  gm_percussive_organ: ['Percussive organ (GM)', 'gm/organ', 'hammond, key click, soul'],
  gm_rock_organ: ['Rock organ (GM)', 'gm/organ', 'overdriven, gritty, rock'],
  gm_church_organ: ['Church organ (GM)', 'gm/organ', 'pipe organ, majestic'],
  gm_reed_organ: ['Reed organ (GM)', 'gm/organ', 'harmonium, soft, reedy'],
  gm_accordion: ['Accordion (GM)', 'gm/organ', 'reedy, folk, musette'],
  gm_harmonica: ['Harmonica (GM)', 'gm/organ', 'blues, reedy, harp', 'melodic'],
  gm_bandoneon: ['Bandoneon (GM)', 'gm/organ', 'tango, reedy, melancholy'],
  gm_acoustic_guitar_nylon: ['Nylon guitar (GM)', 'gm/guitar', 'classical, warm, plucked'],
  gm_acoustic_guitar_steel: ['Steel guitar (GM)', 'gm/guitar', 'folk, bright, strummed'],
  gm_electric_guitar_jazz: ['Jazz guitar (GM)', 'gm/guitar', 'mellow, hollow-body, jazz'],
  gm_electric_guitar_clean: ['Clean guitar (GM)', 'gm/guitar', 'clean, funk, chorus'],
  gm_electric_guitar_muted: ['Muted guitar (GM)', 'gm/guitar', 'palm-muted, funk, plucky', 'melodic'],
  gm_overdriven_guitar: ['Overdriven guitar (GM)', 'gm/guitar', 'crunchy, rock', 'melodic'],
  gm_distortion_guitar: ['Distortion guitar (GM)', 'gm/guitar', 'heavy, metal, power chords', 'melodic'],
  gm_guitar_harmonics: ['Guitar harmonics (GM)', 'gm/guitar', 'chiming, glassy', 'melodic'],
  gm_acoustic_bass: ['Acoustic bass (GM)', 'gm/bass', 'upright, jazz, woody'],
  gm_electric_bass_finger: ['Finger bass (GM)', 'gm/bass', 'electric, round, funk'],
  gm_electric_bass_pick: ['Pick bass (GM)', 'gm/bass', 'electric, punchy, rock'],
  gm_fretless_bass: ['Fretless bass (GM)', 'gm/bass', 'smooth, singing, fusion'],
  gm_slap_bass_1: ['Slap bass (GM)', 'gm/bass', 'funk, slap, bright'],
  gm_slap_bass_2: ['Slap bass 2 (GM)', 'gm/bass', 'funk, slap, popped'],
  gm_synth_bass_1: ['Synth bass (GM)', 'gm/bass', 'analog, square, retro'],
  gm_synth_bass_2: ['Synth bass 2 (GM)', 'gm/bass', 'analog, rubbery'],
  gm_violin: ['Violin (GM)', 'gm/strings', 'bowed, solo, expressive', 'melodic'],
  gm_viola: ['Viola (GM)', 'gm/strings', 'bowed, solo, dark', 'melodic'],
  gm_cello: ['Cello (GM)', 'gm/strings', 'bowed, solo, warm', 'melodic'],
  gm_contrabass: ['Contrabass (GM)', 'gm/strings', 'bowed, deep, orchestral', 'bass'],
  gm_tremolo_strings: ['Tremolo strings (GM)', 'gm/strings', 'tremolo, tense, cinematic'],
  gm_pizzicato_strings: ['Pizzicato strings (GM)', 'gm/strings', 'plucked, playful', 'melodic'],
  gm_orchestral_harp: ['Harp (GM)', 'gm/strings', 'harp, plucked, glassy', 'melodic'],
  gm_timpani: ['Timpani (GM)', 'gm/percussion', 'orchestral drum, tuned, rumble'],
  gm_string_ensemble_1: ['String ensemble (GM)', 'gm/strings', 'strings, lush, cinematic'],
  gm_string_ensemble_2: ['String ensemble 2 (GM)', 'gm/strings', 'strings, slow attack, soft'],
  gm_synth_strings_1: ['Synth strings (GM)', 'gm/strings', 'string machine, 80s'],
  gm_synth_strings_2: ['Synth strings 2 (GM)', 'gm/strings', 'analog strings, soft'],
  gm_choir_aahs: ['Choir aahs (GM)', 'gm/choir', 'choir, aah, angelic'],
  gm_voice_oohs: ['Voice oohs (GM)', 'gm/choir', 'choir, ooh, soft'],
  gm_synth_choir: ['Synth choir (GM)', 'gm/choir', 'synth voice, 80s, airy'],
  gm_orchestra_hit: ['Orchestra hit (GM)', 'gm/strings', 'orchestra stab, 80s, dramatic', 'melodic'],
  gm_trumpet: ['Trumpet (GM)', 'gm/brass', 'bright, brassy, solo'],
  gm_trombone: ['Trombone (GM)', 'gm/brass', 'brassy, warm'],
  gm_tuba: ['Tuba (GM)', 'gm/brass', 'low brass, oompah', 'bass'],
  gm_muted_trumpet: ['Muted trumpet (GM)', 'gm/brass', 'harmon mute, jazz, soft'],
  gm_french_horn: ['French horn (GM)', 'gm/brass', 'mellow, noble, orchestral'],
  gm_brass_section: ['Brass section (GM)', 'gm/brass', 'brass stabs, funk, big', 'harmonic'],
  gm_synth_brass_1: ['Synth brass (GM)', 'gm/brass', 'analog brass, 80s', 'harmonic'],
  gm_synth_brass_2: ['Synth brass 2 (GM)', 'gm/brass', 'soft analog brass', 'harmonic'],
  gm_soprano_sax: ['Soprano sax (GM)', 'gm/reed', 'bright, smooth jazz'],
  gm_alto_sax: ['Alto sax (GM)', 'gm/reed', 'jazz, sultry'],
  gm_tenor_sax: ['Tenor sax (GM)', 'gm/reed', 'jazz, husky'],
  gm_baritone_sax: ['Baritone sax (GM)', 'gm/reed', 'low, honky'],
  gm_oboe: ['Oboe (GM)', 'gm/reed', 'reedy, pastoral'],
  gm_english_horn: ['English horn (GM)', 'gm/reed', 'reedy, melancholy'],
  gm_bassoon: ['Bassoon (GM)', 'gm/reed', 'woody, low, comic'],
  gm_clarinet: ['Clarinet (GM)', 'gm/reed', 'woody, warm, klezmer'],
  gm_piccolo: ['Piccolo (GM)', 'gm/pipe', 'high, bright, flute'],
  gm_flute: ['Flute (GM)', 'gm/pipe', 'airy, soft, flute'],
  gm_recorder: ['Recorder (GM)', 'gm/pipe', 'woody, simple'],
  gm_pan_flute: ['Pan flute (GM)', 'gm/pipe', 'breathy, andean'],
  gm_blown_bottle: ['Blown bottle (GM)', 'gm/pipe', 'breathy, hollow'],
  gm_shakuhachi: ['Shakuhachi (GM)', 'gm/pipe', 'breathy, japanese, zen'],
  gm_whistle: ['Whistle (GM)', 'gm/pipe', 'whistling, pure'],
  gm_ocarina: ['Ocarina (GM)', 'gm/pipe', 'pure, hollow, game'],
  gm_lead_1_square: ['Square lead (GM)', 'gm/lead', 'chiptune, hollow'],
  gm_lead_2_sawtooth: ['Saw lead (GM)', 'gm/lead', 'buzzy, bright'],
  gm_lead_3_calliope: ['Calliope lead (GM)', 'gm/lead', 'flutey, carnival'],
  gm_lead_4_chiff: ['Chiff lead (GM)', 'gm/lead', 'breathy attack, soft'],
  gm_lead_5_charang: ['Charang lead (GM)', 'gm/lead', 'distorted, guitar-like'],
  gm_lead_6_voice: ['Voice lead (GM)', 'gm/lead', 'vocal synth, ooh'],
  gm_lead_7_fifths: ['Fifths lead (GM)', 'gm/lead', 'parallel fifths, power'],
  gm_lead_8_bass_lead: ['Bass + lead (GM)', 'gm/lead', 'punchy, bass lead', 'bass'],
  gm_pad_new_age: ['New age pad (GM)', 'gm/pad', 'bell pad, shimmering'],
  gm_pad_warm: ['Warm pad (GM)', 'gm/pad', 'warm, soft, analog'],
  gm_pad_poly: ['Polysynth pad (GM)', 'gm/pad', 'polysynth, 80s'],
  gm_pad_choir: ['Choir pad (GM)', 'gm/pad', 'airy, vocal pad'],
  gm_pad_bowed: ['Bowed pad (GM)', 'gm/pad', 'glassy, bowed'],
  gm_pad_metallic: ['Metallic pad (GM)', 'gm/pad', 'metallic, cold'],
  gm_pad_halo: ['Halo pad (GM)', 'gm/pad', 'ethereal, airy'],
  gm_pad_sweep: ['Sweep pad (GM)', 'gm/pad', 'filter sweep, evolving'],
  gm_fx_rain: ['Rain (GM fx)', 'gm/fx', 'droplets, twinkling'],
  gm_fx_soundtrack: ['Soundtrack (GM fx)', 'gm/fx', 'cinematic, swell'],
  gm_fx_crystal: ['Crystal (GM fx)', 'gm/fx', 'sparkling, bell'],
  gm_fx_atmosphere: ['Atmosphere (GM fx)', 'gm/fx', 'airy, guitar-like'],
  gm_fx_brightness: ['Brightness (GM fx)', 'gm/fx', 'bright, shimmering'],
  gm_fx_goblins: ['Goblins (GM fx)', 'gm/fx', 'eerie, dark, evolving'],
  gm_fx_echoes: ['Echoes (GM fx)', 'gm/fx', 'echoing, spacey'],
  gm_fx_sci_fi: ['Sci-fi (GM fx)', 'gm/fx', 'alien, warbling'],
  gm_sitar: ['Sitar (GM)', 'gm/ethnic', 'indian, buzzing, drone'],
  gm_banjo: ['Banjo (GM)', 'gm/ethnic', 'bluegrass, twangy'],
  gm_shamisen: ['Shamisen (GM)', 'gm/ethnic', 'japanese, plucked'],
  gm_koto: ['Koto (GM)', 'gm/ethnic', 'japanese zither, plucked'],
  gm_kalimba: ['Kalimba (GM)', 'gm/ethnic', 'thumb piano, soft'],
  gm_bagpipe: ['Bagpipe (GM)', 'gm/ethnic', 'drone, celtic'],
  gm_fiddle: ['Fiddle (GM)', 'gm/ethnic', 'folk, celtic, bowed'],
  gm_shanai: ['Shehnai (GM)', 'gm/ethnic', 'indian, reedy'],
  gm_tinkle_bell: ['Tinkle bell (GM)', 'gm/percussion', 'bell, bright', 'melodic'],
  gm_agogo: ['Agogo (GM)', 'gm/percussion', 'latin, bell'],
  gm_steel_drums: ['Steel drums (GM)', 'gm/percussion', 'caribbean, calypso', 'melodic'],
  gm_woodblock: ['Woodblock (GM)', 'gm/percussion', 'wood, tock'],
  gm_taiko_drum: ['Taiko (GM)', 'gm/percussion', 'big, japanese drum'],
  gm_melodic_tom: ['Melodic tom (GM)', 'gm/percussion', 'tom, tuned'],
  gm_synth_drum: ['Synth drum (GM)', 'gm/percussion', 'electronic tom, 80s'],
  gm_reverse_cymbal: ['Reverse cymbal (GM)', 'gm/percussion', 'swell, riser', 'texture'],
  gm_guitar_fret_noise: ['Fret noise (GM)', 'gm/sfx', 'squeak, guitar'],
  gm_breath_noise: ['Breath noise (GM)', 'gm/sfx', 'breath, air'],
  gm_seashore: ['Seashore (GM)', 'gm/sfx', 'waves, ocean'],
  gm_bird_tweet: ['Bird tweet (GM)', 'gm/sfx', 'birds, chirp'],
  gm_telephone: ['Telephone (GM)', 'gm/sfx', 'ring, phone'],
  gm_helicopter: ['Helicopter (GM)', 'gm/sfx', 'rotor, chopper'],
  gm_applause: ['Applause (GM)', 'gm/sfx', 'crowd, clapping'],
  gm_gunshot: ['Gunshot (GM)', 'gm/sfx', 'shot, bang'],
};

/** Drum machines: display name and character tags. */
const MACHINES: Readonly<Record<string, readonly [label: string, tags: string]>> = {
  AJKPercusyn: ['Percusyn', 'analog, odd, lo-fi'],
  AkaiLinn: ['Akai Linn', 'linn, 80s, punchy'],
  AkaiMPC60: ['MPC60', 'gritty 12-bit, hip-hop'],
  AkaiXR10: ['XR10', '80s digital, bright'],
  AlesisHR16: ['HR-16', '80s digital, crisp'],
  AlesisSR16: ['SR-16', '90s digital, clean'],
  BossDR110: ['DR-110', 'analog, thin, lo-fi'],
  BossDR220: ['DR-220', '80s digital, crisp'],
  BossDR55: ['DR-55', 'analog, minimal, lo-fi'],
  BossDR550: ['DR-550', '90s digital, clean'],
  CasioRZ1: ['RZ-1', 'gritty 12-bit, 80s'],
  CasioSK1: ['SK-1', 'toy sampler, lo-fi'],
  CasioVL1: ['VL-1', 'toy, tiny, chiptune'],
  DoepferMS404: ['MS-404', 'analog, acid'],
  EmuDrumulator: ['Drumulator', '12-bit, 80s, punchy'],
  EmuModular: ['E-mu modular', 'analog modular, experimental'],
  EmuSP12: ['SP-12', 'gritty 12-bit, hip-hop, crunchy'],
  KorgDDM110: ['DDM-110', '80s digital, thin'],
  KorgKPR77: ['KPR-77', 'analog, snappy'],
  KorgKR55: ['KR-55', 'analog, vintage preset rhythm'],
  KorgKRZ: ['KR-Z', '80s digital'],
  KorgM1: ['M1', '90s workstation, house'],
  KorgMinipops: ['Mini Pops', 'vintage, organ-top, lo-fi'],
  KorgPoly800: ['Poly-800', 'analog synth kick'],
  KorgT3: ['T3', '90s workstation'],
  Linn9000: ['Linn 9000', '80s, punchy, big'],
  LinnDrum: ['LinnDrum', '80s, punchy, pop'],
  LinnLM1: ['LM-1', '80s, punchy, funk'],
  LinnLM2: ['LM-2', '80s, punchy, pop'],
  MFB512: ['MFB-512', 'analog, techno'],
  MPC1000: ['MPC1000', 'hip-hop, modern'],
  MoogConcertMateMG1: ['Concertmate MG-1', 'analog, vintage'],
  OberheimDMX: ['DMX', '80s, hip-hop, electro'],
  RhodesPolaris: ['Polaris', 'analog, vintage'],
  RhythmAce: ['Rhythm Ace', 'vintage preset rhythm, lo-fi'],
  RolandCompurhythm1000: ['CR-1000', 'analog, vintage'],
  RolandCompurhythm78: ['CR-78', 'vintage analog, soft'],
  RolandCompurhythm8000: ['CR-8000', 'analog, 80s'],
  RolandD110: ['D-110', '80s digital, clean'],
  RolandD70: ['D-70', '90s digital'],
  RolandDDR30: ['DDR-30', '80s electronic drums'],
  RolandJD990: ['JD-990', '90s digital, bright'],
  RolandMC202: ['MC-202', 'analog, acid'],
  RolandMC303: ['MC-303', '90s groovebox, dance'],
  RolandMT32: ['MT-32', '80s digital, game'],
  RolandR8: ['R-8', '80s digital, realistic'],
  RolandS50: ['S-50', '80s sampler, gritty'],
  RolandSH09: ['SH-09', 'analog synth kick'],
  RolandSystem100: ['System-100', 'analog modular, bleepy'],
  RolandTR505: ['TR-505', '80s digital, lo-fi'],
  RolandTR606: ['TR-606', 'analog, thin, acid'],
  RolandTR626: ['TR-626', '80s digital'],
  RolandTR707: ['TR-707', '80s digital, house, electro'],
  RolandTR727: ['TR-727', 'latin percussion, 80s'],
  RolandTR808: ['TR-808', '808, hip-hop, electro'],
  RolandTR909: ['TR-909', '909, house, techno'],
  SakataDPM48: ['DPM-48', '80s digital'],
  SequentialCircuitsDrumtracks: ['Drumtraks', '80s, punchy'],
  SequentialCircuitsTom: ['Sequential Tom', '80s, punchy'],
  SergeModular: ['Serge modular', 'analog modular, experimental'],
  SimmonsSDS400: ['SDS-400', 'electronic toms, 80s'],
  SimmonsSDS5: ['SDS-5', 'electronic drums, 80s, synthy'],
  SoundmastersR88: ['R-88', '80s, lo-fi'],
  UnivoxMicroRhythmer12: ['Micro-Rhythmer 12', 'vintage, lo-fi'],
  ViscoSpaceDrum: ['Space Drum', '80s, sci-fi, synthy'],
  XdrumLM8953: ['LM-8953', '80s, lo-fi'],
  YamahaRM50: ['RM50', '90s digital, huge library'],
  YamahaRX21: ['RX21', '80s digital, thin'],
  YamahaRX5: ['RX5', '80s digital, crisp'],
  YamahaRY30: ['RY30', '90s digital, realistic'],
  YamahaTG33: ['TG33', '90s digital'],
};

/** Drum-machine instrument suffixes: [family, label word, tags]. */
const MACHINE_PARTS: Readonly<Record<string, readonly [family: string, word: string, tags: string]>> = {
  bd: ['drum-machine/kick', 'kick', 'kick'],
  sd: ['drum-machine/snare', 'snare', 'snare'],
  cp: ['drum-machine/clap', 'clap', 'clap'],
  hh: ['drum-machine/hat', 'closed hat', 'closed hat'],
  oh: ['drum-machine/hat', 'open hat', 'open hat'],
  cr: ['drum-machine/cymbal', 'crash', 'crash cymbal'],
  rd: ['drum-machine/cymbal', 'ride', 'ride cymbal'],
  ht: ['drum-machine/tom', 'high tom', 'tom, high'],
  mt: ['drum-machine/tom', 'mid tom', 'tom, mid'],
  lt: ['drum-machine/tom', 'low tom', 'tom, low'],
  rim: ['drum-machine/rim', 'rimshot', 'rimshot'],
  cb: ['drum-machine/perc', 'cowbell', 'cowbell'],
  sh: ['drum-machine/perc', 'shaker', 'shaker'],
  tb: ['drum-machine/perc', 'tambourine', 'tambourine'],
  perc: ['drum-machine/perc', 'percussion', 'percussion, assorted'],
  misc: ['drum-machine/fx', 'misc', 'misc hits, assorted'],
  fx: ['drum-machine/fx', 'fx', 'fx hits'],
};

/** Tags for iconic machine sounds, replacing the generic part + machine tags. */
const MACHINE_TAGS: Readonly<Record<string, string>> = {
  rolandtr808_bd: 'kick, 808 boom, long sub, hip-hop, trap',
  rolandtr808_sd: 'snare, 808, snappy, electro',
  rolandtr808_cp: 'clap, 808, classic',
  rolandtr808_cb: 'cowbell, 808, iconic',
  rolandtr808_hh: 'closed hat, 808, ticky',
  rolandtr808_oh: 'open hat, 808, sizzle',
  rolandtr909_bd: 'kick, 909, punchy, house, techno',
  rolandtr909_sd: 'snare, 909, snappy, noisy',
  rolandtr909_hh: 'closed hat, 909, crisp',
  rolandtr909_oh: 'open hat, 909, crisp',
  rolandtr909_cp: 'clap, 909, house',
  rolandtr909_rd: 'ride, 909, techno',
  rolandtr707_bd: 'kick, 707, tight, electro',
  rolandtr606_hh: 'closed hat, 606, thin, acid',
  linndrum_sd: 'snare, linndrum, 80s pop',
  emusp12_bd: 'kick, sp-12, gritty 12-bit, boom-bap',
  emusp12_sd: 'snare, sp-12, gritty 12-bit, boom-bap',
  akaimpc60_sd: 'snare, mpc60, gritty 12-bit, boom-bap',
  akaimpc60_bd: 'kick, mpc60, gritty 12-bit, boom-bap',
};

/** Dirt-Samples banks (all but the dropped ones). */
const DIRT: Readonly<Record<string, Curated>> = {
  '808': ['dirt/kit', '808 odds (Dirt)', '808, cowbell, clap, rimshot, conga'],
  '909': ['dirt/kick', '909 kick (Dirt)', 'kick, 909, punchy'],
  '808bd': ['dirt/kick', '808 kick (Dirt)', 'kick, 808 boom, sub'],
  '808cy': ['dirt/cymbal', '808 cymbal (Dirt)', 'cymbal, 808, sizzle'],
  '808hc': ['dirt/perc', '808 high conga (Dirt)', 'conga, 808, tonal'],
  '808ht': ['dirt/tom', '808 high tom (Dirt)', 'tom, 808'],
  '808lc': ['dirt/perc', '808 low conga (Dirt)', 'conga, 808, tonal'],
  '808lt': ['dirt/tom', '808 low tom (Dirt)', 'tom, 808, boomy'],
  '808mc': ['dirt/perc', '808 mid conga (Dirt)', 'conga, 808, tonal'],
  '808mt': ['dirt/tom', '808 mid tom (Dirt)', 'tom, 808'],
  '808oh': ['dirt/hat', '808 open hat (Dirt)', 'open hat, 808'],
  '808sd': ['dirt/snare', '808 snare (Dirt)', 'snare, 808, snappy'],
  ab: ['dirt/kit', 'AB kit (Dirt)', 'electro kit, hats, crash, hits'],
  ade: ['dirt/loop', 'Ade loops (Dirt)', 'melodic loops, basslines, idm'],
  ades2: ['dirt/loop', 'Ade bits 2 (Dirt)', 'idm fragments, short'],
  ades3: ['dirt/loop', 'Ade bits 3 (Dirt)', 'idm fragments'],
  ades4: ['dirt/loop', 'Ade bits 4 (Dirt)', 'idm fragments, short'],
  alex: ['break/loop', 'Alex drum loops (Dirt)', 'drum loop'],
  alphabet: ['voice/speech', 'Alphabet (Dirt)', 'spoken letters a-z'],
  amencutup: ['break/slices', 'Amen cut-up (Dirt)', 'amen, jungle, 32 slices'],
  armora: ['fx/arcade', 'Armor Attack (Dirt)', 'arcade, explosions, retro'],
  arp: ['dirt/synth', 'Arp (Dirt)', 'synth arpeggio loop'],
  arpy: ['dirt/synth', 'Arpy (Dirt)', 'plucky synth notes, classic tidal'],
  auto: ['dirt/kit', 'Auto kit (Dirt)', 'break kit, kick, ride, reverse cymbal'],
  baa: ['field/nature', 'Sheep (Dirt)', 'sheep, animal, comic'],
  baa2: ['field/nature', 'Sheep 2 (Dirt)', 'sheep, animal, comic'],
  bass: ['dirt/bass', 'Bass (Dirt)', 'synth bass hits'],
  bass0: ['dirt/bass', 'Bass 0 (Dirt)', 'deep synth bass'],
  bass1: ['dirt/bass', 'Bass hits (Dirt)', 'bass hits, sub'],
  bass2: ['dirt/bass', 'Hardcore bass (Dirt)', 'hardcore, distorted bass'],
  bass3: ['dirt/bass', 'Bass 3 (Dirt)', 'synth bass'],
  bassdm: ['dirt/kick', 'Drum-machine kicks (Dirt)', 'kick, 909-style, varied'],
  bassfoo: ['dirt/bass', 'Bassfoo (Dirt)', 'synth bass'],
  battles: ['fx/arcade', 'Battles (Dirt)', 'explosions, retro'],
  bd: ['dirt/kick', 'Kick (Dirt)', 'kick, classic'],
  bend: ['dirt/synth', 'Bends (Dirt)', 'pitch bends, synth'],
  bev: ['voice/vocal', 'Bev (Dirt)', 'vocal phrase, long'],
  bin: ['found/object', 'Bin (Dirt)', 'trash bin, clang'],
  birds: ['field/nature', 'Birds (Dirt)', 'birdsong'],
  birds3: ['field/nature', 'Birds 3 (Dirt)', 'birdsong, chirps'],
  bleep: ['fx/electronic', 'Bleeps (Dirt)', 'bleeps, game sounds'],
  blip: ['fx/electronic', 'Blips (Dirt)', 'short blips'],
  blue: ['voice/vocal', 'Blue vocals (Dirt)', 'sung phrases'],
  bottle: ['found/object', 'Bottle (Dirt)', 'glass bottle, tonal knocks'],
  breaks125: ['break/loop', 'Breaks 125 (Dirt)', 'breakbeat, 125 bpm'],
  breaks152: ['break/loop', 'Amen 152 (Dirt)', 'amen, breakbeat, 152 bpm'],
  breaks157: ['break/loop', 'Break 157 (Dirt)', 'breakbeat, 157 bpm'],
  breaks165: ['break/loop', 'Break 165 (Dirt)', 'breakbeat, 165 bpm'],
  breath: ['voice/vocal', 'Breath (Dirt)', 'breath, air'],
  bubble: ['field/nature', 'Bubbles (Dirt)', 'water, bubbles, n=0 is silent'],
  can: ['found/object', 'Can (Dirt)', 'tin can, metallic knocks'],
  casio: ['dirt/toy', 'Casio', 'toy, lo-fi'],
  cb: ['dirt/perc', 'Cowbell (Dirt)', 'cowbell'],
  cc: ['dirt/cymbal', 'Crash (Dirt)', 'crash cymbal'],
  chin: ['dirt/perc', 'Tiks (Dirt)', 'ticks, tiny clicks'],
  circus: ['fx/arcade', 'Circus (Dirt)', 'arcade, bounce, pop'],
  clak: ['dirt/perc', 'Clak (Dirt)', 'clack, wood'],
  click: ['dirt/perc', 'Clicks (Dirt)', 'clicks, minimal'],
  clubkick: ['dirt/kick', 'Club kick (Dirt)', 'kick, club, house'],
  co: ['dirt/perc', 'Clops (Dirt)', 'clop, hoof, wood'],
  coins: ['found/object', 'Coins (Dirt)', 'coins, jingle'],
  control: ['fx/electronic', 'Control (Dirt)', 'electronic noises'],
  cosmicg: ['fx/arcade', 'Cosmic Guerilla (Dirt)', 'arcade, retro sfx'],
  cp: ['dirt/clap', 'Clap (Dirt)', 'clap'],
  cr: ['dirt/cymbal', 'Ride (Dirt)', 'ride cymbal'],
  crow: ['field/nature', 'Crow (Dirt)', 'crow, caw'],
  d: ['dirt/kit', 'D kit (Dirt)', 'drum hits'],
  db: ['dirt/kit', 'DB kit (Dirt)', 'drum kit, hats, crash'],
  diphone: ['voice/speech', 'Diphones (Dirt)', 'synthetic speech, robotic'],
  diphone2: ['voice/speech', 'Diphones 2 (Dirt)', 'synthetic speech, robotic'],
  dist: ['dirt/kit', 'Industrial distortion (Dirt)', 'distorted, industrial'],
  dork2: ['voice/speech', 'Dork (Dirt)', 'voice'],
  dorkbot: ['voice/speech', 'Dorkbot (Dirt)', 'voice, robotic'],
  dr: ['dirt/kit', 'DR kit (Dirt)', 'drum machine hits'],
  dr2: ['dirt/kit', 'DR-110 kit (Dirt)', 'boss dr-110, analog'],
  dr55: ['dirt/kit', 'DR-55 kit (Dirt)', 'boss dr-55, lo-fi analog'],
  dr_few: ['dirt/kit', 'DR hits (Dirt)', 'drum machine hits'],
  drum: ['dirt/kit', 'Drum (Dirt)', 'drum hits'],
  drumtraks: ['dirt/kit', 'Drumtraks kit (Dirt)', 'sequential drumtraks, 80s'],
  e: ['dirt/perc', 'E hits (Dirt)', 'electronic hits'],
  east: ['world/percussion', 'Japanese percussion (Dirt)', 'taiko, shime, wood block'],
  electro1: ['dirt/kit', 'Electro kit (Dirt)', 'electro, 80s'],
  em2: ['fx/electronic', 'EM2 (Dirt)', 'electronic tones, long'],
  erk: ['fx/electronic', 'Erk (Dirt)', 'glitch'],
  f: ['fx/electronic', 'F (Dirt)', 'electronic hit'],
  feel: ['dirt/kit', 'Feel kit (Dirt)', 'hip-hop kit'],
  feelfx: ['fx/electronic', 'Feel fx (Dirt)', 'boings, zaps'],
  fest: ['fx/electronic', 'Fest (Dirt)', 'electronic hit'],
  fire: ['field/nature', 'Fire (Dirt)', 'crackling fire'],
  flick: ['dirt/perc', 'Flicks (Dirt)', 'flicks, clicks'],
  fm: ['dirt/stab', 'Hip-hop snippets (Dirt)', 'electro, hip-hop, stabs, vocal bits'],
  foo: ['break/slices', 'Break bits (Dirt)', 'break fragments'],
  future: ['dirt/kit', 'Future kit (Dirt)', '808 kicks, garage'],
  gab: ['dirt/kick', 'Gabber kick (Dirt)', 'kick, gabber, distorted'],
  gabba: ['dirt/kick', 'Gabba kick (Dirt)', 'kick, gabber, hardcore'],
  gabbaloud: ['dirt/kick', 'Gabba kick, loud (Dirt)', 'kick, gabber, loud'],
  gabbalouder: ['dirt/kick', 'Gabba kick, louder (Dirt)', 'kick, gabber, very loud'],
  glasstap: ['found/object', 'Glass tap (Dirt)', 'glass, tink'],
  glitch: ['dirt/kit', 'Glitch kit (Dirt)', 'glitch, digital'],
  glitch2: ['dirt/kit', 'Glitch kit 2 (Dirt)', 'glitch, digital'],
  gretsch: ['dirt/kit', 'Gretsch kit (Dirt)', 'acoustic kit, brushes, jazz'],
  gtr: ['dirt/instrument', 'Guitar (Dirt)', 'guitar, clean, overdrive, distortion'],
  h: ['fx/electronic', 'H (Dirt)', 'processed hits, tick, tock'],
  hand: ['dirt/perc', 'Hand (Dirt)', 'hand percussion, slaps'],
  hardcore: ['dirt/kit', 'Hardcore kit (Dirt)', 'hardcore, rave'],
  hardkick: ['dirt/kick', 'Hard kick (Dirt)', 'kick, distorted, hard'],
  haw: ['dirt/kit', 'Hawaiian kit (Dirt)', 'lo-fi kit'],
  hc: ['dirt/hat', 'Closed hat (Dirt)', 'closed hat'],
  hh: ['dirt/hat', 'Hi-hat (Dirt)', 'closed hat'],
  hh27: ['dirt/hat', 'Hi-hat 27 (Dirt)', 'closed hat, kit'],
  hit: ['fx/electronic', 'Hits (Dirt)', 'zaps, lasers, comic'],
  hmm: ['voice/vocal', 'Hmm (Dirt)', 'voice, hum'],
  ho: ['dirt/hat', 'Open hat (Dirt)', 'open hat'],
  hoover: ['dirt/synth', 'Hoover (Dirt)', 'rave hoover, 90s'],
  house: ['dirt/kit', 'House kit (Dirt)', 'house'],
  ht: ['dirt/tom', 'High tom (Dirt)', 'tom, high'],
  if: ['dirt/kit', 'IF (Dirt)', 'gabber, snarl'],
  ifdrums: ['dirt/kit', 'IF drums (Dirt)', 'kick, hat, snare'],
  incoming: ['dirt/kit', 'Synsonics kit (Dirt)', 'mattel synsonics, toy drum machine'],
  industrial: ['dirt/kit', 'Industrial (Dirt)', 'industrial, metallic'],
  insect: ['field/nature', 'Insects (Dirt)', 'insects, katydids'],
  invaders: ['fx/arcade', 'Space Invaders (Dirt)', 'arcade, 8-bit'],
  jazz: ['dirt/kit', 'Jazz kit (Dirt)', 'jazz kit'],
  jungbass: ['dirt/bass', 'Jungle bass (Dirt)', 'sub bass, jungle, 808'],
  jungle: ['dirt/kit', 'Jungle kit (Dirt)', 'jungle'],
  juno: ['dirt/synth', 'Juno (Dirt)', 'roland juno, chords, chorus', 'harmonic'],
  jvbass: ['dirt/bass', 'JV bass (Dirt)', 'roland jv, synth bass'],
  kicklinn: ['dirt/kick', 'Linn kick (Dirt)', 'kick, linndrum, 80s'],
  koy: ['voice/vocal', 'Koy (Dirt)', 'chant, long'],
  kurt: ['voice/speech', 'Kurt (Dirt)', 'spoken voice'],
  latibro: ['dirt/loop', 'Latibro (Dirt)', 'short fragments'],
  led: ['fx/electronic', 'Led (Dirt)', 'long electronic sound'],
  less: ['dirt/kit', 'Less kit (Dirt)', 'kick, snare, hat, bass'],
  lighter: ['found/object', 'Lighter (Dirt)', 'lighter clicks, flicks'],
  linnhats: ['dirt/hat', 'Linn hats (Dirt)', 'closed hat, linndrum, 80s'],
  lt: ['dirt/tom', 'Low tom (Dirt)', 'tom, low'],
  made: ['fx/electronic', 'Made (Dirt)', 'processed sounds'],
  made2: ['fx/electronic', 'Made 2 (Dirt)', 'processed sound'],
  mash: ['fx/electronic', 'Mash (Dirt)', 'mashed-up sounds'],
  mash2: ['fx/electronic', 'Mash 2 (Dirt)', 'mashed-up sounds'],
  metal: ['found/object', 'Metal (Dirt)', 'metallic, tonal hits'],
  miniyeah: ['voice/vocal', 'Mini yeah (Dirt)', 'yeah shouts'],
  monsterb: ['fx/arcade', 'Monster Bash (Dirt)', 'arcade, laughter'],
  moog: ['dirt/bass', 'Moog (Dirt)', 'moog bass notes, analog'],
  mouth: ['voice/vocal', 'Mouth (Dirt)', 'mouth sounds, beatbox'],
  mp3: ['fx/electronic', 'MP3 (Dirt)', 'codec artifacts, glitch'],
  msg: ['fx/electronic', 'Msg (Dirt)', 'electronic hits'],
  mt: ['dirt/tom', 'Mid tom (Dirt)', 'tom, mid'],
  mute: ['dirt/instrument', 'Mute (Dirt)', 'muted horn notes'],
  newnotes: ['dirt/synth', 'New notes (Dirt)', 'synth notes'],
  noise: ['fx/noise', 'Noise sample (Dirt)', 'noise burst'],
  noise2: ['fx/noise', 'Noise 2 (Dirt)', 'noise bursts'],
  notes: ['dirt/synth', 'Notes (Dirt)', 'synth notes'],
  numbers: ['voice/speech', 'Numbers (Dirt)', 'spoken numbers'],
  num: ['voice/speech', 'Num (Dirt)', 'spoken numbers'],
  oc: ['dirt/hat', 'Open/closed hat (Dirt)', 'hats'],
  odx: ['dirt/kit', 'Oberheim DX kit (Dirt)', 'oberheim dx, 80s'],
  off: ['fx/electronic', 'Off (Dirt)', 'electronic hit'],
  outdoor: ['field/nature', 'Outdoor (Dirt)', 'outdoor ambience'],
  pad: ['pad/sampled', 'Pads (Dirt)', 'pad, atmospheric'],
  padlong: ['pad/sampled', 'Long pad (Dirt)', 'pad, atmospheric, very long'],
  pebbles: ['field/nature', 'Pebbles (Dirt)', 'pebbles, scrape'],
  perc: ['dirt/perc', 'Perc (Dirt)', 'percussion'],
  peri: ['dirt/kit', 'Peri kit (Dirt)', 'kit, reversed hits, clangs'],
  pluck: ['dirt/bass', 'Bass pluck (Dirt)', 'plucked bass notes, upright'],
  popkick: ['dirt/kick', 'Pop kick (Dirt)', 'kick, pop'],
  print: ['found/object', 'Printer (Dirt)', 'printer, mechanical'],
  proc: ['fx/electronic', 'Processed (Dirt)', 'processed sounds'],
  procshort: ['fx/electronic', 'Processed short (Dirt)', 'processed hits'],
  psr: ['dirt/toy', 'PSR keyboard (Dirt)', 'yamaha psr, home keyboard hits'],
  rave: ['voice/vocal', 'Rave shouts (Dirt)', 'rave, vocal shots'],
  rave2: ['dirt/bass', 'Rave bass (Dirt)', 'rave bass, 90s'],
  ravemono: ['dirt/loop', 'Rave mono (Dirt)', 'rave loop'],
  realclaps: ['dirt/clap', 'Real claps (Dirt)', 'clap, real hands'],
  reverbkick: ['dirt/kick', 'Reverb kick (Dirt)', 'kick, reverb tail'],
  rm: ['dirt/perc', 'Rim (Dirt)', 'rimshot'],
  rs: ['dirt/perc', 'Rimshot (Dirt)', 'rimshot'],
  sd: ['dirt/snare', 'Snare (Dirt)', 'snare'],
  seawolf: ['fx/arcade', 'Sea Wolf (Dirt)', 'arcade, torpedo, sonar'],
  sequential: ['dirt/kit', 'Sequential Tom kit (Dirt)', 'sequential tom, 80s'],
  sf: ['fx/electronic', 'SF (Dirt)', 'assorted sounds'],
  sheffield: ['field/nature', 'Sheffield insects (Dirt)', 'insects'],
  short: ['dirt/kit', 'Short (Dirt)', 'snares, synth fx'],
  sid: ['dirt/synth', 'SID (Dirt)', 'c64, chip, 8-bit'],
  simplesine: ['dirt/synth', 'Simple sine (Dirt)', 'sine notes'],
  sitar: ['dirt/instrument', 'Sitar chords (Dirt)', 'sitar, d major chords', 'harmonic'],
  sn: ['dirt/snare', 'Snares (Dirt)', 'snare, varied'],
  space: ['fx/electronic', 'Space (Dirt)', 'sci-fi, spacey'],
  speakspell: ['voice/speech', 'Speak & Spell (Dirt)', 'robotic speech, toy'],
  speech: ['voice/speech', 'Speech (Dirt)', 'spoken, robotic'],
  speechless: ['voice/vocal', 'Speechless (Dirt)', 'vocal syllables'],
  speedupdown: ['fx/electronic', 'Speed up/down (Dirt)', 'pitch sweeps'],
  stab: ['dirt/stab', 'Stabs (Dirt)', 'synth stabs, rave'],
  stomp: ['dirt/perc', 'Stomp (Dirt)', 'stomps, foot'],
  subroc3d: ['fx/arcade', 'Subroc-3D (Dirt)', 'arcade, retro sfx'],
  sugar: ['fx/electronic', 'Sugar (Dirt)', 'bark, crab'],
  sundance: ['fx/arcade', 'Sundance (Dirt)', 'arcade, retro sfx'],
  tabla: ['world/percussion', 'Tabla (Dirt)', 'tabla, indian'],
  tabla2: ['world/percussion', 'Tabla 2 (Dirt)', 'tabla, indian, many strokes'],
  tablex: ['world/percussion', 'Tabla x (Dirt)', 'tabla'],
  tacscan: ['fx/arcade', 'Tac/Scan (Dirt)', 'arcade, retro sfx'],
  tech: ['dirt/kit', 'Tech kit (Dirt)', 'techno kit'],
  techno: ['dirt/kit', 'Techno (Dirt)', 'techno hits'],
  tink: ['dirt/perc', 'Tink (Dirt)', 'metallic tinks'],
  tok: ['dirt/perc', 'Tok (Dirt)', 'wood tok'],
  toys: ['voice/speech', 'Talking toys (Dirt)', 'toy voice, notes, words'],
  trump: ['dirt/stab', 'Trumpet stabs (Dirt)', 'brass stabs, funk'],
  ul: ['dirt/kit', 'UL kit (Dirt)', 'kit, noisy, reverse snare'],
  ulgab: ['dirt/kick', 'UL gabber (Dirt)', 'kick, gabber'],
  uxay: ['fx/electronic', 'Uxay (Dirt)', 'assorted sounds'],
  v: ['dirt/kit', 'V kit (Dirt)', 'blips, perc, snares'],
  voodoo: ['dirt/kit', 'Voodoo kit (Dirt)', 'kit'],
  wind: ['field/nature', 'Wind (Dirt)', 'wind, air, ambient'],
  wobble: ['dirt/bass', 'Wobble (Dirt)', 'wobble bass'],
  world: ['dirt/kit', 'World kit (Dirt)', 'kick, gabber kick, snare'],
  xmas: ['voice/speech', 'Merry Christmas (Dirt)', 'spoken phrase'],
  yeah: ['voice/vocal', 'Yeah (Dirt)', 'yeah shouts, vocal'],
};

const VCSL: Readonly<Record<string, Curated>> = {
  ballwhistle: ['vcsl/fx', 'Ball whistle (VCSL)', 'referee whistle'],
  bassdrum1: ['vcsl/drum', 'Bass drum (VCSL)', 'orchestral bass drum, deep'],
  bassdrum2: ['vcsl/drum', 'Bass drum 2 (VCSL)', 'orchestral bass drum, concert'],
  bongo: ['vcsl/hand-drum', 'Bongos (VCSL)', 'latin, hand drum'],
  conga: ['vcsl/hand-drum', 'Congas (VCSL)', 'latin, hand drum'],
  darbuka: ['vcsl/hand-drum', 'Darbuka (VCSL)', 'middle eastern, goblet drum'],
  framedrum: ['vcsl/hand-drum', 'Frame drum (VCSL)', 'frame drum, deep'],
  snare_modern: ['vcsl/drum', 'Snare (VCSL)', 'acoustic snare, crisp'],
  snare_hi: ['vcsl/drum', 'High snare (VCSL)', 'rope-tension snare, military'],
  snare_low: ['vcsl/drum', 'Low snare (VCSL)', 'rope-tension snare, field drum'],
  snare_rim: ['vcsl/drum', 'Snare rim (VCSL)', 'rimshot, acoustic'],
  timpani: ['vcsl/drum', 'Timpani (VCSL)', 'orchestral, boom'],
  timpani_roll: ['vcsl/drum', 'Timpani roll (VCSL)', 'roll, rumble, crescendo'],
  timpani2: ['vcsl/drum', 'Timpani 2 (VCSL)', 'orchestral, tuned hits'],
  tom_mallet: ['vcsl/drum', 'Tom, mallet (VCSL)', 'tom, soft mallet'],
  tom_stick: ['vcsl/drum', 'Tom, stick (VCSL)', 'tom, stick'],
  tom_rim: ['vcsl/drum', 'Tom, rim (VCSL)', 'tom rim, click'],
  tom2_mallet: ['vcsl/drum', 'Tom 2, mallet (VCSL)', 'tom, soft mallet'],
  tom2_stick: ['vcsl/drum', 'Tom 2, stick (VCSL)', 'tom, stick'],
  tom2_rim: ['vcsl/drum', 'Tom 2, rim (VCSL)', 'tom rim, click'],
  recorder_alto_stacc: ['vcsl/wind', 'Alto recorder, staccato (VCSL)', 'recorder, short, woody'],
  recorder_alto_vib: ['vcsl/wind', 'Alto recorder, vibrato (VCSL)', 'recorder, vibrato, woody'],
  recorder_alto_sus: ['vcsl/wind', 'Alto recorder (VCSL)', 'recorder, sustained, woody'],
  recorder_bass_stacc: ['vcsl/wind', 'Bass recorder, staccato (VCSL)', 'recorder, low, short'],
  recorder_bass_vib: ['vcsl/wind', 'Bass recorder, vibrato (VCSL)', 'recorder, low, vibrato'],
  recorder_bass_sus: ['vcsl/wind', 'Bass recorder (VCSL)', 'recorder, low, sustained'],
  recorder_soprano_stacc: ['vcsl/wind', 'Soprano recorder, staccato (VCSL)', 'recorder, high, short'],
  recorder_soprano_sus: ['vcsl/wind', 'Soprano recorder (VCSL)', 'recorder, high, sustained'],
  recorder_tenor_stacc: ['vcsl/wind', 'Tenor recorder, staccato (VCSL)', 'recorder, short'],
  recorder_tenor_vib: ['vcsl/wind', 'Tenor recorder, vibrato (VCSL)', 'recorder, vibrato'],
  recorder_tenor_sus: ['vcsl/wind', 'Tenor recorder (VCSL)', 'recorder, sustained'],
  ocarina_small_stacc: ['vcsl/wind', 'Small ocarina, staccato (VCSL)', 'ocarina, high, short'],
  ocarina_small: ['vcsl/wind', 'Small ocarina (VCSL)', 'ocarina, high, pure'],
  ocarina: ['vcsl/wind', 'Ocarina (VCSL)', 'ocarina, pure, hollow'],
  ocarina_vib: ['vcsl/wind', 'Ocarina, vibrato (VCSL)', 'ocarina, vibrato'],
  pipeorgan_loud_pedal: ['vcsl/organ', 'Pipe organ pedal, loud (VCSL)', 'pipe organ, pedal, deep', 'bass'],
  pipeorgan_loud: ['vcsl/organ', 'Pipe organ, loud (VCSL)', 'pipe organ, church, full'],
  pipeorgan_quiet_pedal: ['vcsl/organ', 'Pipe organ pedal, quiet (VCSL)', 'pipe organ, pedal, soft', 'bass'],
  pipeorgan_quiet: ['vcsl/organ', 'Pipe organ, quiet (VCSL)', 'pipe organ, soft'],
  organ_4inch: ["vcsl/organ", "Renaissance organ 4' (VCSL)", 'chamber organ, bright, flutey'],
  organ_8inch: ["vcsl/organ", "Renaissance organ 8' (VCSL)", 'chamber organ, warm'],
  organ_full: ['vcsl/organ', 'Renaissance organ, full (VCSL)', 'chamber organ, full'],
  trainwhistle: ['vcsl/fx', 'Toy train whistle (VCSL)', 'whistle, toy'],
  harmonica: ['vcsl/wind', 'Harmonica (VCSL)', 'harmonica, blues'],
  harmonica_soft: ['vcsl/wind', 'Harmonica, soft (VCSL)', 'harmonica, soft'],
  harmonica_vib: ['vcsl/wind', 'Harmonica, vibrato (VCSL)', 'harmonica, vibrato'],
  super64: ['vcsl/wind', 'Chromatic harmonica (VCSL)', 'hohner super 64, chromatic'],
  super64_acc: ['vcsl/wind', 'Chromatic harmonica, accent (VCSL)', 'chromatic harmonica, accented'],
  super64_vib: ['vcsl/wind', 'Chromatic harmonica, vibrato (VCSL)', 'chromatic harmonica, vibrato'],
  siren: ['vcsl/fx', 'Siren (VCSL)', 'hand siren, rising'],
  didgeridoo: ['vcsl/fx', 'Didgeridoo (VCSL)', 'drone, overtones, low'],
  saxello: ['vcsl/wind', 'Saxello (VCSL)', 'soprano sax, curved, smooth'],
  saxello_stacc: ['vcsl/wind', 'Saxello, staccato (VCSL)', 'soprano sax, short'],
  saxello_vib: ['vcsl/wind', 'Saxello, vibrato (VCSL)', 'soprano sax, vibrato'],
  sax: ['vcsl/wind', 'Sax (VCSL)', 'saxophone, warm'],
  sax_stacc: ['vcsl/wind', 'Sax, staccato (VCSL)', 'saxophone, short'],
  sax_vib: ['vcsl/wind', 'Sax, vibrato (VCSL)', 'saxophone, vibrato'],
  harp: ['vcsl/plucked', 'Harp (VCSL)', 'concert harp, plucked'],
  folkharp: ['vcsl/plucked', 'Folk harp (VCSL)', 'celtic harp, plucked'],
  strumstick: ['vcsl/plucked', 'Strumstick (VCSL)', 'dulcimer-like, folk, plucked'],
  dantranh: ['vcsl/plucked', 'Dan tranh (VCSL)', 'vietnamese zither, plucked'],
  dantranh_tremolo: ['vcsl/plucked', 'Dan tranh, tremolo (VCSL)', 'vietnamese zither, tremolo'],
  dantranh_vibrato: ['vcsl/plucked', 'Dan tranh, vibrato (VCSL)', 'vietnamese zither, bent notes'],
  kawai: ['vcsl/keys', 'Kawai grand (VCSL)', 'grand piano, warm'],
  steinway: ['vcsl/keys', 'Steinway grand (VCSL)', 'grand piano, rich, loud'],
  psaltery_pluck: ['vcsl/plucked', 'Psaltery, plucked (VCSL)', 'psaltery, plucked, bright'],
  psaltery_spiccato: ['vcsl/bowed', 'Psaltery, spiccato (VCSL)', 'bowed psaltery, short', 'melodic'],
  psaltery_bow: ['vcsl/bowed', 'Psaltery, bowed (VCSL)', 'bowed psaltery, glassy'],
  clavisynth: ['vcsl/keys', 'TX81Z Clavisynth (VCSL)', 'fm, clav, 80s', 'melodic'],
  fmpiano: ['vcsl/keys', 'TX81Z FM piano (VCSL)', 'fm piano, 80s'],
  piano1: ['vcsl/keys', 'TX81Z Piano 1 (VCSL)', 'fm piano, 80s, bright'],
  wineglass: ['vcsl/bowed', 'Wine glass (VCSL)', 'glass harp, ethereal'],
  wineglass_slow: ['vcsl/bowed', 'Wine glass, slow (VCSL)', 'glass harp, slow swell'],
  agogo: ['vcsl/metal', 'Agogo bells (VCSL)', 'latin, samba, bell'],
  anvil: ['vcsl/metal', 'Anvil (VCSL)', 'clang, metal, industrial'],
  brakedrum: ['vcsl/metal', 'Brake drum (VCSL)', 'clang, metal, industrial'],
  balafon_hard: ['vcsl/mallet', 'Balafon, hard (VCSL)', 'west african xylophone, bright'],
  balafon_soft: ['vcsl/mallet', 'Balafon, soft (VCSL)', 'west african xylophone, soft'],
  balafon: ['vcsl/mallet', 'Balafon (VCSL)', 'west african xylophone, buzzy'],
  belltree: ['vcsl/mallet', 'Bell tree (VCSL)', 'bells, shimmer'],
  cabasa: ['vcsl/hand-perc', 'Cabasa (VCSL)', 'shaker, beads'],
  cajon: ['vcsl/hand-drum', 'Cajon (VCSL)', 'box drum, flamenco'],
  clap: ['vcsl/hand-perc', 'Claps (VCSL)', 'hand claps, real'],
  clash: ['vcsl/metal', 'Clash cymbals (VCSL)', 'orchestral crash'],
  clash2: ['vcsl/metal', 'Clash cymbals 2 (VCSL)', 'orchestral crash'],
  clave: ['vcsl/hand-perc', 'Claves (VCSL)', 'latin, wood click'],
  cowbell: ['vcsl/metal', 'Cowbell (VCSL)', 'cowbell, latin'],
  fingercymbal: ['vcsl/metal', 'Finger cymbal (VCSL)', 'tiny bell, ting'],
  flexatone: ['vcsl/fx', 'Flexatone (VCSL)', 'wobbly, comic'],
  gong: ['vcsl/metal', 'Gong (VCSL)', 'gong, wash'],
  gong2: ['vcsl/metal', 'Gong 2 (VCSL)', 'gong, wash'],
  guiro: ['vcsl/hand-perc', 'Guiro (VCSL)', 'scraped, latin'],
  glockenspiel: ['vcsl/mallet', 'Glockenspiel (VCSL)', 'bright, bell, mallet'],
  handbells: ['vcsl/metal', 'Nepalese bells (VCSL)', 'bells, ringing'],
  handchimes: ['vcsl/mallet', 'Hand chimes (VCSL)', 'chimes, soft, pure'],
  hihat: ['vcsl/metal', 'Hi-hat (VCSL)', 'acoustic hi-hat'],
  kalimba: ['vcsl/mallet', 'Kalimba (VCSL)', 'thumb piano, kenya'],
  kalimba2: ['vcsl/mallet', 'Mbira 2 (VCSL)', 'thumb piano, buzzy'],
  kalimba3: ['vcsl/mallet', 'Mbira 3 (VCSL)', 'thumb piano, low, zimbabwe'],
  kalimba4: ['vcsl/mallet', 'Mbira 4 (VCSL)', 'thumb piano, low'],
  kalimba5: ['vcsl/mallet', 'Mbira 5 (VCSL)', 'thumb piano'],
  marimba: ['vcsl/mallet', 'Marimba (VCSL)', 'woody, warm, mallet'],
  marktrees: ['vcsl/metal', 'Mark tree (VCSL)', 'chimes, glissando, sparkle'],
  oceandrum: ['vcsl/fx', 'Ocean drum (VCSL)', 'waves, rain, texture'],
  ratchet: ['vcsl/hand-perc', 'Ratchet (VCSL)', 'rattle, crank'],
  shaker_large: ['vcsl/hand-perc', 'Large shaker (VCSL)', 'shaker, rattle'],
  shaker_small: ['vcsl/hand-perc', 'Small shaker (VCSL)', 'shaker, tight'],
  slapstick: ['vcsl/hand-perc', 'Slapstick (VCSL)', 'whip crack, slap'],
  sleighbells: ['vcsl/hand-perc', 'Sleigh bells (VCSL)', 'jingle bells'],
  slitdrum: ['vcsl/hand-drum', 'Slit drum (VCSL)', 'log drum, wooden, tonal'],
  sus_cymbal: ['vcsl/metal', 'Suspended cymbal (VCSL)', 'cymbal, swell, roll'],
  sus_cymbal2: ['vcsl/metal', 'Suspended cymbal 2 (VCSL)', 'cymbal, swell, roll'],
  tambourine: ['vcsl/hand-perc', 'Tambourine (VCSL)', 'jingles'],
  tambourine2: ['vcsl/hand-perc', 'Tambourine 2 (VCSL)', 'jingles'],
  triangles: ['vcsl/metal', 'Triangle (VCSL)', 'ting, bright'],
  tubularbells: ['vcsl/mallet', 'Tubular bells (VCSL)', 'chimes, church bell'],
  tubularbells2: ['vcsl/mallet', 'Tubular bells 2 (VCSL)', 'chimes, church bell'],
  vibraphone: ['vcsl/mallet', 'Vibraphone (VCSL)', 'warm, acoustic, mallet'],
  vibraphone_soft: ['vcsl/mallet', 'Vibraphone, soft (VCSL)', 'soft, mellow, mallet'],
  vibraphone_bowed: ['vcsl/mallet', 'Vibraphone, bowed (VCSL)', 'bowed, glassy, sustained', 'harmonic'],
  vibraslap: ['vcsl/hand-perc', 'Vibraslap (VCSL)', 'rattle, comic, latin'],
  woodblock: ['vcsl/hand-perc', 'Woodblock (VCSL)', 'wood, tock'],
  xylophone_hard_pp: ['vcsl/mallet', 'Xylophone, hard, soft (VCSL)', 'xylophone, hard mallet, quiet'],
  xylophone_hard_ff: ['vcsl/mallet', 'Xylophone, hard, loud (VCSL)', 'xylophone, hard mallet, loud'],
  xylophone_medium_ff: ['vcsl/mallet', 'Xylophone, medium, loud (VCSL)', 'xylophone, loud'],
  xylophone_medium_pp: ['vcsl/mallet', 'Xylophone, medium, soft (VCSL)', 'xylophone, quiet'],
  xylophone_soft_pp: ['vcsl/mallet', 'Xylophone, soft mallet, soft (VCSL)', 'xylophone, soft mallet, quiet'],
  xylophone_soft_ff: ['vcsl/mallet', 'Xylophone, soft mallet, loud (VCSL)', 'xylophone, soft mallet'],
};

const MRIDANGAM: Readonly<Record<string, string>> = {
  gumki: 'bass stroke, pitch bend',
  ka: 'dry slap',
  nam: 'ringing treble',
  ta: 'treble stroke',
  ki: 'dry slap, light',
  dhin: 'resonant, open',
  na: 'ringing treble',
  chaapu: 'ringing harmonic, high',
  dhum: 'full, bass + treble',
  ardha: 'half chaapu, ringing',
  thom: 'open bass stroke',
  dhi: 'resonant',
  tha: 'muted stroke',
};

const CLEAN_BREAKS: Readonly<Record<string, readonly [title: string, artist: string]>> = {
  useme: ['Use Me', 'Bill Withers'],
  sesame: ['Sesame Street', 'Blowfly'],
  do: ["Doin' the Do", 'Bobby Byrd'],
  funkydrummer: ['Funky Drummer', 'James Brown'],
  mechanicalman: ["I'm Your Mechanical Man", 'Jerry Butler'],
  kool: ['Chocolate Buttermilk', 'Kool & the Gang'],
  sport: ['Sport', "Lightnin' Rod"],
  rill: ['The Rill Thing', 'Little Richard'],
  think: ['Think', 'Lyn Collins'],
  king: ['King of the Beats', 'Mantronix'],
  around: ["Don't Come Around Here", 'Mark Putney'],
  riffin: ["I'm Riffin", 'MC Duke'],
  apache: ['Apache', 'Incredible Bongo Band'],
  neworleans: ['New Orleans', 'Nat Adderley'],
  hitormiss: ['Hit or Miss', 'Odetta'],
  action: ['Action', 'Orange Krush'],
  hotline: ['Hot Line to Jesus', 'Rance Allen Group'],
  swat: ['Theme from S.W.A.T.', 'Rhythm Heritage'],
  ripple: ['A Funky Song', 'Ripple'],
  fireeater: ['Fire Eater', 'Rusty Bryant'],
  hungup: ['Hung Up', 'Salt'],
  newday: ["It's a New Day", 'Skull Snaps'],
  movement: ['Movement', 'SL Troopers'],
  boogiewoogie: ['Boogie Woogie', 'Sound Experience'],
  delight: ["Rapper's Delight", 'Sugarhill Gang'],
  eeloil: ['Eel Oil', 'The Bamboos'],
  impeach: ['Impeach the President', 'The Honeydrippers'],
  marymary: ['Mary Mary', 'The Monkees'],
  amen: ['Amen, Brother', 'The Winstons'],
  sneakin: ["Sneakin' in the Back", 'Tom Scott'],
  squib: ['Squib Cakes', 'Tower of Power'],
  groove: ["Just a Groove in 'G'", 'Wilbur Bascomb'],
};

const CRATE: Readonly<Record<string, Curated>> = {
  crate_bd: ['crate/kick', 'Crate kicks', 'kick, sampled, boom-bap, varied'],
  crate_sd: ['crate/snare', 'Crate snares', 'snare, sampled, boom-bap, varied'],
  crate_cp: ['crate/clap', 'Crate claps', 'clap, snap, sampled'],
  crate_hh: ['crate/hat', 'Crate closed hats', 'closed hat, sampled'],
  crate_oh: ['crate/hat', 'Crate open hats', 'open hat, sampled'],
  crate_cr: ['crate/cymbal', 'Crate crashes', 'crash cymbal, sampled'],
  crate_rd: ['crate/cymbal', 'Crate rides', 'ride cymbal, sampled'],
  crate_sh: ['crate/perc', 'Crate shakers', 'shaker, cabasa'],
  crate_tb: ['crate/perc', 'Crate tambourines', 'tambourine'],
  crate_perc: ['crate/perc', 'Crate percussion', 'percussion, assorted'],
  crate_conga: ['crate/perc', 'Crate congas', 'conga, latin'],
  crate_bongo: ['crate/perc', 'Crate bongos', 'bongo, latin'],
  crate_djembe: ['crate/perc', 'Crate djembe', 'djembe, hand drum'],
  crate_clave: ['crate/perc', 'Crate claves', 'clave, wood'],
  crate_block: ['crate/perc', 'Crate blocks', 'woodblock, wood'],
  crate_stick: ['crate/perc', 'Crate sticks', 'side stick, click'],
  crate_rim: ['crate/perc', 'Crate rimshots', 'rimshot'],
  crate_bell: ['crate/perc', 'Crate bells', 'bell, metallic'],
};

/** AKWF waveform banks: [label, tags, category override]. */
const AKWF: Readonly<Record<string, readonly [label: string, tags: string, category?: SoundCategory]>> = {
  wt_01: ['AKWF 0001 wavetable', 'assorted single cycles'],
  wt_02: ['AKWF 0002 wavetable', 'assorted single cycles'],
  wt_03: ['AKWF 0003 wavetable', 'assorted single cycles'],
  wt_04: ['AKWF 0004 wavetable', 'assorted single cycles'],
  wt_05: ['AKWF 0005 wavetable', 'assorted single cycles'],
  wt_06: ['AKWF 0006 wavetable', 'assorted single cycles'],
  wt_07: ['AKWF 0007 wavetable', 'assorted single cycles'],
  wt_08: ['AKWF 0008 wavetable', 'assorted single cycles'],
  wt_09: ['AKWF 0009 wavetable', 'assorted single cycles'],
  wt_10: ['AKWF 0010 wavetable', 'assorted single cycles'],
  wt_11: ['AKWF 0011 wavetable', 'assorted single cycles'],
  wt_12: ['AKWF 0012 wavetable', 'assorted single cycles'],
  wt_13: ['AKWF 0013 wavetable', 'assorted single cycles'],
  wt_14: ['AKWF 0014 wavetable', 'assorted single cycles'],
  wt_15: ['AKWF 0015 wavetable', 'assorted single cycles'],
  wt_16: ['AKWF 0016 wavetable', 'assorted single cycles'],
  wt_17: ['AKWF 0017 wavetable', 'assorted single cycles'],
  wt_18: ['AKWF 0018 wavetable', 'assorted single cycles'],
  wt_19: ['AKWF 0019 wavetable', 'assorted single cycles'],
  wt_20: ['AKWF 0020 wavetable', 'assorted single cycles'],
  wt_aguitar: ['Acoustic guitar wavetable', 'guitar-like, plucked tone'],
  wt_altosax: ['Alto sax wavetable', 'reedy, sax-like'],
  wt_birds: ['Birds wavetable', 'chirpy, whistling', 'texture'],
  wt_bitreduced: ['Bit-reduced wavetable', 'lo-fi, crunchy, 8-bit'],
  wt_bw_blended: ['Blended basic wavetable', 'basic shapes, blended'],
  wt_bw_perfectwaves: ['Perfect waves wavetable', 'pure basic shapes'],
  wt_bw_saw: ['Saw wavetable', 'saw, bright, basic'],
  wt_bw_sawbright: ['Bright saw wavetable', 'saw, very bright'],
  wt_bw_sawgap: ['Gapped saw wavetable', 'saw, hollow, nasal'],
  wt_bw_sawrounded: ['Rounded saw wavetable', 'saw, softened'],
  wt_bw_sin: ['Sine wavetable', 'sine, pure'],
  wt_bw_squ: ['Square wavetable', 'square, hollow'],
  wt_bw_squrounded: ['Rounded square wavetable', 'square, softened'],
  wt_bw_tri: ['Triangle wavetable', 'triangle, soft'],
  wt_c604: ['C604 wavetable', 'digital, vintage synth'],
  wt_cello: ['Cello wavetable', 'bowed-like, dark'],
  wt_clarinett: ['Clarinet wavetable', 'woody, hollow'],
  wt_clavinet: ['Clavinet wavetable', 'clav-like, bright'],
  wt_dbass: ['Digital bass wavetable', 'digital bass', 'bass'],
  wt_distorted: ['Distorted wavetable', 'distorted, harsh'],
  wt_ebass: ['Electric bass wavetable', 'electric bass, round', 'bass'],
  wt_eguitar: ['Electric guitar wavetable', 'guitar-like, twangy'],
  wt_eorgan: ['Electric organ wavetable', 'organ, drawbar-like'],
  wt_epiano: ['Electric piano wavetable', 'e-piano, bell-like'],
  wt_flute: ['Flute wavetable', 'soft, flutey'],
  wt_fmsynth: ['FM synth wavetable', 'fm, metallic, digital'],
  wt_granular: ['Granular wavetable', 'granular, grainy'],
  wt_hdrawn: ['Hand-drawn wavetable', 'hand-drawn, odd'],
  wt_hvoice: ['Human voice wavetable', 'vowel, formant, vocal-like'],
  wt_linear: ['Linear wavetable', 'linear shapes, digital'],
  wt_oboe: ['Oboe wavetable', 'reedy, nasal'],
  wt_oscchip: ['Chip oscillator wavetable', 'chiptune, 8-bit'],
  wt_overtone: ['Overtone wavetable', 'harmonic series, organ-like'],
  wt_piano: ['Piano wavetable', 'piano-like tone'],
  wt_pluckalgo: ['Pluck algorithm wavetable', 'plucky, karplus-like'],
  wt_raw: ['Raw wavetable', 'raw, buzzy'],
  wt_sinharm: ['Sine harmonics wavetable', 'sine + harmonics, soft'],
  wt_snippets: ['Snippets wavetable', 'sampled snippets, odd'],
  wt_stereo: ['Stereo wavetable', 'wide, stereo'],
  wt_stringbox: ['String box wavetable', 'string-like, buzzy'],
  wt_symetric: ['Symmetric wavetable', 'symmetric shapes, hollow'],
  wt_theremin: ['Theremin wavetable', 'theremin-like, pure'],
  wt_vgame: ['Video game wavetable', 'chiptune, game, 8-bit'],
  wt_vgamebasic: ['Basic video game wavetable', 'chiptune, simple'],
  wt_violin: ['Violin wavetable', 'bowed-like, bright'],
};

// ─── Types, cache and helpers ─────────────────────────────────────────────────────────────────────

type SampleValue = string | string[];
type SampleMap = Record<string, unknown>;

interface Draft {
  sound: Omit<CatalogSound, 'brightness' | 'level' | 'range' | 'bytes' | 'durationSec'>;
  /** Superdough value to render when measuring (gain 1; C4 or n=0), and its cache signature. */
  probe: Record<string, unknown>;
  probeKey: string;
  /** The file variant 0 plays (C4 for pitched maps), for bytes/duration. */
  file?: string;
  /** GM font name of variant 0. */
  font?: string;
}

interface ZoneScan {
  lo: number;
  hi: number;
  loop: boolean;
  /** Decoded duration in seconds, 'error'/'timeout' when decoding failed, null when not decoded yet. */
  sec: number | 'error' | 'timeout' | null;
}

interface Level {
  /** Hash of the probe key: engine version, superdough value and the file it plays. */
  probe: string;
  rmsDb: number;
  peakDb: number;
  centroidHz: number;
}

interface Cache {
  version: 1;
  /** Vendored samples maps (and the GM font list) whose every file was checked to resolve, by id → content hash. */
  verified: Record<string, string>;
  /** GM font variants (preset names) that don't exist at the pinned soundfont base. */
  missingFonts: string[];
  files: Record<string, { bytes: number; durationSec: number | null }>;
  fonts: Record<string, { bytes: number; zones: ZoneScan[] }>;
  levels: Record<string, Level>;
}

const LEVELS_FILE = path.join(PALETTE_DIR, 'levels.json');
const CATALOG_FILE = path.join(PALETTE_DIR, 'catalog.json');
const MAPS_DIR = path.join(PALETTE_DIR, 'maps');
/** Renderer identity; part of every probe key so an engine upgrade re-measures. */
const ENGINE = 'superdough@1.3.0';
const SLOT_SEC = 1.25;
const PROBE_SEC = 1;
const LEAD_SEC = 0.05;
const BATCH = 40;
const PIANO_RANGE: readonly [number, number] = [21, 108];

const registeredKey = (key: string): string => key.toLowerCase().replace(/\s+/g, '_');

function readCache(): Cache {
  try {
    const cache = JSON.parse(fs.readFileSync(LEVELS_FILE, 'utf8')) as Cache;
    if (cache.version === 1) return { ...cache, verified: cache.verified ?? {}, missingFonts: cache.missingFonts ?? [] };
  } catch {
    // first run
  }
  return { version: 1, verified: {}, missingFonts: [], files: {}, fonts: {}, levels: {} };
}

/** One entry per line: small diffs, reviewable by eye. */
function writeCache(cache: Cache): void {
  const section = (record: Record<string, unknown>): string =>
    Object.keys(record)
      .sort()
      .map((key) => `  ${JSON.stringify(key)}: ${JSON.stringify(record[key])}`)
      .join(',\n');
  fs.writeFileSync(
    LEVELS_FILE,
    `{\n "version": 1,\n "verified": {\n${section(cache.verified)}\n },\n "missingFonts": ${JSON.stringify([...cache.missingFonts].sort())},\n "files": {\n${section(cache.files)}\n },\n "fonts": {\n${section(cache.fonts)}\n },\n "levels": {\n${section(cache.levels)}\n }\n}\n`,
  );
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return out;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return res;
      if (res.status < 500 || attempt >= 3) throw new Error(`${url}: HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

const NOTE_OFFSETS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Sample-map note keys like "A#3", "Ds1", "b2" (C4 = 60, as Strudel). */
export function noteKeyToMidi(key: string): number {
  const match = /^([a-g])(#|s|b|f)?(-?\d+)$/i.exec(key);
  if (!match) throw new Error(`not a note key: ${key}`);
  const accidental = match[2]?.toLowerCase();
  const shift = accidental === '#' || accidental === 's' ? 1 : accidental === 'b' || accidental === 'f' ? -1 : 0;
  return (Number(match[3]) + 1) * 12 + NOTE_OFFSETS[match[1]!.toLowerCase()]! + shift;
}

/** As superdough builds a sample URL: base + path, first '#' escaped (sampler.mjs loadBuffer). */
const sampleUrl = (base: string, file: string): string => `${base}${file}`.replace('#', '%23');

function filesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(String);
  return Object.values(value as Record<string, SampleValue>).flatMap((v) => (typeof v === 'string' ? [v] : v));
}

const contentHash = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The file superdough plays for C4 (pitched maps: closest note key, first wins ties) or n=0. */
function variantZeroFile(value: unknown): { file: string; count: number; pitched: boolean } {
  if (typeof value === 'string') return { file: value, count: 1, pitched: false };
  if (Array.isArray(value)) return { file: String(value[0]), count: value.length, pitched: false };
  const entries = Object.entries(value as Record<string, SampleValue>).filter(([key]) => !key.startsWith('_'));
  let best = entries[0]!;
  for (const entry of entries) if (Math.abs(noteKeyToMidi(entry[0]) - 60) < Math.abs(noteKeyToMidi(best[0]) - 60)) best = entry;
  const files = typeof best[1] === 'string' ? [best[1]] : best[1];
  const counts = entries.map(([, v]) => (typeof v === 'string' ? 1 : v.length));
  return { file: files[0]!, count: Math.min(...counts), pitched: true };
}

// ─── Maps: fetch, vendor, collisions ──────────────────────────────────────────────────────────────

interface Vendored {
  spec: SourceSpec;
  map: CatalogMap;
  json: SampleMap;
}

async function vendorMaps(offline: boolean, log: (line: string) => void): Promise<Vendored[]> {
  fs.mkdirSync(MAPS_DIR, { recursive: true });
  const upstreamMaps = offline ? null : await Promise.all(SOURCES.map(async (spec) => (await (await fetchOk(spec.map)).json()) as SampleMap));
  return SOURCES.map((spec, i) => {
    const file = path.join(MAPS_DIR, `${spec.id}.json`);
    const json = upstreamMaps ? vendor(spec, upstreamMaps[i]!) : (JSON.parse(fs.readFileSync(file, 'utf8')) as SampleMap);
    if (json._base !== spec.base) throw new Error(`${file}: _base is not ${spec.base ?? 'absent'}; rebuild without --offline`);
    if (upstreamMaps) fs.writeFileSync(file, `${JSON.stringify(json, null, 1)}\n`);
    const map: CatalogMap = {
      id: spec.id,
      kind: spec.kind,
      path: `/palette/maps/${spec.id}.json`,
      upstream: upstream(spec.repo),
      license: spec.license,
      order: i + 1,
    };
    log(`  ${String(map.order).padStart(2)} ${spec.id.padEnd(26)} ${Object.keys(json).filter((key) => key !== '_base').length} names`);
    return { spec, map, json };
  });
}

/** Upstream map → vendored map: pinned `_base`, drops and path fixes applied, shape checked. */
function vendor(spec: SourceSpec, upstreamJson: SampleMap): SampleMap {
  for (const key of [...Object.keys(spec.drop ?? {}), ...Object.keys(spec.fix ?? {})])
    if (!(key in upstreamJson)) throw new Error(`${spec.id}: ${key} (dropped or fixed) no longer exists upstream`);
  const json: SampleMap = spec.kind === 'samples' ? { _base: spec.base } : {};
  for (const [key, raw] of Object.entries(upstreamJson)) {
    if (key === '_base' || spec.drop?.[key]) continue;
    const value = applyFixes(spec, key, raw);
    if (spec.kind === 'samples') assertSampleValue(spec.id, key, value);
    else if (typeof value !== 'string' && !(Array.isArray(value) && value.every((v) => typeof v === 'string')))
      throw new Error(`${spec.id}: alias ${key} must be a string or string[]`);
    json[key] = value;
  }
  return json;
}

function applyFixes(spec: SourceSpec, key: string, value: unknown): unknown {
  const fix = spec.fix?.[key];
  if (!fix) return value;
  let changed = 0;
  const fixFile = (file: unknown): unknown => {
    if (typeof file !== 'string') return file;
    const fixed = fix.path(file);
    if (fixed !== file) changed++;
    return fixed;
  };
  const out = Array.isArray(value)
    ? value.map(fixFile)
    : typeof value === 'object' && value !== null
      ? Object.fromEntries(Object.entries(value).map(([note, v]) => [note, Array.isArray(v) ? v.map(fixFile) : fixFile(v)]))
      : fixFile(value);
  if (!changed) throw new Error(`${spec.id}: the path fix for ${key} no longer changes anything; remove it`);
  return out;
}

function assertSampleValue(source: string, key: string, value: unknown): void {
  const isFile = (v: unknown): boolean => typeof v === 'string' && v.length > 0 && !/^[a-z]+:/i.test(v);
  const ok =
    isFile(value) ||
    (Array.isArray(value) && value.length > 0 && value.every(isFile)) ||
    (typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.entries(value).every(([note, v]) => !note.startsWith('_') && (isFile(v) || (Array.isArray(v) && v.length > 0 && v.every(isFile)))));
  if (!ok) throw new Error(`${source}: unexpected sample value for ${key} (absolute URLs and nested _base are not allowed)`);
}

/**
 * Every name superdough will register, in order, with its owner, plus the names aliasBank() derives
 * for each registered key. Throws on any collision: with the drops applied, no registration may
 * overwrite another, so load order can't change what a name means.
 */
export function registeredNames(vendored: readonly { spec: Pick<SourceSpec, 'id' | 'kind'>; json: SampleMap }[]): {
  owners: Map<string, string>;
  aliases: Map<string, string[]>;
} {
  const owners = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  const claim = (name: string, owner: string): void => {
    const key = registeredKey(name);
    const previous = owners.get(key);
    if (previous) throw new Error(`name collision: "${key}" is registered by both ${previous} and ${owner}`);
    owners.set(key, owner);
  };
  for (const synth of ['sine', 'triangle', 'square', 'sawtooth', 'user', 'one', 'sbd', 'supersaw', 'bytebeat', 'pulse', 'bus', 'pink', 'white', 'brown', 'crackle'])
    claim(synth, BUILTIN_SOURCE);
  for (const alias of ['tri', 'sqr', 'saw', 'sin']) claim(alias, BUILTIN_SOURCE);
  for (const z of ['zzfx', 'z_sine', 'z_sawtooth', 'z_triangle', 'z_square', 'z_tan', 'z_noise']) claim(z, BUILTIN_SOURCE);
  for (const name of Object.keys(gm as Record<string, string[]>)) claim(name, SOUNDFONT_SOURCE);
  for (const { spec, json } of vendored) {
    if (spec.kind === 'samples') {
      for (const key of Object.keys(json)) if (key !== '_base') claim(key, spec.id);
      continue;
    }
    // Mirror superdough's aliasBankMap: split each key registered so far at '_' and alias `bank_suffix`.
    const map = Object.fromEntries(Object.entries(json).map(([bank, alias]) => [bank.toLowerCase(), alias as string | string[]]));
    for (const key of [...owners.keys()]) {
      const [bank, suffix] = key.split('_');
      const alias = bank ? map[bank] : undefined;
      if (!suffix || !alias) continue;
      for (const a of [alias].flat()) {
        const name = registeredKey(`${a}_${suffix}`);
        claim(name, `${spec.id} (alias of ${key})`);
        aliases.set(key, [...(aliases.get(key) ?? []), name]);
      }
    }
  }
  return { owners, aliases };
}

/** Every file of every samples map must resolve (1-byte range requests); cached per map content. */
async function verifyFiles(vendored: readonly Vendored[], cache: Cache, log: (line: string) => void): Promise<void> {
  const pending = vendored.filter((v) => v.spec.kind === 'samples' && cache.verified[v.spec.id] !== contentHash(v.json));
  if (!pending.length) return;
  const files = pending.flatMap(({ spec, json }) =>
    Object.entries(json).flatMap(([key, value]) => (key === '_base' ? [] : filesOf(value).map((file) => ({ where: `${spec.id}/${key}`, url: sampleUrl(spec.base!, file) })))),
  );
  log(`  verifying ${files.length} files in ${pending.map((v) => v.spec.id).join(', ')}`);
  const broken: string[] = [];
  await mapLimit(files, 32, async ({ where, url }) => {
    try {
      await (await fetchOk(url, { headers: { range: 'bytes=0-0' } })).arrayBuffer();
    } catch (err) {
      broken.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (broken.length) throw new Error(`${broken.length} sample files do not resolve; drop or fix them in SOURCES:\n  ${broken.sort().join('\n  ')}`);
  for (const v of pending) cache.verified[v.spec.id] = contentHash(v.json);
}

/** Every font variant `n` can select must exist at the pinned base; upstream gm.mjs has a few typos. */
async function verifyFonts(cache: Cache, log: (line: string) => void): Promise<void> {
  const names = [...new Set(Object.values(gm as Record<string, string[]>).flat())].sort();
  if (cache.verified[SOUNDFONT_SOURCE] === contentHash(names)) return;
  log(`  verifying ${names.length} soundfont presets`);
  const missing: string[] = [];
  await mapLimit(names, 32, async (name) => {
    try {
      if (!name) throw new Error('empty preset name');
      await (await fetchOk(`${SOUNDFONT_BASE}/${name}.js`, { headers: { range: 'bytes=0-0' } })).arrayBuffer();
    } catch {
      missing.push(name);
    }
  });
  cache.missingFonts = missing.sort();
  cache.verified[SOUNDFONT_SOURCE] = contentHash(names);
}

// ─── Drafts ───────────────────────────────────────────────────────────────────────────────────────

function curated(id: string, entry: Curated | undefined, source: string): Curated {
  if (!entry) throw new Error(`${source}: "${id}" has no curation entry; add it to the table in scripts/build-catalog.ts`);
  if (!FAMILIES[entry[0]]) throw new Error(`${source}: "${id}" uses unknown family ${entry[0]}`);
  return entry;
}

function sampleDraft(opts: {
  id: string;
  kind: SoundKind;
  family: string;
  label: string;
  tags: string;
  category?: SoundCategory;
  source: Vendored;
  value: unknown;
  usage: CatalogSound['usage'];
  machine?: string;
}): Draft {
  const { file, count, pitched } = variantZeroFile(opts.value);
  const url = sampleUrl(opts.source.spec.base!, file);
  const isPitched = pitched || opts.kind === 'wavetable';
  const probe: Record<string, unknown> = { s: opts.usage.s, ...(opts.usage.bank ? { bank: opts.usage.bank } : {}), n: 0, gain: 1 };
  if (isPitched) probe.note = 60;
  if (opts.kind === 'sample') probe.clip = 1;
  return {
    sound: {
      id: opts.id,
      kind: opts.kind,
      category: opts.category ?? FAMILIES[opts.family]!.category,
      family: opts.family,
      tags: opts.tags,
      label: opts.label,
      count,
      pitched: isPitched,
      source: opts.source.spec.id,
      ...(opts.machine ? { machine: opts.machine } : {}),
      usage: opts.usage,
      license: opts.source.spec.license,
    },
    probe,
    probeKey: `${ENGINE} ${JSON.stringify(probe)} ${url}`,
    file: url,
  };
}

function builtinDrafts(): Draft[] {
  return SYNTHS.map((synth) => {
    if (!FAMILIES[synth.family]) throw new Error(`synth ${synth.id}: unknown family ${synth.family}`);
    const probe: Record<string, unknown> = { s: synth.id, gain: 1, ...(synth.pitched ? { note: 60 } : {}) };
    return {
      sound: {
        id: synth.id,
        kind: 'synth',
        category: synth.category ?? FAMILIES[synth.family]!.category,
        family: synth.family,
        tags: synth.tags,
        label: synth.label,
        count: 1,
        pitched: synth.pitched,
        source: BUILTIN_SOURCE,
        usage: { s: synth.id },
        ...(synth.aliases ? { aliases: synth.aliases } : {}),
        license: 'AGPL-3.0',
      },
      probe,
      probeKey: `${ENGINE} ${JSON.stringify(probe)}`,
    };
  });
}

function soundfontDrafts(missingFonts: ReadonlySet<string>): Draft[] {
  const fonts = gm as Record<string, string[]>;
  const missing = Object.keys(fonts).filter((name) => !GM[name]);
  const extra = Object.keys(GM).filter((name) => !fonts[name]);
  if (missing.length || extra.length) throw new Error(`GM table out of sync with @strudel/soundfonts: missing ${missing.join(', ')}; extra ${extra.join(', ')}`);
  return Object.entries(fonts).map(([name, variants]) => {
    const [label, family, tags, category] = GM[name]!;
    if (!FAMILIES[family]) throw new Error(`${name}: unknown family ${family}`);
    const font = variants[0]!;
    if (missingFonts.has(font)) throw new Error(`${name}: variant 0 (${font}) is missing upstream`);
    const failing = variants.flatMap((variant, n) => (missingFonts.has(variant) ? [n] : []));
    const sf2 = font.replace(/^\d+_/, '').replace(/_sf2(_file)?$/, '').replace(/_/g, ' ');
    return {
      sound: {
        id: name,
        kind: 'soundfont',
        category: category ?? FAMILIES[family]!.category,
        family,
        tags,
        label,
        count: variants.length,
        ...(failing.length ? { failingVariants: failing } : {}),
        pitched: true,
        source: SOUNDFONT_SOURCE,
        usage: { s: name },
        license: `MIT (webaudiofontdata) / ${sf2} soundfont`,
      },
      // The probe note is settled once the range is known (C4 when playable).
      probe: { s: name, n: 0, gain: 1, note: 60 },
      probeKey: '',
      font,
    };
  });
}

function mapDrafts(vendored: Vendored): Draft[] {
  const { spec, json } = vendored;
  const keys = Object.keys(json).filter((key) => key !== '_base');
  switch (spec.id) {
    case 'dirt-samples':
      return keys.map((key) => {
        const [family, label, tags, category] = curated(key, DIRT[key], spec.id);
        return sampleDraft({ id: registeredKey(key), kind: 'sample', family, label, tags, category, source: vendored, value: json[key], usage: { s: key } });
      });
    case 'tidal-drum-machines':
      return keys.map((key) => {
        const cut = key.indexOf('_');
        const machine = key.slice(0, cut);
        const part = key.slice(cut + 1);
        const machineInfo = MACHINES[machine];
        const partInfo = MACHINE_PARTS[part];
        if (!machineInfo || !partInfo) throw new Error(`${spec.id}: no curation for ${key}`);
        const id = registeredKey(key);
        return sampleDraft({
          id,
          kind: 'sample',
          family: partInfo[0],
          label: `${machineInfo[0]} ${partInfo[1]}`,
          tags: MACHINE_TAGS[id] ?? `${partInfo[2]}, ${machineInfo[1]}`,
          source: vendored,
          value: json[key],
          usage: { s: part, bank: machine },
          machine,
        });
      });
    case 'vcsl':
      return keys.map((key) => {
        const [family, label, tags, category] = curated(key, VCSL[key], spec.id);
        return sampleDraft({ id: key, kind: 'sample', family, label, tags, category, source: vendored, value: json[key], usage: { s: key } });
      });
    case 'salamander-piano':
      return keys.map((key) =>
        sampleDraft({
          id: key,
          kind: 'sample',
          family: 'piano/salamander',
          label: 'Salamander grand piano',
          tags: 'grand piano, natural, dynamic',
          source: vendored,
          value: json[key],
          usage: { s: key },
        }),
      );
    case 'mridangam':
      return keys.map((key) => {
        const tags = MRIDANGAM[key];
        if (!tags) throw new Error(`${spec.id}: no curation for ${key}`);
        return sampleDraft({
          id: key,
          kind: 'sample',
          family: 'world/percussion',
          label: `Mridangam ${key}`,
          tags: `mridangam, carnatic, ${tags}`,
          source: vendored,
          value: json[key],
          usage: { s: key },
        });
      });
    case 'switchangel-breaks':
      return keys.map((key) =>
        sampleDraft({
          id: key,
          kind: 'sample',
          family: 'break/loop',
          label: 'Breaks (switchangel)',
          tags: 'breakbeat, 2 bars at 165 bpm, dnb',
          source: vendored,
          value: json[key],
          usage: { s: key },
        }),
      );
    case 'switchangel-pad':
      return keys.map((key) =>
        sampleDraft({
          id: key,
          kind: 'sample',
          family: 'pad/sampled',
          label: 'Pads (switchangel)',
          tags: 'pad, lush, 6-23 s long',
          source: vendored,
          value: json[key],
          usage: { s: key },
        }),
      );
    case 'clean-breaks':
      return keys.map((key) => {
        const info = CLEAN_BREAKS[key];
        if (!info) throw new Error(`${spec.id}: no curation for ${key}`);
        return sampleDraft({
          id: key,
          kind: 'sample',
          family: 'break/loop',
          label: `${info[0]} break`,
          tags: `classic break, funk, ${info[1]}`,
          source: vendored,
          value: json[key],
          usage: { s: key },
        });
      });
    case 'crate':
      return keys.map((key) => {
        const [family, label, tags, category] = curated(key, CRATE[key], spec.id);
        return sampleDraft({ id: key, kind: 'sample', family, label, tags, category, source: vendored, value: json[key], usage: { s: key } });
      });
    case 'uzu-wavetables':
      return keys.map((key) => {
        if (key !== 'wt_digital') throw new Error(`${spec.id}: no curation for ${key}`);
        return sampleDraft({
          id: key,
          kind: 'wavetable',
          family: 'wavetable/uzu',
          label: 'Digital wavetable',
          tags: 'digital, glassy, morphing',
          source: vendored,
          value: json[key],
          usage: { s: key },
        });
      });
    case 'akwf':
      return keys.map((key) => {
        const info = AKWF[key];
        if (!info) throw new Error(`${spec.id}: no curation for ${key}`);
        return sampleDraft({
          id: key,
          kind: 'wavetable',
          family: 'wavetable/akwf',
          label: info[0],
          tags: info[1],
          category: info[2],
          source: vendored,
          value: json[key],
          usage: { s: key },
        });
      });
    default:
      throw new Error(`no draft builder for source ${spec.id}`);
  }
}

// ─── File metadata ────────────────────────────────────────────────────────────────────────────────

/** Duration from a WAV header (needs the fmt and data chunk headers), or null. */
export function wavDuration(head: Buffer, totalBytes: number): number | null {
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= head.length; ) {
    const id = head.toString('ascii', offset, offset + 4);
    const size = head.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 16 <= head.length) byteRate = head.readUInt32LE(offset + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const available = totalBytes - (offset + 8);
      const dataBytes = size > 0 && size <= available ? size : available;
      return Math.round((dataBytes / byteRate) * 1000) / 1000;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function probeFile(url: string): Promise<{ bytes: number; durationSec: number | null }> {
  const res = await fetchOk(url, { headers: { range: 'bytes=0-65535' } });
  const head = Buffer.from(await res.arrayBuffer());
  const total = res.status === 206 ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1]) : head.length;
  if (!Number.isFinite(total) || total <= 0) throw new Error(`${url}: no content length`);
  return { bytes: total, durationSec: /\.wav$/i.test(new URL(url).pathname) ? wavDuration(head, total) : null };
}

// ─── Soundfont zones and ranges ───────────────────────────────────────────────────────────────────

interface Zone {
  keyRangeLow: number;
  keyRangeHigh: number;
  loopStart?: number;
  loopEnd?: number;
  file?: string;
  sample?: string;
}

/** Parses a webaudiofont preset (`var _tone_x = { zones: [...] }`) as data, without evaluating it. */
export function parseFontZones(source: string): Zone[] {
  const ast = acorn.parse(source, { ecmaVersion: 2022 }) as unknown as acorn.Program;
  for (const statement of ast.body) {
    if (statement.type !== 'VariableDeclaration') continue;
    for (const declaration of statement.declarations) {
      const value = declaration.init ? literal(declaration.init) : undefined;
      if (value && typeof value === 'object' && Array.isArray((value as { zones?: unknown }).zones)) return (value as { zones: Zone[] }).zones;
    }
  }
  throw new Error('no zones found in soundfont preset');
}

function literal(node: acorn.Expression): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') return -node.argument.value;
      break;
    case 'BinaryExpression': {
      // Some presets carry arithmetic, e.g. `originalPitch:4200-140`.
      const left = node.left.type === 'PrivateIdentifier' ? undefined : literal(node.left);
      const right = literal(node.right);
      if (typeof left !== 'number' || typeof right !== 'number') break;
      if (node.operator === '+') return left + right;
      if (node.operator === '-') return left - right;
      if (node.operator === '*') return left * right;
      if (node.operator === '/') return left / right;
      break;
    }
    case 'ArrayExpression':
      return node.elements.map((element) => (element && element.type !== 'SpreadElement' ? literal(element) : null));
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type !== 'Property' || property.computed) throw new Error('unsupported property in soundfont preset');
        const key = property.key.type === 'Identifier' ? property.key.name : String((property.key as acorn.Literal).value);
        out[key] = literal(property.value as acorn.Expression);
      }
      return out;
    }
  }
  throw new Error(`unsupported ${node.type} in soundfont preset`);
}

/** Tiny unlooped zones decode to a click; tiny looped zones are single-cycle waves and play fine. */
const zonePlayable = (zone: ZoneScan): boolean => zone.sec === null || (typeof zone.sec === 'number' && zone.sec > 0 && (zone.loop || zone.sec >= 0.02));

/** Longest run of MIDI notes (A0..C8) whose zone (fontloader's first match) plays, preferring runs containing C4. */
export function playableRange(zones: readonly ZoneScan[]): [number, number] | null {
  const runs: [number, number][] = [];
  let start: number | null = null;
  for (let midi = PIANO_RANGE[0]; midi <= PIANO_RANGE[1] + 1; midi++) {
    const zone = midi <= PIANO_RANGE[1] ? zones.find((z) => z.lo <= midi && z.hi + 1 >= midi) : undefined;
    const ok = zone !== undefined && zonePlayable(zone);
    if (ok && start === null) start = midi;
    if (!ok && start !== null) {
      runs.push([start, midi - 1]);
      start = null;
    }
  }
  if (!runs.length) return null;
  const length = (run: [number, number]): number => run[1] - run[0];
  const withC4 = runs.filter(([lo, hi]) => lo <= 60 && hi >= 60);
  return (withC4.length ? withC4 : runs).reduce((best, run) => (length(run) > length(best) ? run : best));
}

async function scanFonts(fontNames: readonly string[], cache: Cache, renderer: Renderer | null, log: (line: string) => void): Promise<void> {
  const pending = fontNames.filter((font) => !cache.fonts[font] || (renderer && cache.fonts[font]!.zones.some((z) => z.sec === null)));
  if (!pending.length) return;
  log(`  scanning ${pending.length} soundfont presets${renderer ? ' (decoding every zone)' : ' (key ranges only; run with --measure to decode)'}`);
  await mapLimit(pending, 4, async (font) => {
    const text = await (await fetchOk(`${SOUNDFONT_BASE}/${font}.js`)).text();
    const zones = parseFontZones(text);
    const decoded = renderer ? await renderer.decode(zones.map((z) => z.file ?? '')) : null;
    cache.fonts[font] = {
      bytes: Buffer.byteLength(text),
      zones: zones.map((zone, i) => {
        const loop = (zone.loopStart ?? 0) > 1 && (zone.loopStart ?? 0) < (zone.loopEnd ?? 0);
        const sec = zone.sample ? (zone.sample.length > 0 ? 1 : 'error') : !zone.file ? 'error' : decoded ? decoded[i]! : null;
        return { lo: zone.keyRangeLow, hi: zone.keyRangeHigh, loop, sec };
      }),
    };
  });
}

// ─── Measurement ──────────────────────────────────────────────────────────────────────────────────

/** Spectral centroid → 0..1 on a log scale: 80 Hz → 0, 12 kHz → 1. */
export const centroidToBrightness = (hz: number): number => Math.round(Math.min(1, Math.max(0, Math.log(hz / 80) / Math.log(12000 / 80))) * 100) / 100;

async function measure(drafts: readonly Draft[], cache: Cache, renderer: Renderer, log: (line: string) => void): Promise<{ measured: number; failed: { id: string; error: string }[] }> {
  const todo = drafts.filter((d) => cache.levels[d.sound.id]?.probe !== contentHash(d.probeKey));
  const failed: { id: string; error: string }[] = [];
  let measured = 0;
  log(`  measuring ${todo.length} sounds (${drafts.length - todo.length} cached) in batches of ${BATCH}`);
  for (let start = 0; start < todo.length; start += BATCH) {
    const batch = todo.slice(start, start + BATCH);
    const events: RenderEvent[] = batch.map((draft, i) => ({ value: draft.probe, t: LEAD_SEC + i * SLOT_SEC, duration: PROBE_SEC }));
    const began = Date.now();
    const result = await renderer.renderEvents(events, batch.length * SLOT_SEC + LEAD_SEC);
    batch.forEach((draft, i) => {
      const error = result.eventErrors[i];
      const t = events[i]!.t;
      const stats = analyzeAudio(result.audio, { from: t, to: t + PROBE_SEC });
      if (error || !Number.isFinite(stats.rmsDb) || stats.rmsDb < -90) {
        failed.push({ id: draft.sound.id, error: error ?? `silent (rms ${stats.rmsDb} dBFS)` });
        delete cache.levels[draft.sound.id];
        return;
      }
      cache.levels[draft.sound.id] = { probe: contentHash(draft.probeKey), rmsDb: stats.rmsDb, peakDb: stats.peakDb, centroidHz: stats.centroidHz };
      measured++;
    });
    writeCache(cache);
    log(`    ${Math.min(start + BATCH, todo.length)}/${todo.length} (${Date.now() - began} ms)`);
  }
  return { measured, failed };
}

// ─── Assembly ─────────────────────────────────────────────────────────────────────────────────────

function finish(draft: Draft, cache: Cache): CatalogSound {
  const { sound } = draft;
  const level = cache.levels[sound.id];
  const file = draft.file ? cache.files[draft.file] : undefined;
  const font = draft.font ? cache.fonts[draft.font] : undefined;
  const range = font ? playableRange(font.zones) : null;
  if (draft.font && !range) throw new Error(`${sound.id}: no playable range`);
  const bytes = file?.bytes ?? font?.bytes;
  const durationSec = file?.durationSec ?? undefined;
  // Field order follows src/shared/catalog.ts.
  return {
    id: sound.id,
    kind: sound.kind,
    category: sound.category,
    family: sound.family,
    tags: sound.tags,
    label: sound.label,
    count: sound.count,
    ...(sound.failingVariants?.length ? { failingVariants: sound.failingVariants } : {}),
    pitched: sound.pitched,
    source: sound.source,
    ...(sound.machine ? { machine: sound.machine } : {}),
    usage: sound.usage,
    ...(range ? { range } : {}),
    brightness: level && level.centroidHz > 0 ? centroidToBrightness(level.centroidHz) : FAMILIES[sound.family]!.brightness,
    level: level ? { rmsDb: level.rmsDb, peakDb: level.peakDb, centroidHz: level.centroidHz } : null,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(durationSec !== undefined ? { durationSec } : {}),
    ...(sound.aliases?.length ? { aliases: sound.aliases } : {}),
    license: sound.license,
  };
}

function formatCatalog(catalog: Catalog): string {
  const lines = (items: readonly unknown[]): string => items.map((item) => `  ${JSON.stringify(item)}`).join(',\n');
  return [
    '{',
    ` "version": ${JSON.stringify(catalog.version)},`,
    ` "generatedAt": ${JSON.stringify(catalog.generatedAt)},`,
    ` "soundfontBase": ${JSON.stringify(catalog.soundfontBase)},`,
    ` "maps": [\n${lines(catalog.maps)}\n ],`,
    ` "sounds": [\n${lines(catalog.sounds)}\n ]`,
    '}',
    '',
  ].join('\n');
}

function report(catalog: Catalog, log: (line: string) => void): void {
  const count = (key: (s: CatalogSound) => string): [string, number][] => {
    const counts = new Map<string, number>();
    for (const sound of catalog.sounds) counts.set(key(sound), (counts.get(key(sound)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  log(`\n${catalog.sounds.length} sounds; ${catalog.sounds.filter((s) => s.level).length} with measured levels; ${catalog.sounds.filter((s) => s.range).length} with ranges`);
  log(`by category: ${count((s) => s.category).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log(`by kind: ${count((s) => s.kind).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log(`by source: ${count((s) => s.source).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log('by family:');
  for (const [family, n] of count((s) => s.family)) log(`  ${family.padEnd(22)} ${n}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      measure: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      quiet: { type: 'boolean', default: false },
    },
  });
  if (values.offline && values.measure) throw new Error('--measure needs the network; drop --offline');
  const log = values.quiet ? () => {} : (line: string) => console.log(line);
  const began = Date.now();
  let phase = Date.now();
  const lap = (name: string): void => {
    log(`  ${name}: ${((Date.now() - phase) / 1000).toFixed(1)} s`);
    phase = Date.now();
  };

  log(values.offline ? 'maps (vendored copies, --offline)' : 'maps (pinned upstream)');
  const vendored = await vendorMaps(values.offline, log);
  const { owners, aliases } = registeredNames(vendored);
  for (const blocked of BLOCKED_SOUNDS) if (owners.get(blocked) !== BUILTIN_SOURCE) throw new Error(`blocked sound ${blocked} is registered by ${owners.get(blocked)}`);
  log(`  ${owners.size} registered names (${[...aliases.values()].flat().length} bank aliases), no collisions`);
  lap('vendor');

  const cache = readCache();
  if (!values.offline) {
    await verifyFiles(vendored, cache, log);
    await verifyFonts(cache, log);
    writeCache(cache);
    lap('verify files');
  }

  const drafts = [...builtinDrafts(), ...soundfontDrafts(new Set(cache.missingFonts)), ...vendored.filter((v) => v.spec.kind === 'samples').flatMap(mapDrafts)].filter((d) => !BLOCKED_SOUNDS.has(d.sound.id));
  for (const draft of drafts) {
    const derived = aliases.get(draft.sound.id);
    if (derived) draft.sound.aliases = [...(draft.sound.aliases ?? []), ...derived];
  }

  const files = [...new Set(drafts.flatMap((d) => (d.file ? [d.file] : [])))].filter((url) => !cache.files[url]);
  if (files.length) {
    if (values.offline) throw new Error(`--offline but ${files.length} files have no cached size`);
    log(`  probing ${files.length} sample files for size and length`);
    await mapLimit(files, 16, async (url) => {
      cache.files[url] = await probeFile(url);
    });
    writeCache(cache);
  }
  lap('file metadata');

  const fonts = drafts.flatMap((d) => (d.font ? [d.font] : []));
  const renderer = values.measure
    ? await openRenderer({ maps: vendored.map((v) => v.map), soundfontBase: SOUNDFONT_BASE, paletteDir: PALETTE_DIR, log: (line) => log(`  ${line}`) })
    : null;
  try {
    if (!values.offline) await scanFonts(fonts, cache, renderer, log);
    for (const draft of drafts) {
      if (!draft.font) continue;
      const range = cache.fonts[draft.font] ? playableRange(cache.fonts[draft.font]!.zones) : null;
      if (!range) throw new Error(`${draft.sound.id}: no scanned zones for ${draft.font}`);
      draft.probe.note = range[0] <= 60 && range[1] >= 60 ? 60 : Math.round((range[0] + range[1]) / 2);
      draft.probeKey = `${ENGINE} ${JSON.stringify(draft.probe)} ${SOUNDFONT_BASE}/${draft.font}.js`;
    }
    writeCache(cache);
    lap('soundfont ranges');
    if (renderer) {
      const { measured, failed } = await measure(drafts, cache, renderer, log);
      log(`  measured ${measured}, failed ${failed.length}`);
      for (const f of failed) log(`    ✗ ${f.id}: ${f.error}`);
      lap('levels');
    }
  } finally {
    await renderer?.close();
  }

  const unverified = fonts.filter((font) => cache.fonts[font]!.zones.some((z) => z.sec === null));
  if (unverified.length) log(`  warning: ${unverified.length} soundfont presets have undecoded zones; ranges assume they play (run with --measure)`);

  const ids = new Set(drafts.map((d) => d.sound.id));
  // Prune cache entries nothing refers to any more.
  const usedFiles = new Set(drafts.flatMap((d) => (d.file ? [d.file] : [])));
  for (const url of Object.keys(cache.files)) if (!usedFiles.has(url)) delete cache.files[url];
  for (const font of Object.keys(cache.fonts)) if (!fonts.includes(font)) delete cache.fonts[font];
  for (const id of Object.keys(cache.levels)) if (!ids.has(id)) delete cache.levels[id];
  for (const id of Object.keys(cache.verified)) if (id !== SOUNDFONT_SOURCE && !SOURCES.some((spec) => spec.id === id)) delete cache.verified[id];
  writeCache(cache);

  const body = { soundfontBase: SOUNDFONT_BASE, maps: vendored.map((v) => v.map), sounds: drafts.map((d) => finish(d, cache)) };
  const version = `sha256-${contentHash(body)}`;
  let generatedAt = new Date().toISOString();
  try {
    const previous = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8')) as Catalog;
    if (previous.version === version) generatedAt = previous.generatedAt;
  } catch {
    // no previous catalog
  }
  const catalog: Catalog = { version, generatedAt, ...body };
  fs.writeFileSync(CATALOG_FILE, formatCatalog(catalog));
  report(catalog, log);
  log(`\nwrote ${path.relative(REPO_ROOT, CATALOG_FILE)} (${version}) in ${((Date.now() - began) / 1000).toFixed(1)} s`);
}

if (import.meta.main) await main();
