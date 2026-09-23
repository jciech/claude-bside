// Colours and the per-voice glyph grammar of the Lathe (docs/DESIGN.md "Tokens", "The Lathe").
import type { VoiceFamily } from '../../shared/music.ts';

export const INK = {
  lacquer1: '#0E0C12',
  lacquer3: '#221E2A',
  paper: '#EFE7D6',
  clay: '#E27C5C',
  clayInk: '#2A120A',
  labelPaper: '#ECE2CC',
  labelInk: '#7A5A40',
  metal: '#B9B1A3',
  metalLight: '#DDD5C7',
  headshell: '#2B2530',
} as const;

/** Voice spectrum, ordered by register: colour itself says low vs high. */
export const VOICE_COLOR: Record<VoiceFamily, string> = {
  kick: '#FF5A4E',
  bass: '#FF9A3C',
  snare: '#FFD447',
  hat: '#C6F35E',
  lead: '#45E3C2',
  keys: '#58A8FF',
  pad: '#A08BFF',
  fx: '#FF78D6',
};

/** Where in the groove a family sits when it has no pitch (fraction of the lane spread; low = inner). */
export const FAMILY_LANE: Record<VoiceFamily, number> = {
  kick: -0.42,
  bass: -0.26,
  pad: -0.05,
  keys: 0.08,
  snare: 0.18,
  lead: 0.28,
  fx: 0.35,
  hat: 0.42,
};

/** Families whose lane follows pitch (MIDI) when the event has one. */
export const PITCHED_FAMILIES: ReadonlySet<VoiceFamily> = new Set(['bass', 'keys', 'pad', 'lead']);

/** Families whose bloom holds for the note's length instead of decaying from the onset. */
export const SUSTAINED_FAMILIES: ReadonlySet<VoiceFamily> = new Set(['pad', 'bass', 'keys']);

/** Bloom diameter at full loudness, as a fraction of the record radius R. */
export const BLOOM_SIZE: Record<VoiceFamily, number> = {
  kick: 0.13,
  bass: 0.075,
  snare: 0.075,
  hat: 0.04,
  lead: 0.07,
  keys: 0.05,
  pad: 0.2,
  fx: 0.05,
};

/** Pre-echo ghost diameter as a fraction of R. */
export const GHOST_SIZE: Record<VoiceFamily, number> = {
  kick: 0.04,
  bass: 0.034,
  snare: 0.034,
  hat: 0.02,
  lead: 0.034,
  keys: 0.028,
  pad: 0.06,
  fx: 0.024,
};

function hexToRgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}
