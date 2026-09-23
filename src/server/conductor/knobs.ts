// Automation lanes evaluated on the server the same way the performer does (docs/ARCHITECTURE §6):
// before a lane a value holds the previous lane's end or its base (level, the knob default, or for
// carried parts the knob's value at the end of the previous section); `exp` is geometric; after the
// last lane the value holds. Used for the composer's context (knob values at a section's end) and to
// know whether a section's held state is silent.
import type { Automation, Knob } from '../../shared/plan.ts';

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

export function levelAt(part: { level: number; automation: readonly Automation[] }, bar: number): number {
  return laneValue(lanesFor(part.automation, 'level'), bar, part.level);
}

/** Knob values at score bar `bar`, clamped to each knob's range. `inherited` = carried starting values. */
export function knobValuesAt(
  part: { knobs: readonly Knob[]; automation: readonly Automation[] },
  bar: number,
  inherited: Readonly<Record<string, number>> | null,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of part.knobs) {
    const base = inherited?.[k.name] ?? k.default;
    const v = laneValue(lanesFor(part.automation, `knob:${k.name}`), bar, base);
    out[k.name] = Math.round(Math.min(k.max, Math.max(k.min, v)) * 1000) / 1000;
  }
  return out;
}
