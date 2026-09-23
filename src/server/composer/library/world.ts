// Textures from outside the western dance floor: Carnatic percussion with a raga, a pelog gamelan.
import { chain, wetKnob } from './dsl.ts';
import type { Ensemble } from './types.ts';

export const carnatic: Ensemble = {
  id: 'carnatic',
  name: 'Carnatic',
  tags: ['carnatic', 'indian', 'raga', 'mridangam', 'sitar', 'south indian', 'world', 'shehnai', 'tabla'],
  groove: 'polymeter',
  arc: 'ramp-up',
  bpm: { min: 84, max: 100, default: 90 },
  modes: ['purvi:raga', 'todi:raga', 'kafi:raga', 'phrygian:dominant', 'harmonic:minor'],
  tonic: 'D',
  mood: { intensity: 0.5, brightness: 0.55 },
  parts: [
    {
      id: 'mridangam',
      role: 'perc',
      layer: 'beat',
      level: 0.85,
      code: chain('s("<[tha ki ta ~ dhin ~ na ~] [ta ~ ka dhin ~ na dhi ~]>")', 'room(0.2)', 'gain(0.65)'),
    },
    {
      id: 'gumki',
      role: 'perc',
      layer: 'back',
      level: 0.7,
      code: chain('s("[~ gumki]*2")', 'n("<0 3 6>")', 'gain(0.5)'),
    },
    {
      id: 'tabla',
      role: 'perc',
      layer: 'pulse',
      level: 0.55,
      code: chain('s("[~ tabla]*4")', 'n("<3 7 11>")', 'degradeBy(0.2)', 'gain(0.3)'),
    },
    {
      id: 'drone',
      role: 'pad',
      layer: 'harmony',
      level: 0.7,
      code: chain('n("[0,4,7]")', 'scale("$SCALE2")', 's("gm_sitar")', 'n(1)', 'slow(2)', 'room(0.5)', 'gain(0.5)'),
    },
    {
      id: 'shehnai',
      role: 'lead',
      layer: 'hook',
      level: 0.7,
      code: chain('n("<[0 1 2 4] [5 4 2 1] [0 ~ 4 5] [7 5 4 2]>")', 'scale("$SCALE4")', 's("gm_shanai")', 'room(knob("wet"))', 'gain(0.55)'),
      knobs: [wetKnob(0.4, 0.2, 0.7)],
    },
    {
      id: 'tanpura',
      role: 'bass',
      layer: 'low',
      level: 0.6,
      code: chain('n("<0 4>/2")', 'scale("$SCALE1")', 's("sine")', 'attack(1)', 'release(2)', 'gain(0.45)'),
    },
  ],
  labels: {
    beat: 'mridangam syllables',
    back: 'the gumki',
    pulse: 'tabla accents',
    harmony: 'a sitar drone',
    hook: 'a shehnai line',
    low: 'a low drone',
  },
  titles: ['Tala of the Morning', 'Evening Raga', 'Tha Ki Ta', 'Temple Steps', 'Monsoon Cycle', 'Konnakol Light', 'The Ninth Beat', 'River Ghat'],
  movementNames: ['Evening Raga', 'Tala Cycles', 'Monsoon'],
  blurb: 'Mridangam syllables in cycles over a sitar drone, and a shehnai tracing the raga.',
};

export const gamelan: Ensemble = {
  id: 'gamelan',
  name: 'Gamelan',
  tags: ['gamelan', 'indonesian', 'bali', 'java', 'bells', 'pelog', 'world', 'metallophone', 'gong'],
  groove: 'polymeter',
  arc: 'terraced',
  bpm: { min: 88, max: 104, default: 96 },
  modes: ['pelog'],
  tonic: 'C',
  mood: { intensity: 0.45, brightness: 0.65 },
  parts: [
    {
      id: 'saron',
      role: 'lead',
      layer: 'hook',
      level: 0.8,
      code: chain('n("0 1 2 4 [3 2] 1 0 ~")', 'off(1/4, x => x.add(n(2)))', 'scale("$SCALE4")', 's("gm_marimba")', 'room(0.3)', 'gain(0.8)'),
    },
    {
      id: 'bells',
      role: 'chords',
      layer: 'harmony',
      level: 0.7,
      code: chain('n("<0 2 4 1>")', 'scale("$SCALE3")', 's("gm_tubular_bells")', 'room(0.6)', 'gain(0.65)'),
    },
    {
      id: 'glock',
      role: 'arp',
      layer: 'pulse',
      level: 0.6,
      code: chain('n("[0 4]*2")', 'scale("$SCALE5")', 's("gm_glockenspiel")', 'degradeBy(0.3)', 'gain(0.5)'),
    },
    {
      id: 'gong',
      role: 'perc',
      layer: 'beat',
      level: 0.7,
      code: chain('s("gong:<0 3>/4")', 'room(knob("wet"))', 'gain(0.35)'),
      knobs: [wetKnob(0.7, 0.4, 0.95)],
    },
    {
      id: 'kempul',
      role: 'bass',
      layer: 'low',
      level: 0.6,
      code: chain('n("<0 ~ ~ 3>")', 'scale("$SCALE2")', 's("gm_vibraphone")', 'room(0.5)', 'gain(0.5)'),
    },
  ],
  labels: { hook: 'an interlocking marimba', harmony: 'tubular bells', pulse: 'glockenspiel', beat: 'the gong', low: 'a low kempul' },
  titles: ['Pelog Evening', 'Interlocking', 'Bronze Rain', 'Temple Courtyard', 'Colotomic', 'The Great Gong', 'Kotekan', 'Monkey Forest'],
  movementNames: ['Bronze Rain', 'Pelog Evening', 'Interlocking'],
  blurb: 'A gamelan in pelog: a marimba answering itself a quarter-beat late, bells above, the gong every four bars.',
};

export const WORLD: Ensemble[] = [carnatic, gamelan];
