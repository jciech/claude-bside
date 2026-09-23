import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fingerprintDistance, type SectionCheck } from '../../src/shared/analysis.ts';
import { MAX_PART_ONSETS_PER_BAR } from '../../src/shared/limits.ts';
import type { SectionProgram } from '../../src/shared/program.ts';
import type { CheckPartInput, CheckSectionInput } from '../../src/server/types.ts';
import { runCheck } from '../../src/server/check/run.ts';
import { analyzeSection } from '../../src/strudel/analyze.ts';
import { createSoundIndex, parseCatalog } from '../../src/strudel/catalog.ts';
import { compilePart } from '../../src/strudel/compile.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const index = createSoundIndex(parseCatalog(fixture('catalog.small.json')));

const part = (id: string, code: string, extra: Partial<CheckPartInput> = {}): CheckPartInput => ({
  id,
  role: 'lead',
  code,
  knobs: [],
  chromatic: false,
  level: 0.8,
  enterBar: 0,
  exitBar: null,
  patternBarAtStart: 0,
  ...extra,
});

const check = (parts: CheckPartInput[], opts: Partial<Omit<CheckSectionInput, 'parts'>> = {}): SectionCheck =>
  runCheck({ parts, bpm: 120, scale: null, bars: 16, ...opts }, { index });
const rules = (c: SectionCheck, i = 0) => c.parts[i]!.errors.map((e) => e.rule);

describe('density over the whole section and its vamp', () => {
  it('catches a density explosion that only starts after bar 16', () => {
    // Valid statically (bounded), but 128 onsets per bar in the last bar of a 24-bar window: a
    // continuing part runs on pattern time through the vamp.
    const c = check([part('hats', 's("hh*16").lastOf(24, x => x.ply(8))', { role: 'hats', continues: true })], { bars: 16 });
    const e = c.parts[0]!.errors.find((x) => x.rule === 'density')!;
    expect(e.message).toBe(`The part plays 128 events in bar 23; a part may play at most ${MAX_PART_ONSETS_PER_BAR} per bar.`);
    expect(c.parts[0]!.analysis!.densityPerBar.max).toBe(16); // descriptors describe the composed section
  });

  it('catches the review\'s patterned bombs even when the validator is bypassed', () => {
    for (const [code, bar] of [
      ['s("bd*4").fast("<0!16 1>".mul(50000).add(1))', 16],
      ['s("hh*16").ply("<1!16 64>")', 16],
    ] as const) {
      const { pattern } = compilePart(code, { knob: () => null });
      const result = analyzeSection({ parts: [{ ...part('bomb', code, { continues: true }), pattern }], bpm: 120, scale: null, bars: 16, index });
      const e = result.parts[0]!.errors.find((x) => x.rule === 'density')!;
      expect(e.message).toMatch(new RegExp(`bar ${bar}\\b`));
    }
  });

  it('windows the vamp with the section\'s own loop length', () => {
    // Continuing parts run on pattern time: the burst is dense from pattern bar 8 on, and its part only
    // sounds in score bars 0–3. An 8-bar loop replays score bars 0–7 (burst audible in play bars 8–11);
    // a 4-bar loop replays 4–7.
    const parts = [
      part('burst', 's("<hh!8 [hh*16, hh*16, hh*16]!8>")', { role: 'hats', exitBar: 4, continues: true }),
      ...[0, 1, 2, 3].map((i) => part(`bed${i}`, 's("hh*16, hh*16, hh*8")', { role: 'hats', continues: true })),
    ];
    const fallback = check(parts, { bars: 8 });
    expect(fallback.errors.map((e) => e.message)).toEqual(['All parts together play 208 events in bar 8; a section may play at most 192 per bar.']);
    expect(check(parts, { bars: 8, vampLoopBars: 4 }).errors).toEqual([]);
    expect(check(parts, { bars: 8, vampLoopBars: 8 }).errors).toEqual([]); // clamped to half the section, like the performer
  });

  it('replays a fresh part\'s score in the vamp, and only counts bars inside its window', () => {
    // The performer maps a part that starts in this section onto score time (window.ts runs()), so
    // pattern bars past the score never sound; nor does anything outside [enterBar, exitBar).
    const fresh = { continues: false };
    const late = check([part('hats', 's("hh*8").bank("RolandTR909").lastOf(16, x => x.ply(16))', { role: 'hats', ...fresh })], { bars: 8, vampLoopBars: 4 });
    expect(late.parts[0]!.errors).toEqual([]);
    const unknown = check([part('hats', 's("<hh!8 hhx!8>").bank("RolandTR909")', { role: 'hats', ...fresh })], { bars: 8, vampLoopBars: 4 });
    expect(unknown.ok).toBe(true);
    const gone = check([part('hats', 's("hh*8").lastOf(8, x => x.ply(16))', { role: 'hats', exitBar: 4, ...fresh })], { bars: 16 });
    expect(gone.parts[0]!.errors).toEqual([]);
    // Pattern time runs on for a continuing part, so the same code is caught there.
    const carried = check([part('hats', 's("hh*8").bank("RolandTR909").lastOf(16, x => x.ply(16))', { role: 'hats', continues: true })], { bars: 8, vampLoopBars: 4 });
    expect(carried.parts[0]!.errors[0]!.message).toMatch(/128 events in bar 15/);
  });

  it('limits the whole mix', () => {
    const busy = Array.from({ length: 5 }, (_, i) => part(`p${i}`, 's("hh*16, hh*16, hh*16")', { role: 'hats' }));
    const c = check(busy);
    expect(c.errors.map((e) => e.rule)).toEqual(['density']);
    expect(c.errors[0]!.message).toMatch(/192 per bar/);
  });
});

