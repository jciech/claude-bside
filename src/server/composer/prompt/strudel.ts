// The Strudel reference card in the composer's system prompt. Only idioms the room's validator,
// evaluator and analyser accept appear here: every `example` block is checked by the real checker in
// test/composer/reference.test.ts, and the stated facts come from the verified research
// (strudel-palette.md, critic.md) and src/shared/limits.ts.
import type { PartRole } from '../../../shared/music.ts';
import { MAX_DENSITY_FACTOR, MAX_MIX_ONSETS_PER_BAR, MAX_PART_ONSETS_PER_BAR } from '../../../shared/limits.ts';

export interface CardExample {
  role: PartRole;
  /** Section scale the example is written for (key fit is checked against it); null = unpitched. */
  scale: string | null;
  code: string;
  knobs?: { name: string; default: number; min: number; max: number }[];
}

type Block = string | CardExample;

const ex = (role: PartRole, scale: string | null, code: string, knobs?: CardExample['knobs']): CardExample => ({ role, scale, code, ...(knobs ? { knobs } : {}) });

const BLOCKS: Block[] = [
  `# Strudel reference card

Every part is ONE Strudel expression (optionally preceded by a few \`const\` bindings) that yields a
pattern. It is parsed against a static allowlist, evaluated in isolation, analysed over the whole
section, and only then played. Anything not on this card may still exist, but these idioms are
known to validate and to sound right here. Format: the source call first, then one method per
line, two-space indent (listeners read the code live, highlighted as it plays).

## Time
- 1 cycle = 1 bar of 4/4. The tempo is the section's \`bpm\`; never set it in code.
- \`s("bd*4")\` is four on the floor, \`hh*8\` eighths, \`hh*16\` sixteenths, \`.slow(4)\` spans 4 bars.
- Pattern time is absolute and continuous: carried parts keep their phrase across sections.

## Mini-notation (double quotes only; single quotes are plain strings)
- \`"a b c"\` sequence in one bar · \`"[a b] c"\` subdivide · \`"<a b c>"\` one per bar
- \`"a*4"\` repeat, \`"a/2"\` stretch, \`"a!3 b"\` replicate (adds steps), \`"a@3 b"\` elongate, \`"~"\` rest
- \`"a, b"\` or \`"[c3,e3,g3]"\` stack (chords) · \`"a? b?0.3"\` random drop (seeded)
- \`"bd(3,8)"\`, \`"bd(<3 5>,8,<0 2>)"\` euclid with rotation · \`"{a b c, d e}%4"\` polymeter
- \`"0 .. 7"\` range (spaces around ..) · \`"bd:3"\` sample index 3
- Random choice \`"[a|b|c]"\` works in brackets or at top level — NOT directly inside \`<…>\`: write \`"<[a|b] c>"\`.
- No comments or \`#\` inside strings; a string never spans lines.`,
  ex('kick', null, 's("bd*4, [~ cp]*2")\n  .bank("RolandTR909")\n  .gain(0.55)'),
  ex('hats', null, 's("hh*8")\n  .bank("RolandTR808")\n  .gain("[0.3 0.18]*4")\n  .swingBy(1/6, 4)'),
  ex('perc', null, 's("rim(<3 5>,8,<0 2>), [~ cb]*2?")\n  .bank("RolandTR808")\n  .gain(0.35)'),
  `## Sounds and pitch
- \`s("name")\` picks a sound; drum machines use \`s("bd sd").bank("RolandTR909")\` (kit names below).
  Not every machine has every drum (TR-808 and TR-707 have no \`rd\`, TR-909 no \`cb\`/\`sh\`): check the catalog.
- Pitch comes ONLY from \`note("c3 eb3")\` (names or MIDI numbers; no octave = octave 3) or
  \`n("0 2 4").scale("D:dorian")\` (scale degrees). On synths \`n\` without \`.scale\` is not pitch;
  on samples \`n\` is the sample index; on \`gm_*\` soundfonts \`.n(k)\` picks a variant.
- Prefer scale degrees: they keep every part in key and survive key changes. Octave in the scale's
  tonic: \`.scale("D2:dorian")\` for bass, \`"D3"\`–\`"D4"\` for chords and leads.
- Arithmetic belongs inside the string or on the degree pattern, before the control:
  \`n("0 2 4".add("<0 3>"))\` — never \`note(…).add(3)\` (a silent no-op; the checker rejects it).`,
  ex('bass', 'D:dorian', 'n("<0 [0 3] -2 [-3 -1]>")\n  .scale("D2:dorian")\n  .s("sawtooth")\n  .lpf(knob("cut"))\n  .lpenv(2)\n  .decay(0.2)\n  .sustain(0.3)\n  .gain(0.55)', [{ name: 'cut', default: 700, min: 300, max: 2400 }]),
  ex('lead', 'D:dorian', 'n("0 [2 4] <7 9> [5 3]".add("<0 2 -1>"))\n  .scale("D4:dorian")\n  .s("gm_vibraphone")\n  .room(0.3)\n  .gain(0.5)'),
  `## Tonal
- Scale names use colons, never spaces: \`"C:minor"\`, \`"C:minor:pentatonic"\`, \`"D:harmonic:minor"\`,
  \`"D4:purvi:raga"\`, \`"C:pelog"\`, \`"F:lydian"\`. Alternate per bar: \`.scale("<D:dorian G:mixolydian>")\`.
- Chords: \`chord("<Dm9 G13 C^9 Am9>").voicing()\`. Strudel spelling: \`^7\` (major 7th, NOT maj7),
  \`m7\`/\`-7\`, \`7\`, \`m9\`, \`13\`, \`7sus\` (not sus4), \`o7\`, \`h7\`/\`m7b5\`, \`add9\`, \`69\`, \`7b9\`, \`7#11\`, \`aug\`.
  Unknown symbols (\`Cmaj7\`, \`Csus4\`, \`Cdim\`, \`Cmin7\`) are SILENT. Voicing controls: \`.anchor("c4")\`,
  \`.mode("below")\`, \`.dict("lefthand")\` (jazz left-hand voicings; it only knows \`m7 7 ^7 m7b5 7b9 7b13 7#9
  7#11 o7 69 m6 mM7\` — ninths and thirteenths need the default dictionary). Arpeggiate with
  \`.arp("0 1 2 3")\` or \`n("0 1 2 3").chord(…).voicing()\`.
- Chords as degree stacks stay in key: \`n("<[0,2,4,6] [3,5,7,9]>").scale("A3:minor")\` (i7 → iv7).
- Set \`chromatic: true\` on a part that deliberately leaves the scale (blues notes, altered chords).`,
  ex('chords', 'C:major', 'chord("<Dm7 G7 C^7 Am7>")\n  .dict("lefthand")\n  .voicing()\n  .struct("~ [~ x] ~ x")\n  .s("gm_piano")\n  .clip(0.6)\n  .gain(0.7)'),
  ex('pad', 'C:major', 'chord("<Dm9 G13 C^9 Am9>")\n  .voicing()\n  .anchor("c4")\n  .s("gm_pad_warm")\n  .attack(0.5)\n  .release(2)\n  .gain(0.55)'),
  ex('chords', 'A:minor', 'n("<[0,2,4,6] [3,5,7,9] [-2,0,2,4] [-3,-1,1,4]>")\n  .struct("[~ x]*2 ~ [~ x]")\n  .scale("A3:minor")\n  .s("gm_epiano1")\n  .lpf(2800)\n  .room(0.3)\n  .gain(0.5)'),
  ex('arp', 'C:minor', 'chord("<Cm9 Ab^9 Fm9 G7sus>")\n  .voicing()\n  .arp("0 1 2 3 2 1 0 2")\n  .s("triangle")\n  .decay(0.2)\n  .sustain(0)\n  .delay(0.3)\n  .gain(0.4)'),
  `## Samples: loops, breaks, one-shots
- \`.loopAt(n)\` stretches a sample over n bars AND slows the pattern: write \`s("amen").loopAt(2)\`,
  never \`s("amen/2").loopAt(2)\` (that plays once every 4 bars). \`.fit()\` stretches to the event:
  \`s("amen/2").fit()\` is a 2-bar loop. Both follow the tempo automatically.
- \`.chop(16)\` cuts each event into slices; \`.splice(16, "0 1 [2 3] 4")\` re-sequences slices at
  natural speed; \`.striate(n)\`, \`.slice(n, "…")\`, \`.begin(0.25).end(0.5)\`, \`.speed(-1)\` reverses.
- \`.cut(1)\` chokes overlapping slices; \`.clip(1)\` or \`.release(…)\` bounds long one-shots. Long
  samples (pads, field recordings) retriggered every bar pile up: \`.loopAt(4)\`, \`.clip(1)\` or \`/4\`.`,
  ex('breaks', null, 's("breaks:<0 2>")\n  .splice(16, "<[0 1 2 3 4 5 6 7] [8 9 [10 10] 11 12 [13 5] 14 15]>")\n  .cut(1)\n  .gain(0.8)'),
  ex('breaks', null, 's("amen/2")\n  .fit()\n  .chop(16)\n  .sometimesBy(0.2, x => x.ply(2))\n  .every(4, x => x.chunk(4, y => y.speed(1.5)))\n  .cut(1)\n  .gain(0.75)'),
  ex('texture', null, 's("wind:<0 3>")\n  .loopAt(4)\n  .lpf(3000)\n  .gain(0.25)'),
  `## Synths (no downloads, always ready)
- \`sine triangle square sawtooth\` (note from \`note\`/\`n().scale\`), \`supersaw\` (\`.unison(≤9)\`,
  \`.detune(0–1)\`, \`.spread\`), \`pulse\` (\`.pw\`, \`.pwrate\`, \`.pwsweep\`), \`sbd\` (synth kick; \`.decay\`,
  \`.penv\`), noise \`white pink brown\` and \`crackle\` (\`.density\`). \`s("noise")\` is a quiet sample, not a synth.
- Envelope: \`.attack .decay .sustain .release\` (or \`.adsr("a:d:s:r")\`); decay without sustain = pluck.
- FM: \`.fm(index).fmh(ratio).fmdecay(t).fmsustain(0)\` — bells \`fmh(3.5)\`, e-piano \`fmh(1)\`, metal \`fmh(1.414)\`.
- Filters: \`.lpf(hz)\` \`.lpq(q)\` (0.7 neutral, 5–15 squelch), \`.hpf\`, \`.bpf\`; \`.ftype("ladder")\` for a
  Moog-ish low-pass. Filter envelope in OCTAVES: \`.lpf(300).lpenv(4)\` sweeps 300 Hz → 4.8 kHz; with
  \`.lpattack .lpdecay .lpsustain\`. Pitch envelope \`.penv(semitones).pdecay(t)\`; vibrato \`.vib(hz).vibmod(semitones)\`.
- Wavetables \`wt_*\` play notes like synths; \`.wt(0–1)\` scans the table.
- There is no glide/portamento, no \`.reverb\` (use \`.room\`), no \`.volume\`/\`.fadeIn\`/\`.whenmod\`/\`.trunc\`.`,
  ex('lead', 'F:lydian', 'n("<0 [2 4] 7 [9 11]>*2".add("<0 5 3 4>"))\n  .scale("F4:lydian")\n  .s("sine")\n  .fm("<3 5 7>")\n  .fmh(3.5)\n  .fmdecay(0.6)\n  .fmsustain(0)\n  .decay(1.2)\n  .sustain(0)\n  .room(0.5)\n  .gain(0.45)'),
  ex('bass', 'C:minor', 'n("0 7 [0 0] 2 0 [4 7] -1 0".add("<0 0 3 2>"))\n  .scale("C2:minor")\n  .s("sawtooth")\n  .lpf(500)\n  .lpq(16)\n  .lpenv("<3 4 5 6>")\n  .lpdecay(0.15)\n  .lpsustain(0)\n  .decay(0.18)\n  .sustain(0.2)\n  .distort(1.2)\n  .gain(0.35)'),
  ex('kick', null, 's("sbd*4")\n  .decay(0.4)\n  .gain(0.85)'),
  ex('hats', null, 's("white*16")\n  .hpf(8000)\n  .decay(0.03)\n  .sustain(0)\n  .gain("[0.18 0.08]*8")'),
  `## Movement over time
- Signals: \`sine saw tri square perlin rand\` with \`.range(a, b)\` and \`.slow(n)\`; \`irand(n)\` integers;
  \`.segment(n)\` samples a signal into n events per bar. Randomness is seeded by time, identical for
  every listener; add \`.seed(n)\` when a random motif should repeat the same way.
- Variation: \`.every(n, x => …)\`, \`.lastOf(4, x => …)\` (fills on the 4th bar), \`.sometimesBy(p, x => …)\`,
  \`.degradeBy(p)\`, \`.off(1/8, x => x.add(n(7)))\`, \`.jux(x => x.rev())\`, \`.superimpose(…)\`, \`.chunk(4, …)\`,
  \`.iter(4)\`, \`.palindrome()\`, \`.rev()\`, \`.ply(2)\`, \`.linger(0.25)\`, \`.mask("<1 [1 0]>")\`, \`.struct("x ~ x x")\`.
  Arrows must be single expressions using these same functions.
- Layer in one part with \`stack(a, b)\`; sequence bars with \`cat(a, b)\` or \`arrange([4, a], [4, b])\`.
- Density limits: \`fast\`, \`ply\`, \`*n\`, \`segment\`, \`chop\`… take constants ≤ ${MAX_DENSITY_FACTOR}; at most
  ${MAX_PART_ONSETS_PER_BAR} onsets per part per bar and ${MAX_MIX_ONSETS_PER_BAR} per section.`,
  ex('arp', 'E:phrygian', 'n("0 [3 5] <7 10> [12 8]")\n  .scale("E3:phrygian")\n  .s("square")\n  .decay(0.08)\n  .sustain(0)\n  .lpf(3000)\n  .jux(x => x.rev().hurry(2))\n  .gain(0.35)'),
  ex('lead', 'Eb:major:pentatonic', 'n(irand(10).segment(4).add("<0 -2 2 -1>/2"))\n  .scale("Eb4:major:pentatonic")\n  .s("piano")\n  .clip(1)\n  .degradeBy(0.5)\n  .room(0.6)\n  .gain(0.6)\n  .seed(7)'),
  ex('snare', null, 's("~ sd ~ sd")\n  .bank("LinnDrum")\n  .lastOf(4, x => x.ply(2))\n  .gain(0.5)'),
  `## Knobs: parameters the room can move
- \`knob("cut")\` reads a knob declared on the part (\`knobs: [{name, default, min, max, follows}]\`);
  use it anywhere a number goes: \`.lpf(knob("cut"))\`, \`.room(knob("wet"))\`, \`.delay(knob("echo"))\`.
- \`follows\` wires it to the room's pull pad (brightness or intensity, \`-\` inverts): a cutoff that
  follows brightness, a send that follows \`-intensity\`. Automation lanes target \`"knob:cut"\`.
- Keep the knob's range musical and inside the parameter's limits at both ends.`,
  ex('pad', 'C:minor', 'n("<[0,2,4,6] [5,7,9,11]>/2")\n  .scale("C3:minor")\n  .s("supersaw")\n  .unison(5)\n  .detune(0.18)\n  .attack(1.5)\n  .release(3)\n  .lpf(knob("cut"))\n  .room(knob("wet"))\n  .roomsize(6)\n  .gain(0.4)', [
    { name: 'cut', default: 1400, min: 500, max: 4000 },
    { name: 'wet', default: 0.5, min: 0.2, max: 0.8 },
  ]),
  `## Effects and gain staging (there is a limiter, but mix like there isn't)
- \`.gain()\` 0–1 REPLACES earlier gain (default 0.8); \`.velocity()\` 0–1 multiplies — use it for accents.
  Samples never above 1: kick ≤ 0.65 with other parts, drums 0.4–0.65, hats 0.15–0.4. Synth bass/leads
  0.5–1, supersaw 0.3–0.6, \`gm_*\` soundfonts 0.5–0.9 (they are quiet), \`steinway\` about 0.5.
- The part's fader (\`level\`) scales after your gain; the engine fades it. Don't fade with gain patterns.
- Sends: \`.room(0–1)\` with a CONSTANT \`.roomsize(0.1–6)\`; \`.delay(0–0.9)\` with a CONSTANT
  \`.delaytime(0–1 s)\` or \`.delaysync(cycles)\` (tempo-locked, e.g. 3/16) and \`.delayfeedback(0–0.9)\`.
  Room/delay sizes, times and feedback must not vary within a part; send amounts may.
- Colour: \`.shape(0–0.9)\`, \`.distort("amt:vol")\` (amt ≤ 3), \`.crush(2–16 bits)\`, \`.coarse(1–32)\`,
  \`.vowel("a e i o u")\`, \`.phaser(hz).phaserdepth(0–1)\`, \`.tremolosync(cycles).tremolodepth(0–1)\`,
  \`.compressor("-20:4")\` (per event). \`.pan(0–1)\` — 0.5 is centre, never negative.
- Other limits: \`.resonance/.lpq\` ≤ 20, \`.lpenv\` ±8, \`.speed\` ±4, \`.release\` ≤ 6 s, \`.clip\` ≤ 8, \`.penv\` ±48,
  \`.fm\` index ≤ 12. Soundfonts have playable ranges (listed in the catalog); outside them notes are silent.

## Not available (rejected by the validator)
\`setcps\`/\`setcpm\` (tempo is the section's), \`.orbit\`/\`.duck\` (use the part's \`duck\` field), \`samples()\`,
labels (\`name: …\`), \`hush\`, \`.p\`, \`.color\`, \`.lfo\`/\`.env\`, \`.nudge\`, \`.polymeter\`/\`.steps\` (use \`{…}%n\`),
raw callbacks (\`withValue\`, \`fmap\`, \`.filter\`), \`.piano()\` (write \`s("piano").clip(1)\`), loops,
assignments, template literals, computed property access.

## Common mistakes (each seen in real output)
1. Unquoted mini-notation \`note(c3 e3)\`, or single quotes \`s('bd sd')\`.
2. \`|\` directly inside \`<…>\`; \`"0..7"\` without spaces; \`"c:e:g"\` as a chord (use \`"[c,e,g]"\`).
3. \`.scale("C minor")\` with a space; \`Cmaj7\`/\`Csus4\`/\`Cdim\` chord symbols (silent).
4. \`note(…).add(…)\` or \`n(…).add(…)\` arithmetic on a control (do it inside the string).
5. \`n("0 2 4").s("sawtooth")\` without \`.scale\` (every note plays C2).
6. \`s("x/4").loopAt(4)\` double-slowing; retriggering long samples every bar without \`clip\`/\`loopAt\`.
7. Gain above 1, or \`.gain()\` twice expecting it to multiply; \`pan\` in −1…1.
8. \`roomsize\`/\`delaytime\` patterned or huge; \`delayfeedback\` ≥ 0.9 (rings forever).
9. Missing drum-machine instruments (\`rd\` on a TR-808); \`gm_*\` notes outside the instrument's range.
10. Invented functions: \`.reverb\`, \`.volume\`, \`.whenmod\`, \`.fadeIn\`, \`.glide\`, \`.chorus\`, \`.sidechain\`.`,
];

export const CARD_EXAMPLES: readonly CardExample[] = BLOCKS.filter((b): b is CardExample => typeof b !== 'string');

export function strudelCard(): string {
  return BLOCKS.map((b) => (typeof b === 'string' ? b : `\`\`\`js\n// ${b.role}${b.scale ? `, scale ${b.scale}` : ''}\n${b.code}\n\`\`\``)).join('\n\n');
}
