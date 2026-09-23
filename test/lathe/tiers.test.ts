import { describe, expect, it } from 'vitest';
import { GOVERNOR, resolveTier, TierGovernor } from '../../src/client/render/tiers.ts';
import { DROP_INTERVAL_MS, FlashLimiter } from '../../src/client/render/flash.ts';

describe('resolveTier', () => {
  it('steps Full → Lite → Lite at DPR 1, never into Calm', () => {
    expect(resolveTier('full', 0)).toEqual({ tier: 'full', dprCap: 2 });
    expect(resolveTier('full', 1)).toEqual({ tier: 'lite', dprCap: 1.5 });
    expect(resolveTier('full', 2)).toEqual({ tier: 'lite', dprCap: 1 });
    expect(resolveTier('full', 9)).toEqual({ tier: 'lite', dprCap: 1 });
  });

  it('keeps the user\'s Calm choice and only lowers its resolution', () => {
    expect(resolveTier('calm', 0)).toEqual({ tier: 'calm', dprCap: 2 });
    expect(resolveTier('calm', 2)).toEqual({ tier: 'calm', dprCap: 1 });
    expect(resolveTier('lite', 1)).toEqual({ tier: 'lite', dprCap: 1 });
  });

  it('caps the main-thread fallback at DPR 1.5', () => {
    expect(resolveTier('full', 0, true)).toEqual({ tier: 'full', dprCap: 1.5 });
  });
});

describe('TierGovernor', () => {
  const t0 = 1_000_000;

  it('downgrades after 3 s of worker frame p95 over 20 ms, not before', () => {
    const g = new TierGovernor(t0 - 60_000);
    expect(g.onStats(25, 60, false, t0)).toBe(false);
    expect(g.onStats(25, 60, false, t0 + 1000)).toBe(false);
    expect(g.onStats(25, 60, false, t0 + 2000)).toBe(true);
    expect(g.level).toBe(1);
  });

  it('needs the slow windows to be consecutive', () => {
    const g = new TierGovernor(t0 - 60_000);
    g.onStats(25, 60, false, t0);
    g.onStats(25, 60, false, t0 + 1000);
    g.onStats(8, 60, false, t0 + 2000);
    expect(g.onStats(25, 60, false, t0 + 3000)).toBe(false);
    expect(g.level).toBe(0);
  });

  it('downgrades on any scheduler skip, once per cooldown', () => {
    const g = new TierGovernor(t0 - 60_000);
    expect(g.onSchedulerSkip(t0)).toBe(true);
    expect(g.onSchedulerSkip(t0 + 1000)).toBe(false);
    expect(g.level).toBe(1);
    expect(g.onSchedulerSkip(t0 + GOVERNOR.cooldownMs + 1)).toBe(true);
    expect(g.level).toBe(2);
    expect(g.onSchedulerSkip(t0 + 3 * GOVERNOR.cooldownMs)).toBe(false);
  });

  it('downgrades on more than 2 long tasks within 10 s', () => {
    const g = new TierGovernor(t0 - 60_000);
    expect(g.onLongTask(t0)).toBe(false);
    expect(g.onLongTask(t0 + 4000)).toBe(false);
    expect(g.onLongTask(t0 + 11_000)).toBe(false);
    expect(g.onLongTask(t0 + 12_000)).toBe(true);
  });

  it('treats a sustained frame-rate collapse as trouble unless the rate is capped on purpose', () => {
    const capped = new TierGovernor(t0 - 60_000);
    for (let i = 0; i < 10; i++) expect(capped.onStats(2, 20, true, t0 + i * 1000)).toBe(false);
    const g = new TierGovernor(t0 - 60_000);
    const changed = Array.from({ length: 5 }, (_, i) => g.onStats(2, 20, false, t0 + i * 1000));
    expect(changed).toEqual([false, false, false, false, true]);
  });

  it('upgrades after 60 s healthy, and waits longer after a premature upgrade', () => {
    const g = new TierGovernor(t0 - 60_000);
    g.onSchedulerSkip(t0);
    expect(g.onStats(5, 60, false, t0 + 59_000)).toBe(false);
    expect(g.onStats(5, 60, false, t0 + 60_000)).toBe(true);
    expect(g.level).toBe(0);
    // Trouble again 10 s after the upgrade: the next upgrade needs 120 s.
    expect(g.onSchedulerSkip(t0 + 70_000)).toBe(true);
    expect(g.onStats(5, 60, false, t0 + 70_000 + 61_000)).toBe(false);
    expect(g.onStats(5, 60, false, t0 + 70_000 + 120_000)).toBe(true);
  });

  it('starts over from the user\'s choice', () => {
    const g = new TierGovernor(t0 - 60_000);
    g.onSchedulerSkip(t0);
    g.reset(t0 + 1);
    expect(g.level).toBe(0);
  });
});

describe('FlashLimiter', () => {
  it('allows at most one drop gesture per 2 s', () => {
    const f = new FlashLimiter();
    expect(f.allowDrop(0)).toBe(true);
    expect(f.allowDrop(500)).toBe(false);
    expect(f.allowDrop(DROP_INTERVAL_MS - 1)).toBe(false);
    expect(f.allowDrop(DROP_INTERVAL_MS)).toBe(true);
  });
});