describe('key fit', () => {
  it('follows a scale that alternates per bar', () => {
    const alternating = '<C:major F#:major>';
    const follows = check([part('keys', 'n("0 2 4 6").scale("<C3:major F#3:major>").s("triangle")', { role: 'chords' })], { scale: alternating });
    expect(follows.parts[0]!.analysis!.pitch!.keyFit).toBe(1);
    expect(follows.ok).toBe(true);

    const stuck = check([part('keys', 'n("0 2 4 6").scale("C3:major").s("triangle")', { role: 'chords' })], { scale: alternating });
    // C E G B: all in C major; only B is in F# major
    expect(stuck.parts[0]!.analysis!.pitch!.keyFit).toBe(0.625);
    expect(stuck.parts[0]!.warnings[0]).toMatchObject({ rule: 'key-fit', severity: 'warning' });
    expect(stuck.parts[0]!.warnings[0]!.message).toMatch(/outside: C3 \(bar 1\), E3 \(bar 1\), G3 \(bar 1\)\.$/);
    const wrong = check([part('keys', 'note("c#4 d#4 f#4 g#4")', { role: 'chords' })], { scale: alternating });
    expect(rules(wrong)).toEqual(['key-fit']);
  });

  it('warns between 0.6 and 0.8, errors below 0.6, and exempts chromatic parts', () => {
    const one = check([part('lead', 'note("c4 d4 e4 f#4")', { role: 'lead' })], { scale: 'C:major' });
    expect(one.parts[0]!.analysis!.pitch!.keyFit).toBe(0.75);
    expect(one.parts[0]!.warnings.map((w) => w.rule)).toContain('key-fit');
    expect(one.parts[0]!.ok).toBe(true);
    const chromatic = check([part('lead', 'note("c#4 d#4 f#4 g#4")', { role: 'lead', chromatic: true })], { scale: 'C:major' });
    expect(chromatic.parts[0]!.analysis!.pitch!.keyFit).toBe(0);
    expect(chromatic.ok).toBe(true);
    const kick = check([part('kick', 's("sbd*4")', { role: 'kick' })], { scale: 'C:major' });
    expect(kick.ok).toBe(true);
  });

  it('reports unknown scales at the section level', () => {
    const c = check([part('a', 'note("c4")')], { scale: 'H:foo' });
    expect(c.errors[0]).toMatchObject({ rule: 'scale', message: 'Unknown scale "H:foo".' });
  });
});

