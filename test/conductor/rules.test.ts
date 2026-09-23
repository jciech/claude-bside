import { describe, expect, it } from 'vitest';
import type { SectionFingerprint } from '../../src/shared/analysis.ts';
import type { SectionRole } from '../../src/shared/music.ts';
import { EMPTY_MIXER, type MixerState } from '../../src/shared/program.ts';
import {
  dramaturgyIssues,
  musicalIssues,
  noveltyIssues,
  planIssues,
  relax,
  resolvedIssues,
  tempoIssues,
  type DramaturgyEntry,
  type PlanRuleContext,
} from '../../src/server/conductor/accept.ts';
import {
  bendBaseline,
  budgetSeconds,
  budgetState,
  expectedSections,
  nextRole,
  peakThreshold,
  roleTargets,
  type Arc,
  type BudgetSpan,
} from '../../src/server/conductor/arc.ts';
import { resolveSection } from '../../src/server/conductor/compile.ts';
import { macrosAt, mixerTick, needlePoint, withSafety } from '../../src/server/conductor/mixer.ts';
import { createFakeChecker, movement, part, plan, section } from './harness.ts';

const ctx = (over: Partial<PlanRuleContext> = {}): PlanRuleContext => ({
  hasRequest: (id) => id.startsWith('rq'),
  requiredRequestIds: [],
  requestsRelaxed: false,
  forkAllowed: true,
  catalogIds: new Set(['sbd', 'triangle', 'vibraphone']),
  ...over,
});
const rules = (issues: { rule: string; severity: string }[]) => issues.map((i) => `${i.severity}:${i.rule}`);

describe('plan shape rules', () => {
  it('accepts a clean plan', () => {
    expect(planIssues(plan([section()]), ctx())).toEqual([]);
  });

  it('checks bars against enter/exit and automation, and overlapping lanes', () => {
    const s = section({
      parts: [
        part('pad', {
          enterBar: 16,
          automation: [
            { target: 'level', fromBar: 0, toBar: 8, from: 0, to: 1, curve: 'linear' },
            { target: 'level', fromBar: 4, toBar: 12, from: 1, to: 0.5, curve: 'linear' },
          ],
        }),
        part('kick', { exitBar: 20 }),
      ],
    });
    const out = planIssues(plan([s]), ctx());
    expect(out.map((i) => i.path)).toEqual(['sections[0].parts[0].enterBar', 'sections[0].parts[0].automation[1]', 'sections[0].parts[1].exitBar']);
  });

  it('checks knob ranges, tempo ramps, crossfades, breaths and duck targets', () => {
    const s = section({
      bars: 8,
      role: 'transition',
      tempoRampBars: 12,
      transitionIn: { type: 'crossfade', bars: 8 },
      parts: [
        part('pad', { knobs: [{ name: 'cut', default: 5000, min: 200, max: 4000, follows: 'none' }], duck: { targets: ['pad', 'nope'], depth: 0.5, releaseSec: 0.1 } }),
      ],
    });
    expect(rules(planIssues(plan([s]), ctx()))).toEqual(['error:schema', 'error:schema', 'error:schema', 'error:tempo', 'error:schema']);
    const breath = section({ transitionIn: { type: 'breath', bars: 4 } });
    expect(planIssues(plan([breath]), ctx())[0]).toMatchObject({ rule: 'schema', path: 'sections[0].transitionIn.bars' });
  });

  it('a continuing part must enter at bar 0', () => {
    expect(planIssues(plan([section({ parts: [part('pad', { code: null, enterBar: 4 })] })]), ctx())[0]).toMatchObject({ rule: 'carry' });
    expect(planIssues(plan([section({ parts: [part('pad', { code: null, restart: true, enterBar: 4 })] })]), ctx())).toEqual([]);
  });

  it('rejects links and markup in public text', () => {
    const out = planIssues(plan([section({ name: 'see www.evil.com', publicNote: '<b>hi</b>' })], { announcement: '[x](y)' }), ctx());
    expect(out.map((i) => i.path)).toEqual(['sections[0].name', 'sections[0].publicNote', 'announcement']);
  });

  it('request decisions: known ids, this-plan needs a section, every shown request decided', () => {
    const p = plan([section()], {
      requestDecisions: [
        { requestId: 'rq1', decision: 'this-plan', sectionIndex: 1, mergedInto: null, publicReply: 'Soon.' },
        { requestId: 'zz', decision: 'declined', sectionIndex: null, mergedInto: null, publicReply: 'No.' },
      ],
    });
    const out = planIssues(p, ctx({ requiredRequestIds: ['rq1', 'rq2'] }));
    expect(out.map((i) => `${i.rule}@${i.path}`)).toEqual(['request@requestDecisions[0].sectionIndex', 'request@requestDecisions[1]', 'request@requestDecisions']);
    expect(out[2]!.message).toMatch(/rq2/);
    // Relaxed (scripted): unknown ids are warnings and nothing is required.
    expect(rules(planIssues(p, ctx({ requestsRelaxed: true })))).toEqual(['error:request', 'warning:request']);
  });

  it('forks: dropped with a warning when not allowed; default must be an option', () => {
    const fork = { prompt: 'Where next?', options: [{ id: 'A' as const, label: 'Up', description: 'u', kind: 'continue' as const, requestId: null }, { id: 'B' as const, label: 'Down', description: 'd', kind: 'contrast' as const, requestId: null }], defaultOption: 'C' as const };
    expect(rules(planIssues(plan([section()], { fork }), ctx({ forkAllowed: false })))).toEqual(['warning:fork']);
    expect(rules(planIssues(plan([section()], { fork }), ctx()))).toEqual(['error:fork']);
  });

  it('movement: startsAtSection inside the plan; palette ids known', () => {
    const p = plan([section()], { movement: movement({ startsAtSection: 1, palette: ['sbd', 'nosuch'], signature: ['triangle'] }) });
    expect(rules(planIssues(p, ctx()))).toEqual(['error:schema', 'warning:palette', 'warning:palette']);
  });

  it('after carry resolution: automation targets declared knobs within range; pre-roll fits the section before', () => {
    const s = section({
      transitionIn: { type: 'riser', bars: 16 },
      parts: [part('pad', { automation: [{ target: 'knob:cut', fromBar: 0, toBar: 4, from: 1, to: 2, curve: 'linear' }] })],
    });
    const { parts } = resolveSection(s, null, 's');
    expect(rules(resolvedIssues(s, parts, 'sections[0]', 8))).toEqual(['error:knob-undeclared', 'error:schema']);
  });
});

