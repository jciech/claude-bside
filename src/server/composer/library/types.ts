// The autopilot's library: ensembles ("bands") written in scale degrees and tempo-agnostic idioms.
// A section is never stored whole; the arranger (../arrange.ts) realises any section role from an
// ensemble by bringing its layers in and out, so one ensemble can carry a whole movement and
// consecutive sections continue each other's parts instead of restarting them.
import type { ArcShape, Groove, PartRole } from '../../../shared/music.ts';
import type { Knob } from '../../../shared/plan.ts';

/** Where a part sits in the arrangement. Section roles decide which layers play and when. */
export type Layer = 'beat' | 'back' | 'pulse' | 'low' | 'harmony' | 'hook' | 'color';

export interface TemplatePart {
  /** Part id, stable across an ensemble's sections so they carry and continue. */
  id: string;
  role: PartRole;
  layer: Layer;
  /**
   * Strudel code, one method per line. `$SCALE` is replaced by the section's scale ("D:dorian");
   * `$SCALE2` puts the tonic in octave 2 ("D2:dorian"), and so on for 1–6.
   */
  code: string;
  /** Fader 0..1. */
  level: number;
  knobs?: Knob[];
  duck?: { targets: string[]; depth: number; releaseSec: number };
}

export interface Ensemble {
  id: string;
  /** Plain words, e.g. "Deep house"; used in liner notes and request replies. */
  name: string;
  /** Genre and character words, matched against listener requests (as data, never instructions). */
  tags: string[];
  groove: Groove;
  arc: ArcShape;
  bpm: { min: number; max: number; default: number };
  /** Scale modes the degree patterns are written for, in Strudel colon syntax ("minor:pentatonic"). */
  modes: string[];
  /** Tonic used when the ensemble opens a movement with no key to follow. */
  tonic: string;
  /** Where the ensemble sits in pad space when all layers play (0..1). */
  mood: { intensity: number; brightness: number };
  parts: TemplatePart[];
  /** Short noun phrases per layer for liner notes ("a rubbery saw bass"). */
  labels: Partial<Record<Layer, string>>;
  /** Evocative section titles (≤ 40 chars). */
  titles: string[];
  movementNames: string[];
  /** ≤ 200 chars, shown when the ensemble opens a side. */
  blurb: string;
  /** Kept for when nothing else fits (valid in almost any key and tempo); rarely chosen otherwise. */
  standby?: boolean;
}