describe('per-part rules', () => {
  it('requires reverb and delay settings to stay constant (the send may move)', () => {
    const c = check([part('pad', 'note("c3 e3").s("triangle").roomsize("<2 4>").room("<0.2 0.5>")', { role: 'pad' })]);
    const e = c.parts[0]!.errors;
    expect(e.map((x) => x.rule)).toEqual(['constant-fx']);
    expect(e[0]!.message).toMatch(/^roomsize changes within the part \(2, 4\)/);
    expect(check([part('pad', 'note("c3 e3").s("triangle").room("<0.2 0.5>").roomsize(3)')]).ok).toBe(true);
  });

  it('names the closest catalog sounds for unknown ones', () => {
    const banked = check([part('kick', 's("kick*4").bank("RolandTR909")', { role: 'kick' })]);
    expect(banked.parts[0]!.errors[0]).toMatchObject({ rule: 'unknown-sound', message: 'Unknown sound "kick" in bank "RolandTR909" (first in bar 0).' });
    expect(banked.parts[0]!.errors[0]!.hint).toMatch(/^Closest catalog sounds: s\("bd"\)\.bank\("RolandTR909"\)/);
    const hat = check([part('hats', 's("hihat*8")', { role: 'hats' })]);
    expect(hat.parts[0]!.errors[0]!.hint).toMatch(/s\("hh"\)/);
    const indexed = check([part('x', "s('bd:3')")]);
    expect(indexed.parts[0]!.errors[0]!.hint).toMatch(/s\("bd:3"\)/);
  });

  it('rejects blocked sounds and notes outside a soundfont\'s range', () => {
    expect(rules(check([part('x', 's("bytebeat")')]))).toContain('denied');
    const low = check([part('bass', 'note("c1 c7").s("gm_acoustic_bass")', { role: 'bass' })]);
    expect(low.parts[0]!.errors[0]!.message).toMatch(/gm_acoustic_bass can only play A0–Eb5; C7/);
  });

  it('rejects soundfont variants that play silence, however n is written', () => {
    const palette = createSoundIndex(parseCatalog(JSON.parse(readFileSync(new URL('../../palette/catalog.json', import.meta.url), 'utf8'))));
    const fx = (code: string) => runCheck({ parts: [part('fx', code, { role: 'texture' })], bpm: 120, scale: null, bars: 4 }, { index: palette }).parts[0]!;
    for (const code of ['s("gm_gunshot").n(11)', 's("gm_gunshot:11")', 'n(11).s("gm_gunshot")', 's("gm_gunshot:<3 11>")']) {
      expect(fx(code).errors, code).toEqual([
        expect.objectContaining({
          rule: 'sample-index',
          message: expect.stringMatching(/^"gm_gunshot" variant n=11 does not exist upstream, so it plays silence \(first in bar [01]\)\.$/),
          hint: 'Use n values 0–11 except 11.',
        }),
      ]);
    }
    expect(fx('s("gm_gunshot").n(23)').errors[0]!.message).toBe('"gm_gunshot" n=23 (variant 11 of 12) does not exist upstream, so it plays silence (first in bar 0).');
    expect(fx('note("c2 e2").s("gm_electric_bass_finger:1")').errors.map((e) => e.rule)).toEqual(['sample-index']);
    for (const code of ['s("gm_gunshot").n(10)', 's("gm_gunshot:10")', 's("gm_gunshot")', 'note("c2").s("gm_electric_bass_finger:2")']) {
      expect(fx(code).ok, code).toBe(true);
    }
  });

  it('turns HAP_LIMITS violations into errors', () => {
    const c = check([part('x', 's("bd").gain("<1 3>").velocity(2)')]);
    expect(c.parts[0]!.errors.map((e) => e.message).sort()).toEqual([
      'gain reaches 3 in bar 1; it must stay within 0–1.',
      'velocity reaches 2 in bar 0; it must stay within 0–1.',
    ]);
  });

  it('explains pan overflow from jux, and checks knobs at their extremes', () => {
    const jux = check([part('hats', 's("hh*8").pan(sine).jux(rev)', { role: 'hats' })]);
    expect(jux.parts[0]!.errors[0]).toMatchObject({ rule: 'limit', hint: expect.stringMatching(/jux\(\)\/juxBy\(\) add ±0\.5 to pan/) });
    const knobbed = check([
      part('pad', 'note("c3").s("sine").gain(knob("g"))', { role: 'pad', knobs: [{ name: 'g', default: 0.5, min: 0, max: 1.5, follows: 'intensity' }] }),
    ]);
    expect(knobbed.ok).toBe(true);
    expect(knobbed.parts[0]!.warnings).toEqual([
      expect.objectContaining({ rule: 'knob-range', message: 'With its knobs at their max, gain reaches 1.5 (allowed 0–1); listeners hear it clamped.' }),
    ]);
  });

  it('promotes arithmetic on a control pattern (a silent no-op) to an error', () => {
    const c = check([part('lead', 'note("c4 e4").add(7)')]);
    expect(rules(c)).toContain('arith-on-control');
    expect(c.parts[0]!.errors.find((e) => e.rule === 'arith-on-control')!.hint).toMatch(/n\("0 2"\.add\(12\)\)/);
  });

  it('reports continuous-only and plain-value patterns', () => {
    expect(rules(check([part('x', 'seq(0, 1, 2)')]))).toEqual(['value']);
    expect(rules(check([part('x', 'n(sine.range(0, 7))')]))).toEqual(['silent']);
    expect(rules(check([part('x', 'sine.range(0, 1)')]))).toEqual(['silent']);
    expect(check([part('x', 'silence')]).parts[0]!.warnings.map((w) => w.rule)).toEqual(['silent']);
  });

  it('detects randomness by re-seeding, and periods otherwise', () => {
    const random = check([part('hats', 's("hh*16").degradeBy(0.5)', { role: 'hats' })]).parts[0]!;
    expect(random.analysis!.random).toBe(true);
    expect(random.digest!.period).toBe('random');
    const alternating = check([part('bass', 'note("<c2 eb2 g2 bb2>").s("sawtooth")', { role: 'bass' })], { scale: 'C:minor' }).parts[0]!;
    expect(alternating.analysis!.random).toBe(false);
    expect(alternating.analysis!.period).toBe(4);
    const seeded = check([part('hats', 's("hh*16").degradeBy(0.5).seed(3)', { role: 'hats' })]).parts[0]!;
    expect(seeded.analysis!.random).toBe(false);
  });

  it('honours enter/exit windows and where a continuing part is in its phrase', () => {
    const late = check([part('lead', 'note("c4*4").s("square")', { enterBar: 8 })], { scale: 'C:major' }).parts[0]!;
    expect(late.analysis!.onsetsPerBar).toBe(4);
    expect(late.analysis!.densityPerBar).toEqual({ min: 4, mean: 4, max: 4 });
    const phrase = 'note("<c3 d3 e3 f3>").s("sine")';
    const fresh = compilePart(phrase, { knob: () => null }).pattern;
    const cont = analyzeSection({ parts: [{ ...part('bass', phrase, { patternBarAtStart: 2 }), pattern: fresh }], bpm: 120, scale: null, bars: 8, index });
    expect(cont.parts[0]!.analysis.pitch!.minMidi).toBe(48);
    expect(cont.fingerprint.chordHash).toBeNull(); // 'lead' is not a harmonic role
  });

  it('warns when a synth plays n() without a scale', () => {
    const c = check([part('lead', 'n("0 2 4").s("sawtooth")')]);
    expect(c.parts[0]!.warnings.map((w) => w.rule)).toContain('n-without-scale');
  });

  it('warns when n() is meant as pitch on a soundfont or a pitched sample, where it picks a variant', () => {
    const palette = createSoundIndex(parseCatalog(fixture('../../palette/catalog.json')));
    const warned = (code: string) => {
      const c = runCheck({ parts: [part('lead', code)], bpm: 120, scale: 'C:major', bars: 8 }, { index: palette });
      return c.parts[0]!.warnings.filter((w) => w.rule === 'n-without-scale' || w.rule === 'sample-index').map((w) => w.message);
    };
    expect(warned('n("0 2 4 7").s("gm_epiano1")')).toEqual([expect.stringMatching(/^"gm_epiano1" uses n\(\) to pick one of its \d+ variants, not the pitch, so every note plays C3\.$/)]);
    expect(warned('n("0 2 4 7").s("piano")')).toEqual(['"piano" uses n() to pick a sample, not the pitch, so every note plays C2.']);
    expect(warned('n("0 2 4 7").scale("C:major").s("gm_epiano1")')).toEqual([]);
    expect(warned('note("c3 e3").n(2).s("gm_epiano1")')).toEqual([]);
    expect(warned('n(3).s("gm_epiano1")')).toEqual([]); // one fixed n picks a variant on purpose
  });
});

