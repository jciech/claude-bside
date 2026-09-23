// The static density bound (src/strudel/density.ts): every way part code can make a query build more
// haps than it plays is counted, whatever bar or knob position triggers it, and real music passes.
import { parse, type Node, type Program } from 'acorn';
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/server/check/run.ts';
import type { CheckPartInput } from '../../src/server/types.ts';
import { createSoundIndex, parseCatalog } from '../../src/strudel/catalog.ts';
import { compilePart } from '../../src/strudel/compile.ts';
import { STATIC_EVENTS_CEILING, densityBound } from '../../src/strudel/density.ts';
import { cycleState } from '../../src/strudel/query.ts';
import { validatePart } from '../../src/strudel/validate.ts';
import { readFileSync } from 'node:fs';
import { playableParts } from './playable.ts';

const K = { knobs: ['k'] };

function boundOf(code: string): number {
  const program = parse(code, { ecmaVersion: 2022 }) as unknown as Program;
  const declarations = program.body
    .slice(0, -1)
    .flatMap((s) => (s.type === 'VariableDeclaration' ? s.declarations.map((d) => ({ name: (d.id as { name: string }).name, init: d.init! })) : []));
  const last = program.body[program.body.length - 1] as unknown as { expression: Node };
  return densityBound(declarations, last.expression).events;
}

const densityErrors = (code: string) => validatePart(code, K).errors.filter((e) => e.rule === 'density');

