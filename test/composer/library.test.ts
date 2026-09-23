// The autopilot's library: every ensemble passes the real checker (worker threads, the real palette)
// in both of its validation keys; public strings are plain text within their limits; the scale
// helpers fill placeholders correctly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChecker } from '../../src/server/check/checker.ts';
import { riserCode } from '../../src/server/composer/arrange.ts';
import { LIBRARY } from '../../src/server/composer/library/index.ts';
import { fillScale, parseScale, pitchClass, transposeTonic, withOctave } from '../../src/server/composer/library/scale.ts';
import type { Checker } from '../../src/server/types.ts';
import { isPublicText } from '../../src/shared/text.ts';
import { BPM_MAX, BPM_MIN, PART_ID_PATTERN } from '../../src/shared/music.ts';
import { validatePart } from '../../src/strudel/validate.ts';
import { fullCatalog } from './fixtures.ts';

describe('scale helpers', () => {
  it('parses tonic, octave and colon-joined modes, including alternations', () => {
    expect(parseScale('D:dorian')).toEqual([{ tonic: 'D', octave: null, mode: 'dorian' }]);
    expect(parseScale('Eb4:minor:pentatonic')).toEqual([{ tonic: 'Eb', octave: 4, mode: 'minor:pentatonic' }]);
    expect(parseScale('<D:dorian G:mixolydian>')?.map((t) => t.mode)).toEqual(['dorian', 'mixolydian']);
    expect(parseScale('C minor')).toBeNull();
    expect(parseScale('H:major')).toBeNull();
  });

  it('puts the tonic in an octave without touching mode names that end in a note letter', () => {
    expect(withOctave('B:harmonic:minor', 4)).toBe('B4:harmonic:minor');
    expect(withOctave('D4:purvi:raga', 2)).toBe('D2:purvi:raga');
    expect(withOctave('<D:dorian G:mixolydian>', 3)).toBe('<D3:dorian G3:mixolydian>');
    expect(fillScale('n("0 2").scale("$SCALE2").s("x").scale("$SCALE")', 'F#:phrygian:dominant')).toBe('n("0 2").scale("F#2:phrygian:dominant").s("x").scale("F#:phrygian:dominant")');
  });

  it('transposes tonics by semitones', () => {
    expect(transposeTonic('A', 5)).toBe('D');
    expect(transposeTonic('C', -3)).toBe('A');
    expect(pitchClass('F#')).toBe(6);
    expect(pitchClass('Bb')).toBe(10);
  });
});

