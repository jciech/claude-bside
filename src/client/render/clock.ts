// The renderer's clock: extrapolates cycles between ClockSamples in epoch time
// (performance.timeOrigin + performance.now(), comparable across the main thread and a worker whose
// performance.now() has its own origin). Small corrections are slewed so the platter never jumps;
// large ones (timeline changes, clock-sync steps, a stalled thread) snap.
import type { ClockSample } from './protocol.ts';

/** Corrections up to this much audio time are slewed; larger ones snap. */
export const SLEW_MAX_SEC = 0.06;
/** Time constant of the slew (ms). SLEW_MAX_SEC / tau < 1, so a slewed platter never turns backwards. */
export const SLEW_TAU_MS = 250;

export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export class RenderClock {
  private sample: ClockSample | null = null;
  private correction = 0;
  private correctionAt = 0;

  get ready(): boolean {
    return this.sample !== null;
  }

  update(sample: ClockSample, nowEpochMs: number): void {
    if (!Number.isFinite(sample.epochMs) || !Number.isFinite(sample.cycle) || !(sample.cps > 0)) return;
    const shown = this.sample ? this.cycleAt(nowEpochMs) : null;
    this.sample = sample;
    this.correction = 0;
    if (shown === null) return;
    const error = shown - this.cycleAt(nowEpochMs);
    if (Math.abs(error) <= SLEW_MAX_SEC * sample.cps) {
      this.correction = error;
      this.correctionAt = nowEpochMs;
    }
  }

  cycleAt(nowEpochMs: number): number {
    const s = this.sample;
    if (!s) return 0;
    const base = s.cycle + ((nowEpochMs - s.epochMs) / 1000) * s.cps;
    if (this.correction === 0) return base;
    const age = Math.max(0, nowEpochMs - this.correctionAt);
    return base + this.correction * Math.exp(-age / SLEW_TAU_MS);
  }

  cps(): number {
    return this.sample?.cps ?? 0.5;
  }
}