/** Code the bound must reject: [code, what it attacks]. */
const DENSITY_BOMBS: [string, string][] = [
  // Out-joins re-read their whole receiver at every structure event (R00).
  ['s("bd").ply(16).ply(16).ply(16).struct("x")', 'struct over a multiplied receiver'],
  ['s("bd").ply(16).ply(16).ply(16).ply(16).struct("x")', 'struct over a multiplied receiver'],
  ['s("bd").ply(16).ply(16).ply(16).structAll("x")', 'structAll'],
  ['n("0").s("sine").ply(16).ply(16).ply(16).arp("0")', 'arp collects the whole receiver'],
  ['n("0").s("sine").ply(16).ply(16).ply(16).ply(16).add.out("0")', 'operator out mode'],
  ['n("0").s("sine").ply(16).ply(16).ply(16).out("0")', 'set.out'],
  ['n("0").s("sine").ply(16).ply(16).ply(16).keepif.out("1")', 'keepif.out'],
  ['s("bd").ply(16).ply(16).ply(16).scrub("0")', 'scrub'],
  ['s("bd").ply(16).ply(16).ply(16).slice(4, "0")', 'slice'],
  ['s("bd").ply(16).ply(16).ply(16).splice(4, "0")', 'splice'],
  ['"0".ply(16).ply(16).ply(16).pick([s("bd")])', 'pick reads its index pattern'],
  ['s("bd").ply(16).ply(16).ply(16).segment(1)', 'segment is struct'],
  ['s("bd").ply(16).ply(16).ply(16).euclid(1, 16)', 'euclid is struct'],
  ['s("bd").lastOf(256, x => x.ply(16).ply(16).ply(16).struct("x"))', 'behind a late condition'],
  ['s("bd").lastOf(1024, x => x.ply(16).ply(16).ply(16).ply(16).ply(16).struct("x")).early(knob("k"))', 'late condition moved by a knob'],
  ['struct("x", s("bd").ply(16).ply(16).ply(16))', 'global form'],
  ['s("hh*16").struct(pure(1).slow(100000))', 'structure events 100 000 cycles long'],
  ['s("hh*16").struct("x/1000")', 'structure events 1000 cycles long'],
  ['s("hh*16").segment(0.001)', 'segment slower than a cycle'],
  // NaN and Infinity must count as unbounded (R01).
  ['s("hh*16").ribbon(0, 1).lastOf(100, x => x.ply(16).ply(16))', 'ribbon'],
  ['s("hh*16").lastOf(100, x => x.rib(0, 1).ply(16).ply(16).ply(16))', 'rib inside a function'],
  ['s("hh*16").struct(binaryN(5, 4)).lastOf(100, x => x.ply(16).ply(16).ply(16))', 'binaryN'],
  ['stack(s("hh").ribbon(0, 0.0625), s("hh*16").lastOf(100, x => x.ply(16).ply(16)))', 'ribbon in a stack'],
  ['s("saw").partials(binaryL(pure(10).pow(400)))', 'binaryL of Infinity never stops'],
  ['s("bd").zoom(0, 1e-300).gain(0.5)', 'zoom into nothing'],
  ['s("bd").slow(1e6).slow(1e6).gain(0.5)', 'events 10¹² cycles long'],
  // Patterned values carry their own multipliers, read over each receiver event (R02).
  ['s("bd").gain(sine.segment(16).ply(16).ply(16).ply(16))', 'control value'],
  ['s("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16)))', 'control value behind a late condition'],
  ['s("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16))).early(knob("k"))', 'moved by a knob'],
  ['s("bd").lpf("800".ply(16).ply(16).ply(16))', 'lpf'],
  ['s("bd").gain(knob("k").segment(16).ply(16).ply(16))', 'knob value'],
  ['note("c").add("0".ply(16).ply(16).ply(16))', 'operator'],
  ['s("bd").mask("1".ply(16).ply(16).ply(16))', 'mask'],
  ['s("bd").set("0".ply(16).ply(16).ply(16))', 'set'],
  ['s("bd").late("0".ply(16).ply(16).ply(16))', 'registered function (innerJoin)'],
  ['s("bd").degradeBy("0.5".ply(16).ply(16).ply(16))', 'degradeBy'],
  ['s("bd").sometimesBy("0.5".ply(16).ply(16).ply(16), x => x.speed(2))', 'sometimesBy probability'],
  ['n("0").scale("C:minor".ply(16).ply(16).ply(16)).s("piano")', 'scale name'],
  ['"0".pickOut([s("bd").ply(16).ply(16).ply(16)])', 'choice'],
  ['const g = sine.segment(16).ply(16).ply(16).ply(16)\ns("bd").gain(g)', 'through a constant'],
  ['gain(sine.segment(16).ply(16).ply(16).ply(16), s("bd"))', 'global control form'],
  // Long events: a value is read across the whole of each event.
  ['s("bd").slow(100000).gain("1*16")', 'value read across 100 000-cycle events'],
  ['gain("1*16", s("bd").slow(100000))', 'global form'],
  ['s("bd").slow(16).slow(16).slow(16).gain(0.5)', 'compounded slow'],
  ['s("bd").fast(0.0001).gain(0.5)', 'fast below 1'],
  ['note("<c@10000 e>").gain(0.5)', 'mini weight in an alternation'],
  ['s("bd/10000").gain(0.5)', 'mini slow'],
  ['s("bd").slow(4000).hurry(2)', 'hurry reads speed'],
  // A pattern queried again for every event of another pays its fixed cost each time.
  ['s("bd").slow(32).gain("1*16").late("0*16").late("0*16").late("0*16")', 'nested re-queries'],
  ['note("<c e>").slow(32).gain("1*16").chunk(4, x => x.speed(2))', 'chunk re-queries per step'],
  ['note("<c e>").slow(32).gain("1*16").struct("x*16")', 'struct re-queries per structure event'],
  // Squeezes multiply events.
  ['s("hh*16").bite(4, "0*16".fast(16))', 'bite'],
  ['s("hh*16").squeeze("0*16".fast(8))', 'squeeze'],
  ['"0*16".fast(8).inhabit([s("hh*16")])', 'inhabit'],
  ['s("hh*16").reset("x*16".fast(8))', 'reset'],
  ['n("0 1 2 3 4 5 6 7").add.squeeze("0*16".fast(16))', 'operator squeeze'],
  ['squeeze("0*16".fast(16), [s("hh*16")])', 'global squeeze'],
  ['"0*16".fast(16).pickRestart([s("hh*16")])', 'pickRestart'],
  ['n("0*16".fast(4)).add.mix(n("0*16".fast(4)))', 'mix pairs every event'],
];