describe('musical rules', () => {
  it('bass register: warning above C4, error far above', async () => {
    const checker = createFakeChecker();
    const s = section({ parts: [part('bass', { role: 'bass', code: 's("sawtooth") midi66' }), part('b2', { role: 'bass', code: 's("sawtooth") midi76' })] });
    const check = await checker.checkSection({ parts: s.parts.map((p) => ({ ...p, code: p.code!, patternBarAtStart: 0 })), bpm: 120, scale: null, bars: 16 });
    expect(rules(musicalIssues(s, check, 'sections[0]'))).toEqual(['warning:register', 'error:register']);
  });

  it('measured spans far from targets are warnings', async () => {
    const checker = createFakeChecker();
    const s = section({ targets: { ...section().targets, intensity: { start: 0.1, end: 0.9 } } });
    const check = await checker.checkSection({ parts: s.parts.map((p) => ({ ...p, code: p.code!, patternBarAtStart: 0 })), bpm: 120, scale: null, bars: 16 });
    expect(rules(musicalIssues(s, check, 'sections[0]'))).toEqual(['warning:targets']);
  });
});

describe('tempo rules (all authors)', () => {
  const t = (over: Partial<Parameters<typeof tempoIssues>[0]['sections'][number]> = {}) => ({ plan: section(), movementBpm: 120, fromBpm: 120, opensMovement: false, prevBeatless: false, ...over });
  it('±4 BPM around the movement', () => {
    expect(rules(tempoIssues({ sections: [t({ plan: section({ bpm: 125, tempoRampBars: 8 }) })], oldMovementBpm: null }))).toEqual(['error:tempo']);
  });
  it('ramps at least 4 bars per 4 BPM, except tiny switches, beatless sections and half/double time', () => {
    expect(rules(tempoIssues({ sections: [t({ plan: section({ bpm: 124 }), movementBpm: 124 })], oldMovementBpm: null }))).toEqual(['error:tempo']);
    expect(tempoIssues({ sections: [t({ plan: section({ bpm: 124, tempoRampBars: 4 }), movementBpm: 124 })], oldMovementBpm: null })).toEqual([]);
    expect(tempoIssues({ sections: [t({ plan: section({ bpm: 122 }), movementBpm: 122 })], oldMovementBpm: null })).toEqual([]);
    expect(tempoIssues({ sections: [t({ plan: section({ bpm: 140, parts: [part('pad')] }), movementBpm: 140 })], oldMovementBpm: null })).toEqual([]);
    expect(tempoIssues({ sections: [t({ plan: section({ bpm: 60 }), movementBpm: 60 })], oldMovementBpm: null })).toEqual([]);
  });
  it('a new movement moves at most 12 BPM unless through a beatless bridge or half/double time', () => {
    const open = (bpm: number, prevBeatless = false, parts = section().parts) =>
      tempoIssues({ sections: [t({ plan: section({ bpm, tempoRampBars: 16, parts }), movementBpm: bpm, fromBpm: 120, opensMovement: true, prevBeatless })], oldMovementBpm: 120 });
    expect(open(130)).toEqual([]);
    expect(rules(open(135))).toEqual(['error:tempo']);
    expect(open(135, true)).toEqual([]);
    expect(open(135, false, [part('pad')])).toEqual([]);
    expect(open(60)).toEqual([]);
  });
});

