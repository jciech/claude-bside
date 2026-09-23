// Musical vocabulary shared by server, client and composer drivers.
// Convention (Strudel's own): 1 cycle = 1 bar of 4/4, so cps = bpm / 60 / 4.

export const BEATS_PER_BAR = 4;
export const BPM_MIN = 60;
export const BPM_MAX = 180;
export const DEFAULT_BPM = 120;

export const bpmToCps = (bpm: number): number => bpm / 60 / BEATS_PER_BAR;
export const cpsToBpm = (cps: number): number => cps * 60 * BEATS_PER_BAR;
export const secondsPerBar = (bpm: number): number => (60 / bpm) * BEATS_PER_BAR;

/** What a part does in the arrangement. Drives mixing macros, visuals and analysis priors. */
export const PART_ROLES = [
  'kick', // kick drum / sub hits
  'snare', // snare, clap, rim
  'hats', // hats, cymbals, shakers
  'perc', // hand/world percussion, toms, one-shots
  'breaks', // chopped drum loops, full kits in one part
  'bass',
  'chords', // comping keys, stabs, voicings
  'arp',
  'lead', // melody
  'pad', // sustained harmonic bed, strings, drones
  'texture', // noise, field recordings, fx
  'vox', // vocal samples, speech
] as const;
export type PartRole = (typeof PART_ROLES)[number];

/** Visual/colour family per role (see docs/DESIGN.md voice spectrum, ordered by register). */
export const VOICE_FAMILIES = ['kick', 'bass', 'snare', 'hat', 'lead', 'keys', 'pad', 'fx'] as const;
export type VoiceFamily = (typeof VOICE_FAMILIES)[number];
export const ROLE_FAMILY: Record<PartRole, VoiceFamily> = {
  kick: 'kick',
  bass: 'bass',
  snare: 'snare',
  perc: 'snare',
  breaks: 'snare',
  hats: 'hat',
  lead: 'lead',
  vox: 'lead',
  chords: 'keys',
  arp: 'keys',
  pad: 'pad',
  texture: 'fx',
};
export const PERCUSSIVE_ROLES: ReadonlySet<PartRole> = new Set(['kick', 'snare', 'hats', 'perc', 'breaks']);
export const PITCHED_ROLES: ReadonlySet<PartRole> = new Set(['bass', 'chords', 'arp', 'lead', 'pad']);

/** The formal function of a section within a movement's arc. */
export const SECTION_ROLES = [
  'intro',
  'groove',
  'build',
  'drop',
  'breakdown',
  'bridge',
  'interlude',
  'outro',
  'transition',
  'reprise',
] as const;
export type SectionRole = (typeof SECTION_ROLES)[number];

export const SECTION_LENGTHS = [8, 16, 24, 32, 48, 64] as const;
export type SectionLength = (typeof SECTION_LENGTHS)[number];

/**
 * How a section begins. All are rendered deterministically by every client's performer:
 * - cut: previous parts stop at bar 0 (tails ring out on their orbits)
 * - crossfade: previous section keeps playing for `bars`, fading out while new parts fade in
 * - riser: an engine-owned noise riser plays over the last `bars` of the previous section
 * - breath: the previous section is muted for its final `bars` (a held breath before the downbeat)
 */
export const TRANSITION_TYPES = ['cut', 'crossfade', 'riser', 'breath'] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export const GROOVES = [
  'four-on-floor',
  'broken',
  'breakbeat',
  'half-time',
  'double-time',
  'swing',
  'shuffle',
  'odd-meter',
  'free',
] as const;
export type Groove = (typeof GROOVES)[number];

export const ARC_SHAPES = ['plateau', 'wave', 'ramp-up', 'ramp-down', 'peak-and-release', 'terraced'] as const;
export type ArcShape = (typeof ARC_SHAPES)[number];

/** Listener reactions. `harsh` also triggers a conductor safety trim when enough of the room agrees. */
export const REACTIONS = ['fire', 'vibe', 'bored', 'harsh'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** A value that moves from `start` (bar 0) to `end` (last bar), both in 0..1. */
export interface Span {
  start: number;
  end: number;
}

/** Perceptual descriptors, all 0..1. Measured from haps (+ client telemetry), never regexed from code. */
export interface Descriptors {
  intensity: number;
  brightness: number;
  density: number;
  tension: number;
}

/** Part ids appear in code labels, knob keys and UI; keep them short, lowercase and stable. */
export const PART_ID_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;
export const MAX_PARTS_PER_SECTION = 8;