/** Idiomatic code the bound must accept. */
const IDIOMS: string[] = [
  's("bd sd [~ bd] sd").chunk(4, x => x.hurry(2))',
  's("hh*8").chunk(4, x => x.gain(0.3)).chunkBack(4, x => x.speed(2))',
  'note("c3 e3 g3 b3").s("piano").every(4, x => x.rev())',
  's("bd").every(3, x => x.fast(2)).firstOf(4, x => x.speed(2)).lastOf(8, x => x.ply(2))',
  'n("0 2 4 7").scale("C:minor").s("sawtooth").off(1/8, x => x.add(n(12))).lpf(1200)',
  's("bd*4").off(0.25, x => x.speed(2).gain(0.5))',
  's("hh*8").jux(rev)',
  'n("0 .. 7").scale("D:dorian").s("piano").jux(x => x.rev().fast(2))',
  'chord("<Am7 Dm7 G7 C^7>").voicing().s("piano").arp("0 1 2 3")',
  'chord("<C Am F G>").voicing().s("piano").arp("0 1 2 3 2 1 0 2").fast(2)',
  'n("<[0,2,4] [1,3,5]>").scale("C:major").s("piano").arp("0 [1 2] 1 0")',
  'note("c2").s("sawtooth").struct("x ~ x x ~ x x ~")',
  'chord("<Am7 Dm7>").voicing().s("piano").struct("x*16")',
  's("hh*8").struct("x ~ x x").mask("<1 [1 0]>")',
  's("bd").euclid(3, 8)',
  's("hh").euclidRot(5, 8, 2)',
  's("bd(3,8), hh(5,8,2)")',
  'n("0 .. 7").scale("C:major").s("sawtooth").arp("0 2 1 3").euclidLegato(5, 8)',
  's("hh*16").sometimesBy(0.3, x => x.speed(2))',
  's("hh*16").sometimes(x => x.ply(2)).rarely(x => x.gain(0.2))',
  'n("0 .. 7").scale("C:minor").s("piano").sometimesBy("<0.2 0.5>", x => x.speed(2))',
  's("hh*16").bite(4, "0 1 2 3 0 1 2 3")',
  'n("0 1 2 3 4 5 6 7").scale("C:minor").s("piano").bite(4, "0 2 1 3").jux(rev)',
  's("bd*4").ribbon(0, 2)',
  'n("0 .. 7").s("piano").ribbon(1, 0.5)',
  's("hh*8").rib(3, 1)',
  'n("0 2 4 6").scale("<C:minor!32 F:minor!32>").s("piano")',
  'n("<0 2 4 6>@2 <1 3>").scale("<C:minor@8 Eb:major@8>").s("piano")',
  'n("0 .. 7").scale("C:minor").s("sine").lpf(sine.range(300, 3000).slow(16)).room(0.4)',
  's("bd*4, [~ cp]*2, hh*8").bank("RolandTR909")',
  'note("<c3 eb3 g3 bb3>/2").s("sawtooth").lpf(800).slow(2)',
  'n("[0,4,7]").scale("C3:major").s("supersaw").attack(1).release(2).slow(8).gain(0.3).room(0.8)',
  'note("[c3,e3,g3]").s("piano").slow(16).room(0.8).gain(0.3).lpf(800)',
  's("hh*8").swingBy(1/3, 4)',
  's("hh*16").swing(4)',
  'n("0 1 2 3 4 5 6 7").scale("C:minor").s("sine").shuffle(8)',
  's("hh*8").scramble(4)',
  's("hh*16").degradeBy(0.3).pan(rand)',
  's("hh*8").gain("[.8 .5]*4").velocity("[1 .5 .7 .5]*2")',
  'note("c e g").s("piano").superimpose(x => x.add(12).late(0.125))',
  's("bd*2").echo(3, 1/8, 0.6)',
  'n("0 [2 4]").scale("C:minor").s("piano").echoWith(3, 1/8, x => x.add(n(2)))',
  's("hh*8").iter(4).palindrome()',
  's("hh*8").linger(0.25)',
  's("hh*8").inside(2, rev).outside(2, rev)',
  's("bd").segment(4)',
  's("hh*16").lpf(sine.range(400, 4000).segment(16))',
  'n("0 .. 3").add("<0 3 5>").scale("C:minor").s("piano")',
  'n("0*8").scale("C:minor").s("sawtooth").add(n("<0 3 5 7>"))',
  'n("0 2 4").s("piano").pickF("<0 1>", [x => x.fast(2), x => x.rev()])',
  '"<0 1>".pick([s("bd*2"), s("hh*4")])',
  '"<0 1 [0,1]>".inhabit([s("bd(3,8)"), s("cp sd")])',
  'stack(s("bd*4"), s("~ sd"), s("hh*8"))',
  'cat(s("bd*2"), s("hh*4"))',
  'note("c e g b").s("piano").late("[0 0.02]*2")',
  'n("0 .. 7").scale("C:minor").s("piano").hurry(2)',
  'note("c3 e3").s("piano").add.squeeze("0 12")',
  'note("[c,e] g").s("piano").add.mix("[0,12] 7")',
  's("amen/2").fit().chop(16).sometimesBy(0.2, x => x.ply(2)).every(4, x => x.chunk(4, y => y.speed(1.5))).cut(1).gain(0.75)',
];

