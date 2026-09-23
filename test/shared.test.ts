import { describe, expect, it } from 'vitest';
import {
  createTimeline,
  cycleAtMs,
  msAtCycle,
  pruneTimeline,
  withTempoAt,
  withTempoRamp,
  cpsAtCycle,
} from '../src/shared/timeline.ts';
import { bpmToCps, cpsToBpm } from '../src/shared/music.ts';
import { sanitizeModelValue, findLimitViolations } from '../src/shared/limits.ts';
import { PlanSchema, planToolSchema } from '../src/shared/plan.ts';

describe('music conventions', () => {
  it('uses 1 cycle = 1 bar of 4/4', () => {
    expect(bpmToCps(120)).toBe(0.5);
    expect(cpsToBpm(0.5)).toBe(120);
  });
});

describe('timeline', () => {
  const t0 = 10_000;
  const tl = createTimeline(t0, bpmToCps(120));

  it('maps server time to cycles and back', () => {
    expect(cycleAtMs(tl, t0)).toBe(0);
    expect(cycleAtMs(tl, t0 + 2000)).toBe(1);
    expect(msAtCycle(tl, 3)).toBe(t0 + 6000);
  });

  it('keeps phase continuous across a tempo change', () => {
    const next = withTempoAt(tl, 4, bpmToCps(90));
    const at4 = msAtCycle(next, 4);
    expect(at4).toBe(t0 + 8000);
    expect(cycleAtMs(next, at4)).toBeCloseTo(4, 10);
    // after the change a bar lasts 60/90*4 s
    expect(msAtCycle(next, 5) - at4).toBeCloseTo((60 / 90) * 4 * 1000, 6);
    // before the change nothing moved
    expect(cycleAtMs(next, t0 + 3000)).toBe(1.5);
  });

  it('replaces later segments when rescheduling', () => {
    const a = withTempoAt(tl, 8, bpmToCps(100));
    const b = withTempoAt(a, 4, bpmToCps(140));
    expect(b.segments.map((s) => s.startCycle)).toEqual([0, 4]);
  });

  it('ramps once per bar and lands on the target tempo at fromCycle + bars', () => {
    const r = withTempoRamp(tl, 8, 4, bpmToCps(128));
    expect(cpsAtCycle(r, 8.5)).toBe(bpmToCps(120));
    expect(cpsAtCycle(r, 12)).toBeCloseTo(bpmToCps(128), 10);
    const bpms = r.segments.map((s) => Math.round(cpsToBpm(s.cps)));
    expect(bpms).toEqual([120, 122, 124, 126, 128]);
  });

  it('prunes segments that are over', () => {
    const r = withTempoRamp(tl, 2, 2, bpmToCps(130));
    const pruned = pruneTimeline(r, msAtCycle(r, 3.5));
    expect(pruned.segments[0]!.startCycle).toBe(3);
  });
});

describe('limits', () => {
  it('clamps loud and dangerous values and strips engine-owned and structured keys', () => {
    const v = sanitizeModelValue({
      s: 'bd',
      gain: 50,
      roomsize: 100,
      orbit: 7,
      cps: 3,
      cutoff: 800,
      fmi13: 500,
      distortvol: 20,
      FX: [{ gain: 5 }],
      lfo: { 0: { control: 'postgain' } },
      source: () => 0,
    });
    expect(v).toEqual({ s: 'bd', gain: 1, roomsize: 6, cutoff: 800, fmi13: 12, distortvol: 1 });
  });
  it('reports violations with reasons', () => {
    const v = findLimitViolations({ gain: 2, pan: -0.5, orbit: 3, FX: [] });
    expect(v.map((x) => [x.key, x.reason])).toEqual([
      ['gain', 'range'],
      ['pan', 'range'],
      ['orbit', 'engine-owned'],
      ['FX', 'engine-owned'],
    ]);
  });
});

describe('plan schema', () => {
  const part = {
    id: 'kick',
    role: 'kick',
    code: 's("bd*4").bank("RolandTR909")',
    restart: false,
    chromatic: false,
    level: 0.8,
    enterBar: 0,
    exitBar: null,
    knobs: [],
    automation: [],
    duck: null,
  };
  const section = {
    name: 'First Light',
    role: 'intro',
    bars: 16,
    bpm: 120,
    tempoRampBars: 0,
    tempoRampAt: 'start',
    scale: 'D:dorian',
    chords: null,
    targets: {
      intensity: { start: 0.2, end: 0.4 },
      brightness: { start: 0.4, end: 0.5 },
      density: { start: 0.2, end: 0.3 },
      tension: { start: 0.2, end: 0.3 },
    },
    transitionIn: { type: 'cut', bars: 0 },
    parts: [part],
    reprise: null,
    publicNote: 'Just a kick to start.',
  };
  const plan = {
    sections: [section],
    movement: null,
    fork: null,
    requestDecisions: [],
    motifs: [],
    announcement: null,
    rationale: 'test',
  };

  it('accepts a well-formed plan', () => {
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });
  it('rejects out-of-range values and unknown keys', () => {
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...section, bars: 12 }] }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...section, parts: [{ ...part, level: 2 }] }] }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
    expect(PlanSchema.safeParse({ ...plan, sections: [{ ...section, parts: [{ ...part, id: 'Snare' }] }] }).success).toBe(false);
  });
  it('produces a closed JSON schema for Claude without unsupported keywords', () => {
    const json = JSON.stringify(planToolSchema());
    for (const k of ['minimum', 'maximum', 'maxLength', 'pattern', 'maxItems']) expect(json).not.toContain(`"${k}"`);
    expect(json).toContain('"additionalProperties":false');
  });
});

describe('strudel in node/vitest', () => {
  it('imports @strudel/core and queries mini-notation', async () => {
    const { mini } = await import('@strudel/mini');
    const haps = mini('bd [sd hh]').queryArc(0, 1);
    expect(haps.map((h: { value: unknown }) => h.value)).toEqual(['bd', 'sd', 'hh']);
  });
});
