// Record geometry (docs/DESIGN.md "The Lathe"): one revolution per bar, an inward spiral over the
// side's bars with a land (a wider gap) before every track. Pure; lengths are device pixels,
// cycles are absolute bars. Record-space angle a(c) = −2πc (0 = 12 o'clock, laid counter-clockwise);
// the platter turns clockwise by 2π·c_now, so the stylus at 12 o'clock always sits on "now".
import type { VoiceFamily } from '../../shared/music.ts';
import { FAMILY_LANE, PITCHED_FAMILIES } from './tokens.ts';

export const TAU = Math.PI * 2;

/** Room kept ahead of the needle when a side runs past its planned length. */
const OVERRUN_HEADROOM_BARS = 8;
const OVERRUN_STEP_BARS = 32;
/** Typical track length, used to reserve room for lands not yet committed. */
const TYPICAL_TRACK_BARS = 24;
const MIN_LAND_SLOTS = 4;

export interface SideSpec {
  startCycle: number;
  /** Bars the spiral is laid out over (≥ the planned length). */
  bars: number;
  /** Track starts after startCycle, ascending: the groove steps inward by one land at each. */
  lands: number[];
  /** Lands the layout reserves room for (≥ lands.length). */
  landSlots: number;
}

export interface Layout {
  cx: number;
  cy: number;
  /** Record radius. */
  R: number;
  labelR: number;
  /** Radius of the first groove (the lead-in lies outside it). */
  outerR: number;
  /** The spiral never goes inside this (dead wax before the label). */
  innerR: number;
  /** Radial advance per bar. */
  pitch: number;
  landW: number;
}

/** Bars to lay the spiral out over: the planned length, grown in steps once the side overruns it. */
export function spiralBars(plannedBars: number, startCycle: number, nowCycle: number): number {
  const planned = Math.max(1, plannedBars);
  const needed = nowCycle - startCycle + OVERRUN_HEADROOM_BARS;
  if (needed <= planned) return planned;
  return planned + OVERRUN_STEP_BARS * Math.ceil((needed - planned) / OVERRUN_STEP_BARS);
}

export function landSlots(bars: number, lands: number): number {
  return Math.max(MIN_LAND_SLOTS, lands, Math.round(bars / TYPICAL_TRACK_BARS));
}

export function sideSpec(startCycle: number, plannedBars: number, trackStarts: readonly number[], nowCycle: number): SideSpec {
  const bars = spiralBars(plannedBars, startCycle, nowCycle);
  const lands = [...new Set(trackStarts)].filter((c) => c > startCycle + 1e-6).sort((a, b) => a - b);
  return { startCycle, bars, lands, landSlots: landSlots(bars, lands.length) };
}

export function layoutRecord(width: number, height: number, side: SideSpec): Layout {
  const R = (0.93 * Math.min(width, height)) / 2;
  const labelR = 0.3 * R;
  const outerR = 0.955 * R;
  const innerR = 1.12 * labelR;
  const span = outerR - innerR;
  // Lands never take more than a fifth of the playing surface, however many tracks the side has.
  const landW = Math.min(0.012 * R, (0.2 * span) / side.landSlots);
  const pitch = (span - side.landSlots * landW) / side.bars;
  return { cx: width / 2, cy: height / 2, R, labelR, outerR, innerR, pitch, landW };
}

/** Number of lands at or before `cycle`. */
export function landsUpTo(lands: readonly number[], cycle: number): number {
  let lo = 0;
  let hi = lands.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lands[mid]! <= cycle) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Groove radius at a cycle: r(c) = 0.955R − (c − start)·pitch − lands(c)·landW, kept on the record. */
export function grooveRadius(L: Layout, side: SideSpec, cycle: number): number {
  const r = L.outerR - (cycle - side.startCycle) * L.pitch - landsUpTo(side.lands, cycle) * L.landW;
  return Math.min(L.outerR, Math.max(L.innerR, r));
}

export function recordAngle(cycle: number): number {
  return -TAU * cycle;
}

/** Canvas arc() angle (0 = +x, clockwise) for a record-space angle. */
export function canvasAngle(recordA: number): number {
  return recordA - Math.PI / 2;
}

/** Point at radius r and record-space angle a, relative to the centre. */
export function polar(r: number, a: number): { x: number; y: number } {
  return { x: r * Math.sin(a), y: -r * Math.cos(a) };
}

/** Lane offset in [-0.5, 0.5] of the lane spread: pitched voices by register, others by family. */
export function laneOffset(family: VoiceFamily, midi: number | null): number {
  if (midi !== null && Number.isFinite(midi) && PITCHED_FAMILIES.has(family)) {
    return Math.max(-0.46, Math.min(0.46, (midi - 60) / 40));
  }
  return FAMILY_LANE[family];
}

export function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

/** Sheen hue for the needle's x (dark −1 → bright +1): violet 265° → gold 40°, through magenta. */
export function sheenHue(x: number): number {
  const t = (Math.max(-1, Math.min(1, x)) + 1) / 2;
  return (265 + 135 * t) % 360;
}

/** Sheen intensity for the needle's y (calm −1 → intense +1): 0.07 → 0.14. */
export function sheenIntensity(y: number): number {
  const t = (Math.max(-1, Math.min(1, y)) + 1) / 2;
  return 0.07 + 0.07 * t;
}

export function sideLetter(side: number): string {
  let n = Math.max(1, Math.floor(side));
  let out = '';
  while (n > 0) {
    const d = (n - 1) % 26;
    out = String.fromCharCode(65 + d) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