describe('the static density bound rejects every way to multiply work', () => {
  it.each(DENSITY_BOMBS)('rejects %j (%s)', (code) => {
    expect(densityErrors(code)).not.toEqual([]);
  });

  it('counts NaN and Infinity as unbounded', () => {
    for (const code of ['s("hh").ribbon(0, 1)', 's("hh").rib(0, 1/16)', 's("hh").ribbon(0, 0.0625)', 'binaryN(5, 4)', 'binaryN(5)', 's("bd").zoom(0, 1e-300).gain(0.5)']) {
      expect(Number.isFinite(boundOf(code)), code).toBe(true);
    }
    expect(boundOf('s("hh").ribbon(0, 0.0625)')).toBe(16);
    expect(boundOf('binaryN(5, 4)')).toBe(5);
  });

  it('counts the receiver of an out-join as work, not just its polyphony', () => {
    expect(boundOf('s("bd").ply(16).ply(16).ply(16).ply(16).struct("x")')).toBeGreaterThanOrEqual(65536);
    expect(boundOf('n("0").s("sine").ply(16).ply(16).ply(16).arp("0")')).toBeGreaterThanOrEqual(4096);
  });

  it('counts a patterned value\'s own multipliers and the length of the events it is read across', () => {
    expect(boundOf('s("bd").gain(sine.segment(16).ply(16).ply(16).ply(16))')).toBeGreaterThanOrEqual(65536);
    expect(boundOf('s("bd").slow(100000).gain("1*16")')).toBeGreaterThanOrEqual(1_600_000);
  });

  it('bounds a squeeze by the product of the two patterns\' events', () => {
    expect(boundOf('s("hh*16").bite(4, "0 1 2 3 0 1 2 3")')).toBe(16 * 8);
    expect(boundOf('s("hh*16").bite(4, "0*16".fast(16))')).toBe(16 * 256);
  });

  it('names the multiplier to remove', () => {
    const e = densityErrors('s("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16)))')[0]!;
    expect(e.hint).toMatch(/ply\(16\) ×16/);
    const long = densityErrors('s("bd").slow(100000).gain("1*16")')[0]!;
    expect(long.hint).toMatch(/\.gain\(\) reads its value across 100000-cycle events/);
  });
});

describe('the late-condition bombs of the review fail the whole check', () => {
  const index = createSoundIndex(parseCatalog(JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'))));
  const part = (code: string): CheckPartInput => ({
    id: 'p', role: 'perc', code, chromatic: false, level: 0.8, enterBar: 0, exitBar: null, patternBarAtStart: 0, continues: true,
    knobs: [{ name: 'k', default: 0, min: 0, max: 2000, follows: 'brightness' }],
  });
  it.each([
    's("bd").lastOf(1024, x => x.ply(16).ply(16).ply(16).ply(16).struct("x")).early(knob("k"))',
    's("hh*16").ribbon(0, 1).lastOf(100, x => x.ply(16).ply(16)).early(knob("k"))',
    's("bd").lastOf(1024, x => x.gain(sine.segment(16).ply(16).ply(16).ply(16))).early(knob("k"))',
  ])('%j', (code) => {
    const c = runCheck({ parts: [part(code)], bpm: 120, scale: null, bars: 16 }, { index });
    expect(c.ok).toBe(false);
    expect(c.parts[0]!.errors.map((e) => e.rule)).toContain('density');
  });
});

describe('real music passes, and plays no more than the bound', () => {
  it.each(IDIOMS.map((c) => [c]))('accepts %j', (code) => {
    expect(validatePart(code, K).errors).toEqual([]);
    const bound = boundOf(code);
    const { pattern } = compilePart(code, { knob: () => 1 });
    for (let bar = 0; bar < 32; bar++) {
      const haps = pattern.query(cycleState(bar, bar + 1, { _cps: 0.5 })) as { hasOnset(): boolean }[];
      expect(haps.length, `${code} in bar ${bar}`).toBeLessThanOrEqual(bound);
    }
  });

  it('accepts every autopilot template in every variant, the riser and the fixtures, well below the ceiling', () => {
    const parts = playableParts();
    expect(parts.length).toBeGreaterThan(500);
    for (const p of parts) {
      expect(validatePart(p.code, { knobs: p.knobs.map((k) => k.name) }).errors, p.name).toEqual([]);
      expect(boundOf(p.code), p.name).toBeLessThanOrEqual(STATIC_EVENTS_CEILING / 2);
    }
  });
});