describe('knobs at their extremes', () => {
  it('rejects a part whose knob can push it past the density limit', () => {
    const k = { name: 'k', default: 0, min: 0, max: 1, follows: 'intensity' as const };
    const c = check([part('hats', 's("hh*8").when(knob("k").gt(0.5), x => x.ply(16))', { role: 'hats', knobs: [k] })]);
    expect(c.parts[0]!.analysis!.densityPerBar.max).toBe(8);
    expect(c.parts[0]!.errors).toEqual([
      expect.objectContaining({ rule: 'density', message: 'With its knobs at their max, the part plays 128 events in bar 0; a part may play at most 64 per bar.' }),
    ]);
  });
});

describe('automation', () => {
  const cut = { name: 'cut', default: 300, min: 200, max: 9000, follows: 'brightness' as const };
  const build = (lanes: boolean) =>
    check(
      [
        part('kick', 's("sbd*4")', { role: 'kick', level: 0.9 }),
        part('lead', 'note("d3 f3 a3 c4").s("sawtooth").lpf(knob("cut"))', {
          knobs: [cut], level: 0.7, automation: lanes ? [{ target: 'knob:cut', fromBar: 0, toBar: 16, from: 300, to: 8000, curve: 'exp' }] : [],
        }),
        part('hats', 's("hh*8")', { role: 'hats', level: 0, automation: lanes ? [{ target: 'level', fromBar: 4, toBar: 12, from: 0, to: 0.8, curve: 'linear' }] : [] }),
      ],
      { bpm: 124, scale: 'D:minor', bars: 16 },
    );

  it('measures a build that rises through knob and level lanes, as the performer plays it', () => {
    const flat = build(false).mix!;
    expect(flat.spans.tension).toEqual({ start: 0, end: 0 });
    expect(flat.audibleParts).toBe(2);
    const c = build(true);
    const { spans, audibleParts } = c.mix!;
    expect(spans.brightness.end - spans.brightness.start).toBeGreaterThan(0.3);
    expect(Math.max(spans.intensity.end - spans.intensity.start, spans.tension.end - spans.tension.start)).toBeGreaterThanOrEqual(0.2);
    expect(audibleParts).toBe(3);
    expect(c.fingerprint!.soundShares.hh).toBeGreaterThan(0.1);
  });

  it('counts a part that is faded out toward the mix density: the performer still plays it', () => {
    const busy = Array.from({ length: 5 }, (_, i) => part(`p${i}`, 's("hh*16, hh*16, hh*16")', { role: 'hats', level: i ? 0.8 : 0 }));
    expect(check(busy).errors.map((e) => e.rule)).toEqual(['density']);
  });
});

