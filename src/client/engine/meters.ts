// Engine.meters() (src/client/engine/types.ts): part levels smoothed over audio time rather than per
// call, so the Lathe feed, the UI pulse and anything else can poll at their own rates without
// changing how fast the meters move.
import type { Meters } from './types.ts';

/** Time constant of the per-part smoothing. */
export const METER_TAU_SEC = 0.075;
const FLOOR_DB = -120;
/** dB below full scale that reads as 0. */
const RANGE_DB = 60;

export function silentMeters(): Meters {
  return { master: { rmsDb: FLOOR_DB, peakDb: FLOOR_DB }, parts: {} };
}

/** A channel's linear RMS → 0..1 loudness. */
export function loudness(rms: number): number {
  const db = rms > 0 ? 20 * Math.log10(rms) : FLOOR_DB;
  return Math.min(1, Math.max(0, (db + RANGE_DB) / RANGE_DB));
}

export class MeterSmoother {
  private at: number | null = null;
  private value: Meters = silentMeters();

  /**
   * The smoothed reading at time `t` (seconds). `sample` supplies the raw levels and runs at most
   * once per distinct `t`; instances missing from a sample are dropped.
   */
  read(t: number, sample: () => Meters): Meters {
    if (this.at === t) return this.value;
    const raw = sample();
    const k = this.at === null || t < this.at ? 1 : 1 - Math.exp(-(t - this.at) / METER_TAU_SEC);
    const parts: Record<string, number> = {};
    for (const [key, level] of Object.entries(raw.parts)) {
      const prev = this.value.parts[key] ?? 0;
      parts[key] = prev + k * (level - prev);
    }
    this.at = t;
    this.value = { master: raw.master, parts };
    return this.value;
  }
}