describe('novelty rules', () => {
  const fp = (shares: Record<string, number>, over: Partial<SectionFingerprint> = {}): SectionFingerprint => ({
    descriptors: { intensity: 0.5, brightness: 0.5, density: 0.5, tension: 0.3 },
    soundShares: shares,
    kickGrid16: new Array(16).fill(0),
    backbeatGrid16: new Array(16).fill(0),
    scale: 'D:dorian',
    bpm: 120,
    chordHash: null,
    ...over,
  });
  const base = {
    similar: () => null,
    crossReprisesRecent: 0,
    movementFingerprints: () => [],
    movementSounds: () => new Set<string>(),
    cooldown: new Set<string>(),
    signature: () => [],
    crate: null,
  };

  it('similarity to an earlier movement is an error unless declared as a reprise (once per 30 min)', () => {
    const similar = () => ({ sectionId: 'old-1', distance: 0.1 });
    const s = { plan: section(), fingerprint: fp({ sbd: 1 }), movementId: 'm2', opensMovement: false };
    expect(rules(noveltyIssues({ ...base, similar, sections: [s] }))).toEqual(['error:similarity']);
    const reprise = { ...s, plan: section({ reprise: 'old-1' }) };
    expect(noveltyIssues({ ...base, similar, sections: [reprise] })).toEqual([]);
    expect(rules(noveltyIssues({ ...base, similar, crossReprisesRecent: 1, sections: [reprise] }))).toEqual(['error:similarity']);
  });

  it('cooldown blocks introducing a resting sound, but not one the movement already uses or its signature', () => {
    const s = { plan: section(), fingerprint: fp({ sbd: 0.5, vibraphone: 0.5 }), movementId: 'm2', opensMovement: false };
    const cooldown = new Set(['sbd', 'vibraphone']);
    expect(noveltyIssues({ ...base, cooldown, sections: [s] })[0]!.message).toMatch(/sbd, vibraphone/);
    expect(noveltyIssues({ ...base, cooldown, movementSounds: () => new Set(['sbd']), signature: () => ['vibraphone'], sections: [s] })).toEqual([]);
  });

  it('a new movement uses at least two crate sounds across its sections', () => {
    const s0 = { plan: section(), fingerprint: fp({ sbd: 0.5, wind: 0.5 }), movementId: 'new', opensMovement: true };
    const s1 = { plan: section(), fingerprint: fp({ casio: 1 }), movementId: 'new', opensMovement: false };
    expect(rules(noveltyIssues({ ...base, crate: ['wind', 'casio', 'pink'], sections: [s0] }))).toEqual(['error:crate']);
    expect(noveltyIssues({ ...base, crate: ['wind', 'casio', 'pink'], sections: [s0, s1] })).toEqual([]);
  });

  it('stasis: a warning on the third near-identical section running within the movement', () => {
    const same = fp({ sbd: 1 });
    const s = { plan: section(), fingerprint: same, movementId: 'm', opensMovement: false };
    expect(noveltyIssues({ ...base, movementFingerprints: () => [same, same], sections: [s] })).toEqual([]);
    expect(rules(noveltyIssues({ ...base, movementFingerprints: () => [same, same, same], sections: [s] }))).toEqual(['warning:stasis']);
  });

  it('relaxation turns errors into warnings for the autopilot', () => {
    const out = relax([{ severity: 'error', rule: 'cooldown', message: 'x' }]);
    expect(out[0]).toMatchObject({ severity: 'warning', rule: 'cooldown' });
  });
});