describe('loudness follows the catalog level contract', () => {
  const palette = createSoundIndex(parseCatalog(fixture('../../palette/catalog.json')));
  const loud = (code: string, role: CheckPartInput['role'] = 'hats') =>
    runCheck({ parts: [part('p', code, { role, level: 1 })], bpm: 120, scale: null, bars: 8 }, { index: palette }).parts[0]!.analysis!.loudness.estRmsDb!;

  it('counts every hit of a one-shot sample, whatever the event length', () => {
    // Offline renders (scripts/render-audio.ts, 4 bars at 120 BPM): LinnDrum hh*4/8/16 −23.6/−20.6/−18.2,
    // 909 bd*4 −14.7 dBFS with or without .clip(1) (the 0.47 s kick fits the 0.5 s event).
    const [h4, h8, h16] = ['hh*4', 'hh*8', 'hh*16'].map((p) => loud(`s("${p}").bank("LinnDrum")`));
    expect(h8! - h4!).toBeCloseTo(10 * Math.log10(2), 1);
    expect(h16! - h8!).toBeCloseTo(10 * Math.log10(2), 1);
    for (const [est, rendered] of [[h4, -23.6], [h8, -20.6], [h16, -18.2]] as const) expect(Math.abs(est! - rendered)).toBeLessThan(1);
    expect(Math.abs(loud('s("bd*4").bank("RolandTR909")', 'kick') - -14.7)).toBeLessThan(0.5);
    expect(Math.abs(loud('s("bd*4").bank("RolandTR909").clip(1)', 'kick') - -14.7)).toBeLessThan(0.5);
  });

  it('counts sustained notes for as long as they hold, and a clipped sample for what plays', () => {
    const whole = loud('note("c3").s("gm_pad_warm")', 'pad');
    expect(loud('note("c3").s("gm_pad_warm").slow(4)', 'pad')).toBeCloseTo(whole, 1);
    expect(loud('note("c3*4").s("gm_pad_warm")', 'pad')).toBeCloseTo(whole, 1);
    expect(loud('note("c3*4").s("gm_pad_warm").clip(0.5)', 'pad')).toBeCloseTo(whole - 10 * Math.log10(2), 1);
    // A 7 s break sounds for as long as it plays, whole or chopped into slices that each ring out.
    const amen = loud('s("amen/2")', 'breaks');
    expect(loud('s("amen/2").chop(8)', 'breaks')).toBeCloseTo(amen, 1);
    expect(loud('s("amen/2").chop(8).clip(0.25)', 'breaks')).toBeLessThan(amen - 6);
  });

  it('shares sounds by loudness: a held pad outweighs quiet busy hats', () => {
    const c = runCheck(
      {
        parts: [
          part('kick', 's("bd*4").bank("RolandTR909")', { role: 'kick' }),
          part('hats', 's("hh*16").bank("RolandTR909").gain(0.3)', { role: 'hats' }),
          part('pad', 'note("c3").s("gm_pad_warm").slow(2)', { role: 'pad' }),
        ],
        bpm: 120,
        scale: null,
        bars: 16,
      },
      { index: palette },
    );
    const shares = c.fingerprint!.soundShares;
    expect(shares.gm_pad_warm).toBeGreaterThan(shares.rolandtr909_hh!);
    expect(shares.rolandtr909_bd).toBeGreaterThan(shares.rolandtr909_hh!);
    expect(Object.values(shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    const mixed = runCheck({ parts: [part('drums', 's("bd*4, hh*16").bank("RolandTR909")', { role: 'kick' })], bpm: 120, scale: null, bars: 8 }, { index: palette });
    expect(mixed.parts[0]!.analysis!.sounds.map((s) => s.id)).toEqual(['rolandtr909_bd', 'rolandtr909_hh']);
  });
});

describe('similarity of fingerprints', () => {
  it('lets a new key and chord cycle alone move a section past the similarity threshold', () => {
    const palette = createSoundIndex(parseCatalog(fixture('../../palette/catalog.json')));
    const fp = (code: string, scale: string) =>
      runCheck({ parts: [part('pad', code, { role: 'pad' })], bpm: 90, scale, bars: 16 }, { index: palette }).fingerprint!;
    const dorian = fp('chord("<Dm9 G13>").voicing().s("gm_pad_warm").slow(2)', 'D:dorian');
    const abMajor = fp('chord("<Ab^7 Fm9 Db^7 Eb7sus>").voicing().s("gm_pad_warm")', 'Ab:major');
    expect(fingerprintDistance(dorian, abMajor)).toBeGreaterThanOrEqual(0.15); // ledger SIMILARITY_THRESHOLD
    expect(fingerprintDistance(dorian, fp('chord("<Dm9 G13>").voicing().s("gm_pad_warm").slow(2)', 'D:dorian'))).toBe(0);
  });
});

describe('the section scale', () => {
  it('rejects a scale that changes more often than the analysis can afford, before expanding it', () => {
    const t0 = performance.now();
    const c = check([part('lead', 'note("c4 e4 g4")')], { scale: 'C:major*5000', bars: 64 });
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(c.errors[0]).toMatchObject({ rule: 'scale', path: 'scale', message: expect.stringMatching(/^The scale "C:major\*5000" is too busy/) });
    expect(check([part('lead', 'note("c4 e4 g4")')], { scale: '[C:major F:major]' }).errors).toEqual([]);
  });
});

describe('the fixture snapshot', () => {
  const snapshot = fixture('snapshot.json') as { sections: SectionProgram[] };
  const checks = snapshot.sections.map((section, s) =>
    runCheck(
      {
        parts: section.parts.map((p) => ({
          id: p.id,
          role: p.role,
          code: p.code,
          knobs: p.knobs,
          chromatic: p.chromatic,
          level: p.level,
          enterBar: p.enterBar,
          exitBar: p.exitBar,
          patternBarAtStart: p.continues ? snapshot.sections[s - 1]!.bars : 0,
        })),
        bpm: section.tempo.toBpm,
        scale: section.scale,
        bars: section.bars,
      },
      { index },
    ),
  );

  it('passes every part without errors or warnings', () => {
    for (const c of checks) {
      expect(c.errors).toEqual([]);
      for (const p of c.parts) {
        expect(p.errors, p.id).toEqual([]);
        expect(p.warnings, p.id).toEqual([]);
      }
      expect(c.ok).toBe(true);
    }
  });

  it('describes the parts sensibly', () => {
    const [intro, groove] = checks;
    const digest = (c: SectionCheck, id: string) => c.parts.find((p) => p.id === id)!.digest!;
    expect(digest(intro!, 'kick')).toMatchObject({ instrument: 'Synth kick', evPerBar: 4, register: null, period: 1 });
    expect(digest(intro!, 'hats')).toMatchObject({ evPerBar: 8, period: 1 });
    expect(digest(intro!, 'bass')).toMatchObject({ instrument: 'Sawtooth', register: 'bass', keyFit: 1, period: 4 });
    expect(digest(intro!, 'pad')).toMatchObject({ register: 'low-mid', keyFit: 1 });
    expect(digest(groove!, 'lead')).toMatchObject({ instrument: 'Square', register: 'mid', keyFit: 1, period: 1 });
    expect(digest(groove!, 'lead').sync).toBeGreaterThan(0);
    expect(digest(groove!, 'hats').evPerBar).toBe(16);
    expect(digest(intro!, 'hats').bright).toBeGreaterThan(digest(intro!, 'bass').bright);
  });

  it('measures the intro building and the groove holding', () => {
    const [intro, groove] = checks;
    const i = intro!.mix!;
    expect(i.audibleParts).toBe(4);
    expect(i.spans.density.end).toBeGreaterThan(i.spans.density.start); // hats enter at 4, bass at 8
    expect(i.spans.brightness.end).toBeGreaterThan(i.spans.brightness.start);
    expect(i.spans.tension.end).toBeGreaterThan(i.spans.tension.start);
    const g = groove!.mix!;
    expect(g.audibleParts).toBe(4); // the fill only plays its pickup bar, before bar 0
    expect(g.descriptors.intensity).toBeGreaterThan(i.descriptors.intensity);
    expect(Math.abs(g.spans.intensity.end - g.spans.intensity.start)).toBeLessThan(0.1);
    for (const d of Object.values(g.descriptors)) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
    expect(g.period).toBe(4);
    expect(intro!.fingerprint!.kickGrid16).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(Object.values(groove!.fingerprint!.soundShares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    expect(intro!.fingerprint!.chordHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
