// What each engine channel does at a given cycle, as pure functions: level × automation ×
// transition envelope × intensity macro × trims, and the transition filters. The channel planner
// samples these on a grid and schedules AudioParam ramps at each point's audio time, so every
// client produces the same curves (src/client/engine/types.ts, "Level"). Also the fader and knob
// values an instance plays with at a cycle (Engine.levelAt / knobValues).
import { scoreBarAt } from '../../shared/schedule.ts';
import type { MixerState } from '../../shared/program.ts';
import { dbToGain, intensityDb, knobAt, levelAt, macrosAt, trimDbAt } from './knobs.ts';
import type { InstanceSpec } from './score.ts';
import { inWindowAt, lastExitBefore } from './window.ts';

/** Filter settings that leave the signal untouched. */
export const OPEN_LOWPASS_HZ = 20000;
export const OPEN_HIGHPASS_HZ = 10;
const CLOSED_LOWPASS_HZ = 180;
const CLOSED_HIGHPASS_HZ = 2500;
const EPS = 1e-6;

const scoreBarOf = (inst: InstanceSpec, c: number): number => scoreBarAt(inst.section, c - inst.section.startCycle);

/** The instance's fader at `c`: its level lane at that score bar, before transitions, macros and trims. */
export function instanceLevelAt(inst: InstanceSpec, c: number): number {
  return levelAt(inst.part, scoreBarOf(inst, c));
}

/** The instance's knob values at `c`: lanes, carried values and the room's follow offsets. */
export function instanceKnobsAt(inst: InstanceSpec, c: number, mixer: MixerState): Record<string, number> {
  const bar = scoreBarOf(inst, c);
  const macros = macrosAt(mixer, c);
  const out: Record<string, number> = {};
  for (const knob of inst.part.knobs) out[knob.name] = knobAt(inst.part, knob, bar, inst.inherited?.[knob.name], macros);
  return out;
}

/** Gain while in-window, before the release that follows an exit. */
function soundingGain(inst: InstanceSpec, c: number, mixer: MixerState): number {
  let g = instanceLevelAt(inst, c);
  if (inst.fadeIn && c < inst.fadeIn.at + inst.fadeIn.bars) g *= Math.sin((Math.PI / 2) * unit(c, inst.fadeIn.at, inst.fadeIn.bars));
  if (inst.fadeOut && c >= inst.fadeOut.at) g *= Math.cos((Math.PI / 2) * unit(c, inst.fadeOut.at, inst.fadeOut.bars));
  const db = intensityDb(inst.part.role, macrosAt(mixer, c).intensity) + trimDbAt(mixer, inst.part.id, c);
  return g * dbToGain(db);
}

const unit = (c: number, at: number, bars: number): number => Math.min(1, Math.max(0, (c - at) / Math.max(EPS, bars)));

/** The instance's channel gain at cycle `c` (0 outside its window, releasing after an exit). */
export function instanceGainAt(inst: InstanceSpec, c: number, mixer: MixerState): number {
  if (inWindowAt(inst, c)) return soundingGain(inst, c, mixer);
  const lookback = Math.max(inst.releaseBars, inst.endReleaseBars);
  const exit = lastExitBefore(inst, c, lookback);
  if (exit === null) return 0;
  const release = Math.abs(exit - inst.end) < EPS ? inst.endReleaseBars : inst.releaseBars;
  const k = 1 - (c - exit) / release;
  if (k <= 0) return 0;
  return soundingGain(inst, exit - EPS, mixer) * k;
}

/** Transition filters of the instance at `c` (open unless a filter transition acts on it). */
export function instanceFiltersAt(inst: InstanceSpec, c: number): { lowpass: number; highpass: number } {
  let lowpass = OPEN_LOWPASS_HZ;
  let highpass = OPEN_HIGHPASS_HZ;
  const lp = inst.lowpassClose;
  if (lp && c >= lp.at) lowpass = OPEN_LOWPASS_HZ * (CLOSED_LOWPASS_HZ / OPEN_LOWPASS_HZ) ** unit(c, lp.at, lp.bars);
  const hp = inst.highpassOpen;
  if (hp && c >= hp.at - EPS) highpass = CLOSED_HIGHPASS_HZ * (OPEN_HIGHPASS_HZ / CLOSED_HIGHPASS_HZ) ** unit(c, hp.at, hp.bars);
  return { lowpass, highpass };
}

/** The instance on a channel that owns its filters at `c`: the one sounding, else the latest started. */
export function filterOwner(list: readonly InstanceSpec[], c: number): InstanceSpec | null {
  let owner: InstanceSpec | null = null;
  for (const inst of list) {
    if (inst.start > c + EPS) break;
    owner = inst;
    if (c < inst.end) break;
  }
  return owner;
}

/** Channel gain for an orbit: the sum over its instances (the conductor keeps them disjoint). */
export function channelGainAt(list: readonly InstanceSpec[], c: number, mixer: MixerState): number {
  let g = 0;
  for (const inst of list) {
    if (inst.start > c + 1) break;
    if (c > inst.end + inst.endReleaseBars && c > inst.end + inst.releaseBars) continue;
    g += instanceGainAt(inst, c, mixer);
  }
  return g;
}

export function channelFiltersAt(list: readonly InstanceSpec[], c: number): { lowpass: number; highpass: number } {
  const owner = filterOwner(list, c);
  return owner ? instanceFiltersAt(owner, c) : { lowpass: OPEN_LOWPASS_HZ, highpass: OPEN_HIGHPASS_HZ };
}
