// The fast lane (ARCHITECTURE §8): the room's smoothed pull becomes mixer macros as cycle-stamped
// keyframes every client interpolates identically — at most one per bar, starting at least
// MIN_CHANGE_LEAD ahead, ramping over 1 bar for small rooms and 2 for larger ones. A new keyframe is
// only issued once the previous ramp has finished, so prev → next always reproduces what clients
// were already playing. Also: the harsh-consensus safety trim, per-section balance trims, and the
// needle (where the music is heading, in pad space).
import type { PadPoint } from '../../shared/protocol.ts';
import type { MixerKeyframe, MixerState, SectionProgram } from '../../shared/program.ts';
import { scoreBarAt } from '../../shared/schedule.ts';
import { lerpSpan } from './arc.ts';

const MACRO_STEP = 0.02;
const SAFETY_BARS = 16;
const SAFETY = { masterDb: -3, highShelfDb: -3 } as const;
/** How far (in descriptor units) a full macro moves the needle. */
const FAST_LANE_WEIGHT = 0.15;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

function sameTrims(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}

export interface MixerTickInput {
  state: MixerState;
  nowCycle: number;
  /** Earliest integer cycle a new keyframe may start at (≥ now + MIN_CHANGE_LEAD). */
  earliestCycle: number;
  pull: { point: PadPoint; listeners: number };
  /** Balance trims of the section sounding at earliestCycle. */
  trims: Record<string, number>;
}

/** The next mixer state, or null when nothing needs to change yet. */
export function mixerTick(input: MixerTickInput): MixerState | null {
  const { state } = input;
  if (input.nowCycle < state.next.atCycle + state.next.rampBars) return null;
  const listening = input.pull.listeners > 0;
  const macros = {
    brightness: listening ? round2(clamp(input.pull.point.x, -1, 1)) : 0,
    intensity: listening ? round2(clamp(input.pull.point.y, -1, 1)) : 0,
  };
  const current = state.next;
  const delta = Math.max(Math.abs(macros.brightness - current.macros.brightness), Math.abs(macros.intensity - current.macros.intensity));
  // Small moves wait for a real step, except the final settle back to neutral.
  const moved = delta >= MACRO_STEP || (delta > 0 && macros.brightness === 0 && macros.intensity === 0);
  const expiredSafety = state.safety !== null && input.nowCycle >= state.safety.untilCycle;
  if (!moved && sameTrims(input.trims, current.trimsDb) && !expiredSafety) return null;
  const next: MixerKeyframe = {
    atCycle: input.earliestCycle,
    rampBars: input.pull.listeners <= 3 ? 1 : 2,
    macros: moved ? macros : current.macros,
    trimsDb: { ...input.trims },
  };
  return { rev: state.rev + 1, prev: current, next, safety: expiredSafety ? null : state.safety };
}

/** Applies (or extends) the safety trim after a harsh consensus. */
export function withSafety(state: MixerState, fromCycle: number): MixerState {
  const active = state.safety && state.safety.untilCycle > fromCycle ? state.safety : null;
  const safety = active
    ? { ...active, untilCycle: Math.max(active.untilCycle, fromCycle + SAFETY_BARS) }
    : { ...SAFETY, fromCycle, untilCycle: fromCycle + SAFETY_BARS };
  return { ...state, rev: state.rev + 1, safety };
}

/** Macro values at a cycle, as every performer computes them. */
export function macrosAt(state: MixerState, cycle: number): { brightness: number; intensity: number } {
  const { prev, next } = state;
  const from = (prev ?? next).macros;
  if (cycle <= next.atCycle) return from;
  const t = clamp((cycle - next.atCycle) / Math.max(1e-9, next.rampBars), 0, 1);
  return {
    brightness: from.brightness + (next.macros.brightness - from.brightness) * t,
    intensity: from.intensity + (next.macros.intensity - from.intensity) * t,
  };
}

/** Where the music is heading: the section's target at this bar, shifted by how it measured, plus the fast lane. */
export function needlePoint(section: SectionProgram | null, cycle: number, mixer: MixerState): PadPoint {
  const macros = macrosAt(mixer, cycle);
  if (!section) return { x: round2(macros.brightness * FAST_LANE_WEIGHT * 2), y: round2(macros.intensity * FAST_LANE_WEIGHT * 2) };
  const progress = clamp(scoreBarAt(section, Math.max(0, cycle - section.startCycle)) / Math.max(1, section.bars), 0, 1);
  const mean = (s: { start: number; end: number }) => (s.start + s.end) / 2;
  const axis = (key: 'intensity' | 'brightness', macro: number) => {
    const target = lerpSpan(section.targets[key], progress);
    const offset = mean(section.measured[key]) - mean(section.targets[key]);
    return round2(clamp(2 * clamp(target + offset + FAST_LANE_WEIGHT * macro, 0, 1) - 1, -1, 1));
  };
  return { x: axis('brightness', macros.brightness), y: axis('intensity', macros.intensity) };
}