describe('dramaturgy rules', () => {
  const span = (startMs: number, bars: number, intensity: [number, number], peakAt = 0.8): BudgetSpan => ({ startMs, endMs: startMs + bars * 2000, bars, intensity: { start: intensity[0], end: intensity[1] }, peakAt, floorExempt: false });
  const entry = (role: SectionRole, startMs: number, bars: number, intensity: [number, number], tension: [number, number] = [0.3, 0.3]): DramaturgyEntry => ({
    role,
    span: span(startMs, bars, intensity),
    tension: { start: tension[0], end: tension[1] },
  });
  const next = (role: SectionRole, startMs: number, bars: number, intensity: [number, number], over: { measured?: { intensity: [number, number]; tension: [number, number] }; tension?: [number, number] } = {}) => {
    const e = entry(role, startMs, bars, intensity, over.tension);
    const m = over.measured ?? { intensity, tension: over.tension ?? [0.3, 0.3] };
    return { ...e, plan: section({ role, bars: bars as 16 }), measured: { intensity: { start: m.intensity[0], end: m.intensity[1] }, tension: { start: m.tension[0], end: m.tension[1] } } };
  };
  const bounds = { min: 16, max: 64 };

  it('same role at most twice (groove three times), and 16 bars minimum except transitions', () => {
    const before = [entry('drop', 0, 16, [0.5, 0.5]), entry('drop', 32_000, 16, [0.5, 0.5])];
    expect(rules(dramaturgyIssues({ before, sections: [next('drop', 64_000, 16, [0.5, 0.5])], movementAgeMin: null, opensMovement: false, planBars: bounds }))).toEqual(['error:dramaturgy']);
    const grooves = [entry('groove', 0, 16, [0.5, 0.5]), entry('groove', 32_000, 16, [0.5, 0.5])];
    expect(dramaturgyIssues({ before: grooves, sections: [next('groove', 64_000, 16, [0.5, 0.5])], movementAgeMin: null, opensMovement: false, planBars: bounds })).toEqual([]);
    const short = next('groove', 0, 8, [0.5, 0.5]);
    expect(dramaturgyIssues({ before: [], sections: [short], movementAgeMin: null, opensMovement: false, planBars: { min: 8, max: 64 } })[0]!.message).toMatch(/at least 16 bars/);
  });

  it('peak budget: at most 180 s at peak intensity within 10 minutes', () => {
    // 64 bars at peak = 128 s already; another 32-bar peak (64 s) → 192 s.
    const before = [entry('drop', 0, 64, [0.9, 0.9]), entry('breakdown', 128_000, 16, [0.3, 0.3])];
    const out = dramaturgyIssues({ before, sections: [next('drop', 160_000, 32, [0.9, 0.9])], movementAgeMin: null, opensMovement: false, planBars: bounds });
    expect(out.find((i) => i.message.startsWith('Peak budget'))).toBeTruthy();
    const calm = dramaturgyIssues({ before, sections: [next('groove', 160_000, 32, [0.6, 0.6])], movementAgeMin: null, opensMovement: false, planBars: bounds });
    expect(calm).toEqual([]);
  });

  it('three peaks in a row are refused', () => {
    const before = [entry('drop', 0, 16, [0.85, 0.85]), entry('groove', 32_000, 16, [0.82, 0.82])];
    const out = dramaturgyIssues({ before, sections: [next('reprise', 64_000, 16, [0.81, 0.81])], movementAgeMin: null, opensMovement: false, planBars: bounds });
    expect(out.map((i) => i.message)).toContainEqual(expect.stringMatching(/Three peak sections/));
  });

  it('a build must measure rising, and what follows starts with less tension', () => {
    const flat = next('build', 0, 16, [0.4, 0.8], { measured: { intensity: [0.5, 0.55], tension: [0.3, 0.35] } });
    expect(dramaturgyIssues({ before: [], sections: [flat], movementAgeMin: null, opensMovement: false, planBars: bounds })[0]!.message).toMatch(/build must measure/);
    const rising = next('build', 0, 16, [0.4, 0.8], { measured: { intensity: [0.3, 0.7], tension: [0.3, 0.8] }, tension: [0.3, 0.8] });
    const release = next('drop', 32_000, 16, [0.8, 0.8], { tension: [0.75, 0.5] });
    expect(dramaturgyIssues({ before: [], sections: [rising, release], movementAgeMin: null, opensMovement: false, planBars: { min: 16, max: 64 } })[0]!.message).toMatch(/After a build/);
    const relaxed = next('drop', 32_000, 16, [0.8, 0.8], { tension: [0.5, 0.5] });
    expect(dramaturgyIssues({ before: [], sections: [rising, relaxed], movementAgeMin: null, opensMovement: false, planBars: bounds })).toEqual([]);
  });

  it('movements run 6–20 minutes; plan length out of bounds is a warning', () => {
    const intro = [next('intro', 0, 16, [0.3, 0.3])];
    expect(rules(dramaturgyIssues({ before: [], sections: intro, movementAgeMin: 3, opensMovement: true, planBars: { min: 30, max: 50 } }))).toEqual(['error:dramaturgy', 'warning:plan-length']);
    expect(dramaturgyIssues({ before: [], sections: intro, movementAgeMin: 8, opensMovement: true, planBars: bounds })).toEqual([]);
    expect(dramaturgyIssues({ before: [], sections: [next('groove', 0, 16, [0.5, 0.5])], movementAgeMin: 21, opensMovement: false, planBars: bounds })[0]!.message).toMatch(/open a new one/);
  });
});

