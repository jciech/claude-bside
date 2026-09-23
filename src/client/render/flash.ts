// Photosensitivity guard (WCAG 2.3.1; docs/DESIGN.md "Tiers": ≤ 2 large-area luminance transitions
// per second, drops ≤ 1 per 2 s). The drop — a shockwave ring plus the label turning clay-on-ink — is
// the Lathe's only large-area gesture (two transitions); everything else moves gradually or covers a
// small area. Spacing drops ≥ 2 s apart therefore also keeps transitions ≤ 1 per second.

export const DROP_INTERVAL_MS = 2000;

export class FlashLimiter {
  private lastDropAt = Number.NEGATIVE_INFINITY;

  /** Records the drop gesture and returns true if it may be shown now. */
  allowDrop(nowMs: number): boolean {
    if (nowMs - this.lastDropAt < DROP_INTERVAL_MS) return false;
    this.lastDropAt = nowMs;
    return true;
  }
}
