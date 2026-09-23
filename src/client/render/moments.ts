// Musical moments (docs/DESIGN.md "Musical states"): which gestures a section start triggers, and
// the record's look as a pure function of the latest moments and the cycle. Shared by the host
// (which derives moments and times the DOM label) and the renderer (which draws them).
import { BEATS_PER_BAR, type SectionRole } from '../../shared/music.ts';
import { smoothstep } from './geometry.ts';

export type MomentKind = 'drop' | 'build' | 'breakdown' | 'section' | 'silence';

/** The label stays inverted for one bar after a drop; the shockwave takes one beat. */
export const DROP_INVERT_BARS = 1;
export const SHOCKWAVE_BARS = 1 / BEATS_PER_BAR;
/** Lookahead for pre-echo ghosts (bars), and during a build. */
export const LOOKAHEAD_BARS = 1;
export const BUILD_LOOKAHEAD_BARS = 2;

export function sectionMoments(role: SectionRole): MomentKind[] {
  switch (role) {
    case 'drop':
      return ['section', 'drop'];
    case 'build':
      return ['section', 'build'];
    case 'breakdown':
      return ['section', 'breakdown'];
    default:
      return ['section'];
  }
}

export interface Mood {
  mode: 'normal' | 'build' | 'breakdown';
  /** Cycle the mode began, and the length of the section that set it. */
  from: number;
  bars: number;
  /** Cycle of the last drop gesture the flash limiter allowed. */
  dropAt: number | null;
  silent: boolean;
}

export const INITIAL_MOOD: Mood = { mode: 'normal', from: 0, bars: 16, dropAt: null, silent: false };

export function applyMoment(mood: Mood, kind: MomentKind, cycle: number, bars: number): Mood {
  switch (kind) {
    case 'section':
      return { ...mood, mode: 'normal', from: cycle, bars };
    case 'build':
      return { ...mood, mode: 'build', from: cycle, bars };
    case 'breakdown':
      return { ...mood, mode: 'breakdown', from: cycle, bars };
    case 'drop':
      return { ...mood, dropAt: cycle };
    case 'silence':
      return { ...mood, silent: true };
  }
}

export interface Look {
  /** Lens and lane spread, as a fraction of R. */
  spread: number;
  ghostAlpha: number;
  /** Added to the sheen intensity. */
  sheenBoost: number;
  sheenSaturation: number;
  /** Archive alpha of pad washes. */
  padWash: number;
  /** Multiplier on archive glyph alpha (the drop bar is cut deeper). */
  archiveBoost: number;
  lookaheadBars: number;
  /** Label shows clay-on-ink. */
  inverted: boolean;
  /** Progress 0..1 of the drop's shockwave ring, or null. */
  shockwave: number | null;
}

export function lookAt(mood: Mood, cycle: number): Look {
  const look: Look = {
    spread: 0.2,
    ghostAlpha: 1,
    sheenBoost: 0,
    sheenSaturation: 1,
    padWash: 0.045,
    archiveBoost: 1,
    lookaheadBars: LOOKAHEAD_BARS,
    inverted: false,
    shockwave: null,
  };
  const into = cycle - mood.from;
  if (mood.mode === 'build' && into >= 0) {
    const p = smoothstep(into / Math.max(1, mood.bars));
    look.spread = 0.2 + 0.06 * p;
    look.sheenBoost = 0.04 * p;
    look.lookaheadBars = BUILD_LOOKAHEAD_BARS;
  } else if (mood.mode === 'breakdown' && into >= 0) {
    const p = smoothstep(into);
    look.spread = 0.2 - 0.04 * p;
    look.ghostAlpha = 1 - 0.6 * p;
    look.sheenSaturation = 1 - 0.7 * p;
    look.padWash = 0.08;
  }
  if (mood.dropAt !== null) {
    const since = cycle - mood.dropAt;
    if (since >= 0 && since < DROP_INVERT_BARS) {
      look.inverted = true;
      look.archiveBoost = 1.2;
    }
    if (since >= 0 && since < SHOCKWAVE_BARS) look.shockwave = since / SHOCKWAVE_BARS;
  }
  return look;
}