describe('arc', () => {
  const arc: Arc = { baseline: { intensity: 0.5, brightness: 0.5 }, amplitude: 0.25, arcShape: 'plateau', groove: 'four-on-floor' };
  it('role targets follow the offsets (b + A·offset)', () => {
    expect(roleTargets('drop', arc, 0).intensity).toEqual({ start: 0.8, end: 0.8 });
    expect(roleTargets('breakdown', arc, 0).intensity).toEqual({ start: 0.1, end: 0.1 });
    expect(roleTargets('build', arc, 0).intensity).toEqual({ start: 0.4, end: 0.7 });
  });
  it('bends the baseline toward the room by at most 0.15, clamped unless ambient', () => {
    expect(bendBaseline({ intensity: 0.5, brightness: 0.5 }, { x: 1, y: 1 }, 1, 'four-on-floor')).toEqual({ intensity: 0.65, brightness: 0.65 });
    expect(bendBaseline({ intensity: 0.68, brightness: 0.5 }, { x: 0, y: 1 }, 1, 'four-on-floor').intensity).toBe(0.7);
    expect(bendBaseline({ intensity: 0.3, brightness: 0.5 }, { x: 0, y: -1 }, 1, 'four-on-floor').intensity).toBe(0.15);
    expect(bendBaseline({ intensity: 0.5, brightness: 0.5 }, { x: 0, y: 0 }, 0, 'four-on-floor')).toEqual({ intensity: 0.5, brightness: 0.5 });
  });
  it('peaks are relative to the baseline', () => {
    expect(peakThreshold({ intensity: 0.5, brightness: 0.5 })).toBe(0.8);
    expect(peakThreshold({ intensity: 0.7, brightness: 0.5 })).toBeCloseTo(0.95);
  });
  it('budget seconds count bars at peak / floor within the window', () => {
    const s: BudgetSpan = { startMs: 0, endMs: 32_000, bars: 16, intensity: { start: 0.7, end: 0.9 }, peakAt: 0.8, floorExempt: false };
    expect(budgetSeconds([s], 0, 32_000).peak).toBe(16); // the upper half of the ramp
    expect(budgetState([s], 32_000, 32_000)).toMatchObject({ peakSecLast10Min: 16, peakSecAllowedNow: 164 });
  });
  it('expected targets already respect the budgets (no peak after two peaks)', () => {
    const e = expectedSections({
      arc,
      progress: 0.3,
      progressPerBar: 1 / 400,
      ageMin: 5,
      startCycle: 100,
      count: 2,
      newMovement: null,
      lastRoles: ['groove', 'build'],
      formSteps: [],
      budget: { peakSecAllowedNow: 180, floorSecAllowedNow: 240 },
      peakRun: 2,
      secondsPerBar: 2,
    });
    expect(e[0]!.role).toBe('drop');
    expect(Math.max(e[0]!.targets.intensity.start, e[0]!.targets.intensity.end)).toBeLessThan(0.8);
    expect(e[1]!.startCycle).toBe(132);
  });
  it('suggests closing an old movement', () => {
    expect(nextRole({ lastRoles: ['groove'], progress: 0.5, ageMin: 13, formStep: null, ambient: false })).toBe('outro');
    expect(nextRole({ lastRoles: [], progress: 0, ageMin: 0, formStep: null, ambient: false })).toBe('intro');
    expect(nextRole({ lastRoles: ['groove'], progress: 0.2, ageMin: 2, formStep: { role: 'bridge', bars: 16, note: '' }, ambient: false })).toBe('bridge');
  });
});