describe('library shape', () => {
  it('has distinct ids, valid part ids, declared knobs and statically valid code', () => {
    expect(new Set(LIBRARY.map((e) => e.id)).size).toBe(LIBRARY.length);
    for (const ens of LIBRARY) {
      const ids = ens.parts.map((p) => p.id);
      expect(new Set(ids).size, ens.id).toBe(ids.length);
      expect(ens.parts.length, ens.id).toBeLessThanOrEqual(8);
      for (const p of ens.parts) {
        expect(p.id, `${ens.id}.${p.id}`).toMatch(PART_ID_PATTERN);
        const code = fillScale(p.code, `${ens.tonic}:${ens.modes[0]}`);
        const v = validatePart(code, { knobs: (p.knobs ?? []).map((k) => k.name) });
        expect(v.errors, `${ens.id}.${p.id}`).toEqual([]);
        expect([...v.knobsUsed].sort(), `${ens.id}.${p.id} knobs`).toEqual((p.knobs ?? []).map((k) => k.name).sort());
        for (const t of p.duck?.targets ?? []) expect(ids, `${ens.id}.${p.id} duck`).toContain(t);
      }
      // Every tempo in the range is one the plan schema accepts.
      expect(ens.bpm.min, ens.id).toBeGreaterThanOrEqual(BPM_MIN);
      expect(ens.bpm.min).toBeLessThanOrEqual(ens.bpm.default);
      expect(ens.bpm.default).toBeLessThanOrEqual(ens.bpm.max);
      expect(ens.bpm.max, ens.id).toBeLessThanOrEqual(BPM_MAX);
    }
  });

  it('writes only plain public text within the plan limits', () => {
    for (const ens of LIBRARY) {
      for (const t of ens.titles) expect(isPublicText(t) && t.length <= 40, `${ens.id} title ${t}`).toBe(true);
      for (const m of ens.movementNames) expect(isPublicText(m) && m.length <= 40, `${ens.id} movement ${m}`).toBe(true);
      expect(isPublicText(ens.blurb) && ens.blurb.length <= 200, `${ens.id} blurb`).toBe(true);
      for (const l of Object.values(ens.labels)) expect(isPublicText(l!), `${ens.id} label ${l}`).toBe(true);
    }
  });

  it('spans many genres and keeps a synth-only subset', () => {
    const tags = new Set(LIBRARY.flatMap((e) => e.tags));
    for (const genre of ['ambient', 'house', 'techno', 'dub techno', 'jungle', 'drum and bass', 'lofi', 'idm', 'trip hop', 'jazz', 'classical', 'synthwave', 'gamelan', 'carnatic', 'trap', 'acid']) {
      expect(tags.has(genre), genre).toBe(true);
    }
    const synthOnly = LIBRARY.filter((e) => e.parts.every((p) => !/\bs\("[^"]*\b(?:bd|sd|hh|cp|oh|rim|breaks|amen|jazz|crate_|gm_|steinway|piano|wind|crow|insect|kalimba|conga|tha|gumki|tabla|gong|glitch|blip|sn|hh27|shaker_small|wt_)/.test(p.code) && !p.code.includes('.bank(')));
    expect(synthOnly.map((e) => e.id).sort()).toEqual(expect.arrayContaining(['glass-drift', 'pilot-light', 'synth-house', 'synth-techno', 'chiptune', 'fm-bells', 'night-drive']));
  });
});

describe('library against the real checker', () => {
  let checker: Checker;
  beforeAll(() => {
    checker = createChecker({ catalog: fullCatalog, poolSize: 3 });
  });
  afterAll(() => checker.close());

  it('every ensemble validates at the bottom and the top of its key range', async () => {
    const failures: string[] = [];
    await Promise.all(
      LIBRARY.flatMap((ens) => {
        const wide = ens.modes.find((m) => /pentatonic|pelog/.test(m)) ?? ens.modes[ens.modes.length - 1]!;
        return [`C:${ens.modes[0]}`, `B:${wide}`].map(async (scale) => {
          const check = await checker.checkSection({
            parts: ens.parts.map((p) => ({ id: p.id, role: p.role, code: fillScale(p.code, scale), knobs: p.knobs ?? [], chromatic: false, level: p.level, enterBar: 0, exitBar: null, patternBarAtStart: 0 })),
            bpm: ens.bpm.default,
            scale,
            bars: 16,
          });
          if (!check.ok) failures.push(`${ens.id} ${scale}: ${[...check.errors, ...check.parts.flatMap((p) => p.errors)].map((e) => `${e.path ?? ''} ${e.rule} ${e.message}`).join('; ')}`);
          for (const p of check.parts) if (p.digest?.keyFit !== null && p.digest?.keyFit !== undefined) expect(p.digest.keyFit, `${ens.id}.${p.id} key fit`).toBe(1);
        });
      }),
    );
    expect(failures).toEqual([]);
  }, 60_000);

  // White noise already measures as fully bright, so the riser's measured rise comes from its density.
  it('the build riser validates at every build length and rises in intensity and tension', async () => {
    for (const bars of [16, 32, 64]) {
      const check = await checker.checkSection({ parts: [{ id: 'riser', role: 'texture', code: riserCode(bars), knobs: [], chromatic: false, level: 0.7, enterBar: 0, exitBar: null, patternBarAtStart: 0 }], bpm: 120, scale: null, bars });
      expect([...check.errors, ...check.parts.flatMap((p) => p.errors)], `riser ${bars}`).toEqual([]);
      const { intensity, tension } = check.mix!.spans;
      expect(intensity.end - intensity.start, `riser ${bars} intensity`).toBeGreaterThan(0.15);
      expect(tension.end - tension.start, `riser ${bars} tension`).toBeGreaterThan(0.15);
    }
  });
});
