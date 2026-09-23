// Automation lanes, knob values and the fast-lane mixer as pure functions of (score bar, cycle), so
// every client computes the same numbers (ARCHITECTURE §6, §8). Lane semantics match the conductor's
// (src/server/conductor/knobs.ts): before a lane a value holds the previous lane's end or its base;
// `exp` is geometric; after the last lane the value holds.
import type { Automation, Knob } from '../../shared/plan.ts';
import type { MixerKeyframe, MixerState } from '../../shared/program.ts';
import { PERCUSSIVE_ROLES, type PartRole } from '../../shared/music.ts';

const EXP_FLOOR = 1e-3;

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
export const dbToGain = (db: number): number => 10 ** (db / 20);

export function laneValue(lanes: readonly Automation[], bar: number, base: number): number {
  let value = base;
  for (const lane of [...lanes].sort((a, b) => a.fromBar - b.fromBar)) {
    if (bar < lane.fromBar) break;
    if (bar >= lane.toBar) {
      value = lane.to;
      continue;
    }
    const t = (bar - lane.fromBar) / Math.max(1, lane.toBar - lane.fromBar);
    if (lane.curve === 'exp' && lane.from >= 0 && lane.to >= 0) {
      const a = Math.max(EXP_FLOOR, lane.from);
      const b = Math.max(EXP_FLOOR, lane.to);
      value = a * (b / a) ** t;
    } else {
      value = lane.from + (lane.to - lane.from) * t;
    }
    break;
  }
  return value;
}

export function lanesFor(automation: readonly Automation[], target: string): Automation[] {
  return automation.filter((a) => a.target === target);
}

type Automated = { level: number; automation: readonly Automation[]; knobs: readonly Knob[] };

/** The part's fader at a score bar (the level lane, else `level`). */
export function levelAt(part: Pick<Automated, 'level' | 'automation'>, bar: number): number {
  return clamp(laneValue(lanesFor(part.automation, 'level'), bar, part.level), 0, 1);
}

/**
 * A knob's lane value at a score bar before the room's follow offset (unclamped). For a carried part
 * the conductor has set `default` to the value its predecessor ended on.
 */
export function knobBaseAt(part: Pick<Automated, 'automation'>, knob: Knob, bar: number): number {
  return laneValue(lanesFor(part.automation, `knob:${knob.name}`), bar, knob.default);
}

export interface Macros {
  brightness: number;
  intensity: number;
}

/** Lane value + follow offset (up to ±half the range at a full macro), clamped to the knob's range. */
export function knobAt(part: Pick<Automated, 'automation'>, knob: Knob, bar: number, macros: Macros): number {
  const base = knobBaseAt(part, knob, bar);
  const follow = followOffset(knob.follows, macros) * ((knob.max - knob.min) / 2);
  return clamp(base + follow, Math.min(knob.min, knob.max), Math.max(knob.min, knob.max));
}

function followOffset(follows: Knob['follows'], macros: Macros): number {
  switch (follows) {
    case 'brightness':
      return macros.brightness;
    case '-brightness':
      return -macros.brightness;
    case 'intensity':
      return macros.intensity;
    case '-intensity':
      return -macros.intensity;
    default:
      return 0;
  }
}

/** Where `cycle` sits in the keyframe ramp: 0 = prev's values (or next's when prev is null), 1 = next's. */
function rampPosition(next: MixerKeyframe, cycle: number): number {
  if (cycle <= next.atCycle) return 0;
  return clamp((cycle - next.atCycle) / Math.max(1e-9, next.rampBars), 0, 1);
}

export function macrosAt(state: MixerState, cycle: number): Macros {
  const { prev, next } = state;
  const from = (prev ?? next).macros;
  const t = rampPosition(next, cycle);
  return {
    brightness: clamp(from.brightness + (next.macros.brightness - from.brightness) * t, -1, 1),
    intensity: clamp(from.intensity + (next.macros.intensity - from.intensity) * t, -1, 1),
  };
}

/** Balance/safety trim for a part id, interpolated in dB like the macros. */
export function trimDbAt(state: MixerState, partId: string, cycle: number): number {
  const { prev, next } = state;
  const from = (prev ?? next).trimsDb[partId] ?? 0;
  const to = next.trimsDb[partId] ?? 0;
  return from + (to - from) * rampPosition(next, cycle);
}

/**
 * The temporary safety trim, ramping in over the bar after fromCycle and out over the bar before
 * untilCycle, so a later update that clears it (the server drops it at untilCycle) never jumps.
 */
export function safetyAt(state: MixerState, cycle: number): { masterDb: number; highShelfDb: number } {
  const s = state.safety;
  if (!s || cycle <= s.fromCycle || cycle >= s.untilCycle) return { masterDb: 0, highShelfDb: 0 };
  const span = s.untilCycle - s.fromCycle;
  const ramp = Math.min(1, span / 2);
  const k = Math.min(1, (cycle - s.fromCycle) / ramp, (s.untilCycle - cycle) / ramp);
  return { masterDb: s.masterDb * k, highShelfDb: s.highShelfDb * k };
}

/** Intensity macro on channels: percussive roles ±3 dB, pads and textures ∓2 dB. */
export function intensityDb(role: PartRole, intensity: number): number {
  if (PERCUSSIVE_ROLES.has(role)) return 3 * intensity;
  if (role === 'pad' || role === 'texture') return -2 * intensity;
  return 0;
}

/** Master tilt from the brightness macro: ±4 dB high shelf with a gentler opposite low shelf. */
export function tiltDb(brightness: number): { lowShelfDb: number; highShelfDb: number } {
  return { lowShelfDb: -2 * brightness, highShelfDb: 4 * brightness };
}

/**
 * Brightness macro applied to a hap's own values at its onset: cutoff × 2^mb, hcutoff × 2^(mb/2),
 * room/delay sends × (1 − 0.3·mb), clamped to the hap limits.
 */
export function applyBrightness(value: Record<string, unknown>, mb: number): void {
  if (mb === 0) return;
  const scale = (key: string, factor: number, lo: number, hi: number) => {
    const v = value[key];
    if (typeof v === 'number' && Number.isFinite(v)) value[key] = clamp(v * factor, lo, hi);
  };
  scale('cutoff', 2 ** mb, 20, 20000);
  scale('hcutoff', 2 ** (mb / 2), 20, 20000);
  scale('room', 1 - 0.3 * mb, 0, 1);
  scale('delay', 1 - 0.3 * mb, 0, 0.9);
}