describe('mixer', () => {
  const pull = (x: number, y: number, listeners = 2) => ({ point: { x, y }, listeners });
  it('emits a keyframe at the earliest allowed cycle, ramping 1 bar for small rooms and 2 for larger', () => {
    const m = mixerTick({ state: EMPTY_MIXER, nowCycle: 10, earliestCycle: 13, pull: pull(0.5, -0.2), trims: {} })!;
    expect(m).toMatchObject({ rev: 1, prev: EMPTY_MIXER.next, next: { atCycle: 13, rampBars: 1, macros: { brightness: 0.5, intensity: -0.2 } } });
    expect(mixerTick({ state: EMPTY_MIXER, nowCycle: 10, earliestCycle: 13, pull: pull(0.5, 0, 12), trims: {} })!.next.rampBars).toBe(2);
  });
  it('waits for the previous ramp to finish, ignores tiny moves, settles back to neutral', () => {
    const m = mixerTick({ state: EMPTY_MIXER, nowCycle: 10, earliestCycle: 13, pull: pull(0.5, 0), trims: {} })!;
    expect(mixerTick({ state: m, nowCycle: 13.5, earliestCycle: 16, pull: pull(-1, 0), trims: {} })).toBeNull();
    expect(mixerTick({ state: m, nowCycle: 14, earliestCycle: 17, pull: pull(0.51, 0), trims: {} })).toBeNull();
    expect(mixerTick({ state: m, nowCycle: 14, earliestCycle: 17, pull: pull(0, 0, 0), trims: {} })!.next.macros).toEqual({ brightness: 0, intensity: 0 });
  });
  it('the new keyframe starts from exactly what was playing (continuity for every client)', () => {
    const m1 = mixerTick({ state: EMPTY_MIXER, nowCycle: 10, earliestCycle: 13, pull: pull(0.6, 0.2), trims: {} })!;
    const m2 = mixerTick({ state: m1, nowCycle: 20, earliestCycle: 23, pull: pull(-0.4, 0), trims: { kick: -2 } })!;
    for (const c of [20, 22, 23]) expect(macrosAt(m2, c)).toEqual(macrosAt(m1, c));
    expect(macrosAt(m2, 23.5).brightness).toBeCloseTo(0.1);
    expect(m2.next.trimsDb).toEqual({ kick: -2 });
  });
  it('safety trim: −3 dB for 16 bars, extended not restarted', () => {
    const s = withSafety(EMPTY_MIXER, 40);
    expect(s.safety).toEqual({ masterDb: -3, highShelfDb: -3, fromCycle: 40, untilCycle: 56 });
    expect(withSafety(s, 50).safety).toEqual({ masterDb: -3, highShelfDb: -3, fromCycle: 40, untilCycle: 66 });
    const expired = mixerTick({ state: s, nowCycle: 60, earliestCycle: 63, pull: pull(0, 0), trims: {} })!;
    expect(expired.safety).toBeNull();
  });
  it('the needle follows the target at this bar, shifted by the measured offset and the fast lane', () => {
    const flat = { start: 0.5, end: 0.5 };
    const sec = {
      startCycle: 0,
      bars: 16,
      jumps: [],
      vamp: { allowed: true, loopBars: 8 as const },
      targets: { intensity: { start: 0.2, end: 0.8 }, brightness: flat, density: flat, tension: flat },
      measured: { intensity: { start: 0.3, end: 0.9 }, brightness: flat, density: flat, tension: flat },
    } as never;
    expect(needlePoint(sec, 8, EMPTY_MIXER)).toEqual({ x: 0, y: 0.2 }); // 0.5 target + 0.1 offset → 0.6 → pad 0.2
    const pushed: MixerState = { ...EMPTY_MIXER, next: { ...EMPTY_MIXER.next, macros: { brightness: 1, intensity: 0 } } };
    expect(needlePoint(sec, 8, pushed).x).toBe(0.3);
  });
});
