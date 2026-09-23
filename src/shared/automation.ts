// Automation lanes as pure functions of the score bar, shared by the performer, the conductor and the
// checker so all three hear the same values (ARCHITECTURE §6): before a lane a value holds the previous
// lane's end or its base (level, the knob default, or for carried parts the knob's value at the end of
// the previous section); `exp` is geometric; after the last lane the value holds.
import type { Automation, Knob } from './plan.ts';

const EXP_FLOOR = 1e-3;

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

/**
 * A carried part's knobs (plan code null), each starting where the previous section's same-id part
 * left it: that part's lane value at `endBar` (the score bar its section ended on), clamped to the
 * carried declaration's range. The conductor writes these into the program's knob defaults, the
 * checker measures them and the performer plays them. Returns `knobs` itself when nothing changes.
 */
export function carriedKnobs(knobs: Knob[], before: { knobs: readonly Knob[]; automation: readonly Automation[] }, endBar: number): Knob[] {
  let changed = false;
  const out = knobs.map((k) => {
    const ended = before.knobs.find((b) => b.name === k.name);
    if (!ended) return k;
    const value = Math.min(k.max, Math.max(k.min, laneValue(lanesFor(before.automation, `knob:${k.name}`), endBar, ended.default)));
    if (value === k.default) return k;
    changed = true;
    return { ...k, default: value };
  });
  return changed ? out : knobs;
}
