// Automation lanes evaluated on the server the same way the performer does (docs/ARCHITECTURE §6):
// before a lane a value holds the previous lane's end or its base (level, the knob default, or for
// carried parts the knob's value at the end of the previous section); `exp` is geometric; after the
// last lane the value holds. Used for the composer's context (knob values at a section's end) and to
// know whether a section's held state is silent.
import { laneValue, lanesFor } from '../../shared/automation.ts';
import type { Automation, Knob } from '../../shared/plan.ts';

export { laneValue, lanesFor };

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
