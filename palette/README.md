# palette/

The sound catalog every part of B-Side shares: the validator's list of known sounds, the analyzer's
level and brightness priors, the conductor's crate, the composer's prompt and the listener's engine
all read `catalog.json` (typed by `src/shared/catalog.ts`). The server serves this directory at
`/palette/*`.

| File | What it is |
|---|---|
| `catalog.json` | The catalog: maps in registration order, then every sound (one per line). Generated. |
| `maps/*.json` | Vendored sample maps. Upstream content with `_base` rewritten to a **commit-pinned** `raw.githubusercontent.com` URL. Generated. |
| `levels.json` | Build cache: which maps were verified, missing soundfont presets, sample file sizes/lengths, soundfont zone scans and measured levels, keyed by content hash, pinned URL or probe. Committed, so a rebuild without `--measure` (or with `--offline`) is byte-identical. |

## Regenerating

```sh
npm run catalog                 # re-fetch the pinned maps, rebuild catalog.json from the cache
npm run catalog -- --measure    # also render every unmeasured sound and decode soundfont zones (headless Chromium)
npm run catalog -- --offline    # rebuild from the vendored maps and the cache, no network
```

Every build checks that every file every map references resolves (a one-byte range request per
file; about 11,000 files, under a minute), cached per map content, and fails on any broken file: fix
or drop it in `SOURCES`. It also checks all 869 soundfont presets `gm.mjs` names; variants that don't
exist are called out in the sound's tags (`n=1 fails`).

