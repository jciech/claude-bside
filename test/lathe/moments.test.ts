import { describe, expect, it } from 'vitest';
import { applyMoment, INITIAL_MOOD, lookAt, sectionMoments } from '../../src/client/render/moments.ts';

describe('sectionMoments', () => {
  it('maps section roles to gestures, always marking the section change first', () => {
    expect(sectionMoments('drop')).toEqual(['section', 'drop']);
    expect(sectionMoments('build')).toEqual(['section', 'build']);
    expect(sectionMoments('breakdown')).toEqual(['section', 'breakdown']);
    expect(sectionMoments('groove')).toEqual(['section']);
    expect(sectionMoments('outro')).toEqual(['section']);
  });
});

describe('lookAt', () => {
  it('is the resting look by default', () => {
    expect(lookAt(INITIAL_MOOD, 10)).toMatchObject({ spread: 0.2, ghostAlpha: 1, lookaheadBars: 1, inverted: false, shockwave: null, padWash: 0.045 });
  });

  it('widens the lens over a build (0.20 → 0.26 R) and extends the pre-echo to 2 bars', () => {
    const build = applyMoment(INITIAL_MOOD, 'build', 32, 8);
    expect(lookAt(build, 32).spread).toBeCloseTo(0.2);
    expect(lookAt(build, 36).spread).toBeCloseTo(0.23);
    expect(lookAt(build, 40).spread).toBeCloseTo(0.26);
    expect(lookAt(build, 36).lookaheadBars).toBe(2);
    expect(lookAt(build, 40).sheenBoost).toBeCloseTo(0.04);
  });

  it('narrows the lens, dims ghosts to 40 % and desaturates the sheen in a breakdown', () => {
    const bd = applyMoment(INITIAL_MOOD, 'breakdown', 56, 8);
    const settled = lookAt(bd, 58);
    expect(settled.spread).toBeCloseTo(0.16);
    expect(settled.ghostAlpha).toBeCloseTo(0.4);
    expect(settled.sheenSaturation).toBeCloseTo(0.3);
    expect(settled.padWash).toBe(0.08);
  });

  it('sends one shockwave over a beat and inverts the label for one bar after a drop', () => {
    const drop = applyMoment(applyMoment(INITIAL_MOOD, 'section', 40, 16), 'drop', 40, 16);
    expect(lookAt(drop, 39.99)).toMatchObject({ inverted: false, shockwave: null });
    expect(lookAt(drop, 40).shockwave).toBe(0);
    expect(lookAt(drop, 40.125).shockwave).toBeCloseTo(0.5);
    expect(lookAt(drop, 40.25).shockwave).toBeNull();
    expect(lookAt(drop, 40.9)).toMatchObject({ inverted: true, archiveBoost: 1.2 });
    expect(lookAt(drop, 41)).toMatchObject({ inverted: false, archiveBoost: 1 });
  });

  it('returns to rest at the next section', () => {
    const build = applyMoment(INITIAL_MOOD, 'build', 32, 8);
    const next = applyMoment(build, 'section', 40, 16);
    expect(lookAt(next, 41)).toMatchObject({ spread: 0.2, lookaheadBars: 1 });
  });

  it('marks silence until something sounds', () => {
    expect(applyMoment(INITIAL_MOOD, 'silence', 3, 0).silent).toBe(true);
  });
});
