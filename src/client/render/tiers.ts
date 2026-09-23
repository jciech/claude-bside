// Render tiers (docs/DESIGN.md "Tiers"). The user's choice is a ceiling the governor can only lower:
// Full → Lite → Lite at DPR 1. It never moves anyone into Calm (that changes what the record means —
// it stops turning) and never above what the user picked.
import type { RenderTier } from './protocol.ts';

export const MAX_DEGRADE_LEVEL = 2;

export interface ResolvedTier {
  tier: RenderTier;
  /** Cap on the backing store's device-pixel ratio. */
  dprCap: number;
}

const TIER_DPR: Record<RenderTier, number> = { full: 2, lite: 1.5, calm: 2 };
/** Rendering on the main thread (no OffscreenCanvas) shares a thread with the audio scheduler. */
const MAIN_THREAD_DPR = 1.5;

export function resolveTier(user: RenderTier, level: number, mainThread = false): ResolvedTier {
  const steps = Math.max(0, Math.min(MAX_DEGRADE_LEVEL, Math.floor(level)));
  let tier = user;
  let dprCap = TIER_DPR[user];
  for (let i = 0; i < steps; i++) {
    if (tier === 'full') {
      tier = 'lite';
      dprCap = TIER_DPR.lite;
    } else {
      dprCap = Math.max(1, dprCap - 0.5);
    }
  }
  return { tier, dprCap: mainThread ? Math.min(dprCap, MAIN_THREAD_DPR) : dprCap };
}

export const GOVERNOR = {
  /** Worker frame p95 above this for BAD_WINDOWS consecutive one-second windows → downgrade. */
  slowFrameMs: 20,
  badWindows: 3,
  /**
   * Frames not being delivered (raster-bound: the work time above can't see GPU/raster cost):
   * fps below this for collapseWindows windows. Ignored while the rate is capped on purpose.
   */
  collapseFps: 40,
  collapseWindows: 5,
  /** More than this many main-thread long tasks within longTaskWindowMs → downgrade. */
  longTasks: 2,
  longTaskWindowMs: 10_000,
  /** Ignore further triggers this long after a downgrade, so one hiccup costs one step. */
  cooldownMs: 5_000,
  /** Healthy this long → upgrade one step; doubles each time an upgrade is followed by a downgrade. */
  upgradeAfterMs: 60_000,
  maxUpgradeAfterMs: 480_000,
} as const;

/** Decides the degrade level from frame stats, long tasks and scheduler skips. */
export class TierGovernor {
  level = 0;
  private slowWindows = 0;
  private collapsedWindows = 0;
  private longTaskTimes: number[] = [];
  private lastChangeAt: number;
  private lastTriggerAt = Number.NEGATIVE_INFINITY;
  private upgradeAfterMs: number = GOVERNOR.upgradeAfterMs;
  private upgradedAt = Number.NEGATIVE_INFINITY;

  constructor(nowMs: number) {
    this.lastChangeAt = nowMs;
  }

  /** The user picked a tier: start again from it. */
  reset(nowMs: number): void {
    this.level = 0;
    this.slowWindows = 0;
    this.collapsedWindows = 0;
    this.longTaskTimes = [];
    this.lastChangeAt = nowMs;
    this.upgradeAfterMs = GOVERNOR.upgradeAfterMs;
  }

  /** One stats window (≈ 1 s). `capped` = the frame rate is deliberately limited (calm/main thread). Returns true if the level changed. */
  onStats(p95FrameMs: number, fps: number, capped: boolean, nowMs: number): boolean {
    this.slowWindows = p95FrameMs > GOVERNOR.slowFrameMs ? this.slowWindows + 1 : 0;
    this.collapsedWindows = !capped && fps < GOVERNOR.collapseFps ? this.collapsedWindows + 1 : 0;
    if (this.slowWindows >= GOVERNOR.badWindows || this.collapsedWindows >= GOVERNOR.collapseWindows) {
      this.slowWindows = 0;
      this.collapsedWindows = 0;
      return this.trigger(nowMs);
    }
    return this.maybeUpgrade(nowMs);
  }

  onLongTask(nowMs: number): boolean {
    this.longTaskTimes = this.longTaskTimes.filter((t) => nowMs - t < GOVERNOR.longTaskWindowMs);
    this.longTaskTimes.push(nowMs);
    if (this.longTaskTimes.length <= GOVERNOR.longTasks) return false;
    this.longTaskTimes = [];
    return this.trigger(nowMs);
  }

  onSchedulerSkip(nowMs: number): boolean {
    return this.trigger(nowMs);
  }

  private trigger(nowMs: number): boolean {
    this.lastTriggerAt = nowMs;
    if (nowMs - this.lastChangeAt < GOVERNOR.cooldownMs || this.level >= MAX_DEGRADE_LEVEL) return false;
    // A downgrade soon after an upgrade means the upgrade was premature: wait longer next time.
    if (nowMs - this.upgradedAt < this.upgradeAfterMs) {
      this.upgradeAfterMs = Math.min(GOVERNOR.maxUpgradeAfterMs, this.upgradeAfterMs * 2);
    }
    this.level++;
    this.lastChangeAt = nowMs;
    return true;
  }

  private maybeUpgrade(nowMs: number): boolean {
    if (this.level === 0) return false;
    const healthySince = Math.max(this.lastChangeAt, this.lastTriggerAt);
    if (nowMs - healthySince < this.upgradeAfterMs) return false;
    this.level--;
    this.lastChangeAt = nowMs;
    this.upgradedAt = nowMs;
    return true;
  }
}