`--measure` renders sounds in batches of 40 with the real pinned `@strudel/*` packages (bundled by
Vite, run in headless Chromium by `scripts/render-audio.ts`); only new or changed sounds are rendered
on later runs. Samples are fetched by Node and handed to the browser (the sandboxed browser cannot
trust the egress proxy's CA). A build from an empty cache took 2 min 38 s here: file verification
33 s, soundfont zone decoding 16 s, levels of 1,302 sounds 106 s. It downloads about 330 MB (variant
0 of every sample, one preset per GM instrument).

`scripts/render-audio.ts` is also a CLI for auditioning code offline:

```sh
node --disable-warning=ExperimentalWarning --import ./src/server/node-hooks.ts scripts/render-audio.ts \
  --bpm 120 --bars 4 --out /tmp/x.wav 'note("c3 e3 g3").s("gm_epiano1")'
node … scripts/render-audio.ts --list sections.json --out-dir /tmp/renders   # [{ id, code, bpm?, bars? }]; default dir $TMPDIR/bside-renders
```

It prints peak/RMS dBFS, clipped-sample percentage and spectral centroid per render. Offline renders
have no `room` tail: superdough builds the reverb impulse response asynchronously in a nested
`OfflineAudioContext`.

To pin newer upstream content, update `PINNED` in `scripts/build-catalog.ts` with
`git ls-remote https://github.com/<repo> HEAD`, rebuild with `--measure`, and read the diff of
`catalog.json`: the build fails on any new name collision or unknown bank, which then needs a
curation entry (family, label, tags) or a deliberate drop.

## Sources and pinned commits

Registered in this order (`CatalogMap.order`). The build asserts that no two maps, synths,
soundfonts or derived bank aliases register the same name, so load order never changes what
`s("bd:3")` means.

| # | Map id | Audio from | Map from | Pinned commit | License |
|---|---|---|---|---|---|
| 1 | `dirt-samples` | tidalcycles/Dirt-Samples | same | `c74fc80f8db8038f6a33648ffef5ac00a07ad402` | none stated |
| 2 | `tidal-drum-machines` | ritchse/tidal-drum-machines | felixroos/dough-samples | `15eac73c5e878550f91d864a4863e014799403f1` (audio), `9eacfc86ec4393e68a463ff52b01c19cfaa77f38` (map) | none stated |
| 3 | `tidal-drum-machines-alias` | (bank aliases, `aliasBank()`) | todepond/samples | `f58b317308194e9a8523a4ccd687684375f72da5` | none stated |
| 4 | `vcsl` | sgossner/VCSL | felixroos/dough-samples | `c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e` | CC0 1.0 |
| 5 | `salamander-piano` | felixroos/dough-samples `piano/` | same | `9eacfc86ec4393e68a463ff52b01c19cfaa77f38` | CC BY 3.0 |
| 6 | `mridangam` | yaxu/mrid | felixroos/dough-samples | `5ba409cabb2893e6e8a52a15a2812c35585cdadb` | CC BY-SA 4.0 |
| 7 | `switchangel-breaks` | switchangel/breaks | same | `13784b105c6f55eb20653a510f70e6df1f1b6e32` | Unlicense |
| 8 | `switchangel-pad` | switchangel/pad | same | `4f1b7bbddc72556a4246cc24e5ef282812f44d80` | Unlicense |
| 9 | `clean-breaks` | yaxu/clean-breaks | same | `df569e8de311c8f042f6e53f89d08c6162d32c9b` | none stated |
| 10 | `crate` | eddyflux/crate | same | `11c0a953128f2026b0c1c477188c49311de1bbf5` | none stated |
| 11 | `uzu-wavetables` | tidalcycles/uzu-wavetables | same | `3432ce3f35746356728f9bea3fea4b76624f98cd` | none stated |
| 12 | `akwf` | Bubobubobubobubo/Dough-Waveforms (AKWF) | same | `125801fa9a799117fd0a0350a195ab7c2f4cdf13` | CC0 1.0 (AKWF-FREE) |
| — | `soundfonts` (GM, `gm_*`) | felixroos/webaudiofontdata `sound/` | `@strudel/soundfonts` 1.3.0 `gm.mjs` | `23ca907d4370a04fd89ca483a92915e4d6159ab9` | MIT code; samples from the JCLive, Aspirin, FluidR3 GM, Chaos and Acoustic Guitar soundfonts (see below) |
| — | `builtin` synths | superdough 1.3.0 | — | npm lockfile | AGPL-3.0 |

`soundfontBase` is `https://raw.githubusercontent.com/felixroos/webaudiofontdata/23ca907d4370a04fd89ca483a92915e4d6159ab9/sound`.
Soundfont presets are JavaScript that `@strudel/soundfonts` evaluates, which is why the base must
be an immutable commit URL and never the upstream GitHub Pages site. The build itself parses presets
with acorn as data and never evaluates them.

### Attribution

Sets that require attribution (the room's credits must show these):

- **Salamander Grand Piano** by Alexander Holm, CC BY 3.0 —
  <https://archive.org/details/SalamanderGrandPianoV3> (via felixroos/dough-samples).
- **Mridangam samples** © Arthur Carabott 2022, performed by Harishankar V Menon, CC BY-SA 4.0 —
  <https://github.com/yaxu/mrid>, <https://www.arthurcarabott.com/konnakkol/>. Whether a live
  performance built from these samples counts as adapted material under BY-SA is not settled here;
  attribute it regardless, and keep any edited copies of the samples under BY-SA.
- **webaudiofontdata** © 2017 Sergey Surikov, MIT. Its soundfont samples come from GeneralUser GS
  (S. Christian Collins), FluidR3 GM (Frank Wen, MIT) and freeware soundfonts (JCLive, Aspirin,
  Chaos, Acoustic Guitar) whose terms are not stated upstream.

Credited as a courtesy: VCSL (Versilian Studios, CC0), AKWF waveforms (Kristoffer Ekstrand, CC0),
switchangel breaks and pads (Unlicense), Dirt-Samples (TidalCycles contributors),
tidal-drum-machines (geikha / ritchse), clean-breaks (Alex McLean), eddyflux crate, uzu wavetables
(`wt_digital` by Glossing).

**Unclear rights.** Dirt-Samples, tidal-drum-machines, clean-breaks, crate and uzu-wavetables have
no license file at the pinned commits. The drum machines are recordings of commercial hardware and
clean-breaks are loops from commercial funk/soul records. Like strudel.cc, B-Side hot-links them from
GitHub rather than redistributing the audio; clear the rights before self-hosting those sets.

## Deliberate exclusions and fixes

| What | Why |
|---|---|
| Dirt-Samples `sax` | Collides with VCSL's pitched `sax`, which is what `s("sax")` means on strudel.cc. |
| uzu-wavetables `wt_vgame` | Collides with AKWF's `wt_vgame` (137 waves), a superset of the same AKWF source. |
| tidal-drum-machines `OberheimDMX_` | Empty instrument name, not addressable with `s()`/`.bank()`. |
| VCSL `tom_mallet` paths | Fixed, not dropped: the dough-samples map omits the `Membranophones/` folder, so every file 404s upstream (and on strudel.cc). |
| Dirt-Samples `h:1`, `h:2` paths | Fixed: the file names contain a bare `%` (`da0-50%_1000…`), an invalid URL escape (HTTP 400); vendored as `%25`. |
| Dirt-Samples `bubble:0` | Kept, but tagged: the file is silent (−98 dBFS), so the sound has no measured level. |
| uzu-drumkit, `bubo:samples`, `mot4i/garden` | Not loaded: they override core names (`bd`, `bass`, `pad`, `perc`, `stab`, …). |
| dough-samples `Dirt-Samples.json`, `EmuSP12.json` | Subsets of maps already loaded in full. |
| shabda | Dynamic third-party service; not pinnable. |
| `bytebeat`, `bus`, `user`, `one` | `BLOCKED_SOUNDS`: code-execution sinks or engine internals. |

## Taxonomy

Each sound has one of the six `SOUND_CATEGORIES` (crate strata) and a family from the closed list
below (defined in `FAMILIES` in `scripts/build-catalog.ts`; the build rejects anything else). The
default category of a family can be overridden per sound (e.g. `gm_tuba` is `bass`, `juno` is
`harmonic`). The brightness column is the prior used when a sound has no measurement.

| Family | Default category | Brightness prior | Contents |
|---|---|---|---|
| `synth/basic` | harmonic | 0.30 | plain oscillators: sine, triangle, square, sawtooth |
| `synth/detuned` | harmonic | 0.70 | supersaw |
| `synth/pulse` | melodic | 0.55 | pulse with pulse-width modulation |
| `synth/kick` | percussion | 0.12 | superdough's synthesized kick (`sbd`) |
| `synth/noise` | texture | 0.80 | white, pink, brown noise, crackle |
| `synth/zzfx` | melodic | 0.50 | ZzFX procedural chip/sfx synths |
| `wavetable/uzu` | harmonic | 0.55 | uzu wavetables (`wt_digital`) |
| `wavetable/akwf` | harmonic | 0.55 | Adventure Kid single-cycle waveforms (`wt_*`) |
| `drum-machine/kick` | percussion | 0.12 | drum-machine `bd` |
| `drum-machine/snare` | percussion | 0.55 | drum-machine `sd` |
| `drum-machine/clap` | percussion | 0.62 | drum-machine `cp` |
| `drum-machine/hat` | percussion | 0.88 | drum-machine `hh`, `oh` |
| `drum-machine/cymbal` | percussion | 0.85 | drum-machine `cr`, `rd` |
| `drum-machine/tom` | percussion | 0.30 | drum-machine `ht`, `mt`, `lt` |
| `drum-machine/rim` | percussion | 0.60 | drum-machine `rim` |
| `drum-machine/perc` | percussion | 0.55 | drum-machine `cb`, `sh`, `tb`, `perc` |
| `drum-machine/fx` | percussion | 0.50 | drum-machine `misc`, `fx` |
| `dirt/kick` | percussion | 0.12 | Dirt-Samples kicks |
| `dirt/snare` | percussion | 0.55 | Dirt-Samples snares |
| `dirt/clap` | percussion | 0.62 | Dirt-Samples claps |
| `dirt/hat` | percussion | 0.88 | Dirt-Samples hats |
| `dirt/cymbal` | percussion | 0.85 | Dirt-Samples cymbals |
| `dirt/tom` | percussion | 0.30 | Dirt-Samples toms |
| `dirt/perc` | percussion | 0.55 | Dirt-Samples single percussion |
| `dirt/kit` | percussion | 0.50 | Dirt-Samples mixed kits (`n` picks kick/snare/hat/…) |
| `dirt/bass` | bass | 0.25 | Dirt-Samples bass hits and notes |
| `dirt/synth` | melodic | 0.50 | Dirt-Samples synth notes and hits |
| `dirt/stab` | melodic | 0.55 | Dirt-Samples stabs, hip-hop/rave snippets |
| `dirt/toy` | melodic | 0.50 | Dirt-Samples toy keyboards |
| `dirt/instrument` | melodic | 0.45 | Dirt-Samples acoustic/electric instrument notes |
| `dirt/loop` | texture | 0.45 | Dirt-Samples longer melodic or textural loops |
| `crate/kick` | percussion | 0.12 | eddyflux crate kicks |
| `crate/snare` | percussion | 0.55 | eddyflux crate snares |
| `crate/clap` | percussion | 0.62 | eddyflux crate claps and snaps |
| `crate/hat` | percussion | 0.88 | eddyflux crate hats |
| `crate/cymbal` | percussion | 0.85 | eddyflux crate crashes and rides |
| `crate/perc` | percussion | 0.55 | eddyflux crate percussion |
| `break/loop` | percussion | 0.55 | whole drum breaks (use `.fit()`, `.loopAt()` or `.splice()`) |
| `break/slices` | percussion | 0.55 | pre-chopped break slices |
| `pad/sampled` | harmonic | 0.40 | long sampled pads |
| `piano/salamander` | harmonic | 0.40 | Salamander grand piano |
| `vcsl/keys` | harmonic | 0.40 | VCSL pianos and TX81Z FM keys |
| `vcsl/organ` | harmonic | 0.45 | VCSL pipe and renaissance organs |
| `vcsl/mallet` | melodic | 0.55 | VCSL mallets, bells and thumb pianos |
| `vcsl/plucked` | melodic | 0.50 | VCSL harps, zithers, strumstick |
| `vcsl/bowed` | harmonic | 0.50 | VCSL bowed psaltery, wine glasses |
| `vcsl/wind` | melodic | 0.45 | VCSL recorders, ocarinas, saxes, harmonicas |
| `vcsl/drum` | percussion | 0.30 | VCSL bass drums, snares, toms, timpani |
| `vcsl/hand-drum` | percussion | 0.35 | VCSL bongo, conga, darbuka, frame drum, cajon, slit drum |
| `vcsl/hand-perc` | percussion | 0.70 | VCSL shakers, claps, claves, woodblocks, scrapers |
| `vcsl/metal` | percussion | 0.80 | VCSL cymbals, gongs, bells, cowbells, anvils |
| `vcsl/fx` | texture | 0.60 | VCSL whistles, siren, ocean drum, didgeridoo |
| `gm/keys` | harmonic | 0.40 | GM pianos and keyboards |
| `gm/mallet` | melodic | 0.60 | GM chromatic percussion |
| `gm/organ` | harmonic | 0.45 | GM organs, accordion, harmonica |
| `gm/guitar` | harmonic | 0.45 | GM guitars |
| `gm/bass` | bass | 0.20 | GM basses |
| `gm/strings` | harmonic | 0.40 | GM solo strings and string ensembles |
| `gm/choir` | vocal | 0.40 | GM choirs and voices |
| `gm/brass` | melodic | 0.50 | GM brass |
| `gm/reed` | melodic | 0.45 | GM saxes and double reeds |
| `gm/pipe` | melodic | 0.45 | GM flutes and whistles |
| `gm/lead` | melodic | 0.60 | GM synth leads |
| `gm/pad` | harmonic | 0.40 | GM synth pads |
| `gm/fx` | texture | 0.55 | GM synth effects |
| `gm/ethnic` | melodic | 0.50 | GM world instruments |
| `gm/percussion` | percussion | 0.45 | GM tuned and orchestral percussion |
| `gm/sfx` | texture | 0.55 | GM sound effects |
| `world/percussion` | percussion | 0.45 | tabla, mridangam, Japanese percussion |
| `found/object` | percussion | 0.60 | bottles, cans, lighters, metal |
| `field/nature` | texture | 0.50 | wind, birds, insects, fire, water, animals |
| `fx/arcade` | texture | 0.55 | vintage arcade game effects |
| `fx/electronic` | texture | 0.55 | bleeps, zaps, glitches, processed sounds |
| `fx/noise` | texture | 0.75 | sampled noise bursts |
| `voice/speech` | vocal | 0.50 | spoken words, letters, numbers, synthetic speech |
| `voice/vocal` | vocal | 0.50 | sung or shouted snippets, breaths, mouth sounds |

**Tags** are short, curated per bank (VCSL instrument, GM program, Dirt bank) or composed for drum
machines from the instrument and the machine's character ("gritty 12-bit" for the SP-12 and MPC60,
"808 boom" for the TR-808 kick), so the composer can dig by feel rather than by name.

## Field semantics

- **`id`** is the name superdough registers (lower-case, bank applied): `rolandtr909_bd`,
  `gm_epiano1`, `vibraphone`. **`aliases`** are other registered names for the same sound: the
  short drum-machine banks from `aliasBank()` (`tr909_bd`) and the oscillator shorthands (`saw`).
- **`usage`** is how to write it: `{ s: "bd", bank: "RolandTR909" }`.
- **`count`** is how many variants `n` selects (bank size for sample arrays, font variants for GM,
  tables for wavetables; 1 for pitch-keyed maps like VCSL instruments, where `n` has no effect).
- **`pitched`**: responds to `note()` with correct pitch (synths, soundfonts, wavetables and
  pitch-keyed sample maps). Plain sample banks are `false` even when their files happen to be notes.
- **`range`** (GM soundfonts only) is the longest run of MIDI notes between A0 and C8 whose zone in
  font variant 0 exists, decodes and plays (containing C4 when possible). Notes outside either fail
  or never start: a zone that doesn't decode hangs the soundfont loader. Other variants (`n > 0`)
  may have different ranges. Upstream `gm.mjs` has three broken variant names
  (`gm_electric_bass_finger` n=1, `gm_slap_bass_2` n=2, `gm_gunshot` n=11) that always fail; their
  tags say so. Zones that decode to a few milliseconds but loop (single-cycle waves, e.g. the top of
  `gm_synth_bass_1`, `gm_lead_1_square`, `gm_shanai`, `gm_bagpipe`) were rendered and do play.
- **`level`** is measured with the offline renderer: one event at gain 1 (`note` C4 for pitched
  sounds, `n` 0, samples clipped to the event) rendered for 1 s; `rmsDb` is the RMS over that
  second (so it is energy per event: a one-shot hat reads far lower than a sustained pad),
  `peakDb` the sample peak, `centroidHz` the spectral centroid (magnitude-weighted, averaged over
  frames by energy). `null` when not measured.
- **`brightness`** is the measured centroid on a log scale (80 Hz → 0, 12 kHz → 1), or the family
  prior above.
- **`bytes`** / **`durationSec`** describe the file variant 0 plays (C4's file for pitch-keyed maps;
  the preset file for GM, which has no fixed duration).
- **`license`** is the license of the source set (see above).
