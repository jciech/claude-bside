// The autopilot's arrangements as the real checker measures them: roles contrast (quiet sections
// really are quieter and thinner, builds rise, drops land), a role never comes back arranged the
// same way inside a movement, code variants and colour moves stay valid, and new sides rotate
// through the library by groove family with legal tempo moves.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createChecker } from '../../src/server/check/checker.ts';
import { arrangeSection, barsFor, type PrevView } from '../../src/server/composer/arrange.ts';
import { planCandidates, recognize, type AutopilotLibrary } from '../../src/server/composer/autopilot.ts';
import { LIBRARY, type Ensemble } from '../../src/server/composer/library/index.ts';
import { colourMoves, partVariants, variantCode } from '../../src/server/composer/variants.ts';
import { validateLibrary } from '../../src/server/composer/scripted.ts';
import { balanceTrims } from '../../src/server/conductor/compile.ts';
import { fingerprintDistance, type SectionCheck } from '../../src/shared/analysis.ts';
import { PERCUSSIVE_ROLES, type SectionRole } from '../../src/shared/music.ts';
import type { SectionPlan } from '../../src/shared/plan.ts';
import type { Checker } from '../../src/server/types.ts';
import { fullCatalog, memoryLog, movementOf, summarize, turnContext } from './fixtures.ts';

const ens = (id: string) => LIBRARY.find((e) => e.id === id)!;

describe('code variants and colour moves', () => {
  it('shift registers, thin and slow only where they apply', () => {
    const bells = ens('glass-drift').parts.find((p) => p.id === 'bells')!;
    expect(variantCode(bells, 'up')).toContain('scale("$SCALE5")');
    expect(variantCode(bells, 'down')).toContain('scale("$SCALE3")');
    expect(variantCode(bells, 'thin')).toMatch(/\.degradeBy\(0\.5\)$/);
    expect(variantCode(bells, 'half')).toMatch(/\.slow\(2\)$/);
    const sub = ens('glass-drift').parts.find((p) => p.id === 'sub')!;
    expect(partVariants(sub).map((v) => v.variant)).toEqual(['base']);
    const pad = ens('glass-drift').parts.find((p) => p.id === 'pad')!;
    expect(partVariants(pad).map((v) => v.variant).sort()).toEqual(['base', 'half', 'up']);
    const kick = ens('deep-house').parts.find((p) => p.id === 'kick')!;
    expect(partVariants(kick).map((v) => v.variant)).toEqual(['base']);
  });

  it('moves to the relative mode on the same notes first, then to another mode on the same tonic', () => {
    expect(colourMoves({ modes: ['minor', 'aeolian', 'dorian'] }, 'C:minor')).toEqual(['F:dorian', 'C:dorian']);
    expect(colourMoves({ modes: ['major', 'lydian', 'minor', 'dorian'] }, 'D:major')).toEqual(['G:lydian', 'B:minor', 'E:dorian', 'D:lydian', 'D:minor', 'D:dorian']);
    expect(colourMoves({ modes: ['pelog'] }, 'D:pelog')).toEqual([]);
    expect(colourMoves({ modes: ['dorian', 'mixolydian'] }, '<D:dorian G:mixolydian>')).toEqual([]);
  });
});

/** A section's parts as the checker sees them: carried parts take the code of the section before. */
function checkInput(section: SectionPlan, prev: PrevView | null) {
  return {
    parts: section.parts.map((p) => ({
      id: p.id,
      role: p.role,
      code: p.code ?? prev!.parts.find((x) => x.id === p.id)!.code,
      knobs: p.knobs,
      chromatic: p.chromatic,
      level: p.level,
      enterBar: p.enterBar,
      exitBar: p.exitBar,
      patternBarAtStart: 0,
    })),
    bpm: section.bpm,
    scale: section.scale,
    bars: section.bars,
  };
}

/** Pre-master RMS the way the mixer renders it: fader lanes, entries/exits and balance trims included. */
function rmsDb(section: SectionPlan, check: SectionCheck): number {
  const trims = balanceTrims(section.parts, section.parts.map((p) => check.parts.find((c) => c.id === p.id)));
  let power = 0;
  for (const p of section.parts) {
    const est = check.parts.find((c) => c.id === p.id)?.analysis?.loudness.estRmsDb;
    if (est === null || est === undefined) continue;
    let sum = 0;
    for (let bar = 0; bar < section.bars; bar++) {
      if (bar < p.enterBar || (p.exitBar !== null && bar >= p.exitBar)) continue;
      const lane = p.automation.filter((a) => a.target === 'level').find((a) => bar >= a.fromBar && bar < a.toBar);
      const held = p.automation.filter((a) => a.target === 'level' && a.toBar <= bar).sort((a, b) => b.toBar - a.toBar)[0];
      const t = lane ? (bar - lane.fromBar) / (lane.toBar - lane.fromBar) : 0;
      const level = lane ? (lane.curve === 'exp' ? Math.max(1e-3, lane.from) * (Math.max(1e-3, lane.to) / Math.max(1e-3, lane.from)) ** t : lane.from + (lane.to - lane.from) * t) : (held?.to ?? p.level);
      sum += level * level;
    }
    power += 10 ** ((est + (trims[p.id] ?? 0)) / 10) * (sum / section.bars);
  }
  return 10 * Math.log10(power);
}

interface Played {
  role: SectionRole;
  section: SectionPlan;
  check: SectionCheck;
  rms: number;
}

const ENSEMBLES = ['glass-drift', 'neo-classical', 'deep-house', 'night-drive', 'jazz-trio', 'gamelan', 'field-drift', 'chiptune'];

describe('arrangements against the real checker', () => {
  let checker: Checker;
  let lib: AutopilotLibrary;
  beforeAll(async () => {
    checker = createChecker({ catalog: fullCatalog, poolSize: 3 });
    lib = (await validateLibrary({ catalog: fullCatalog, checker, log: memoryLog(), library: ENSEMBLES.map(ens) })).lib;
  }, 60_000);
  afterAll(() => checker.close());

  const FORM: SectionRole[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove', 'interlude', 'groove', 'build', 'drop', 'bridge', 'groove'];

  /** One movement of an ensemble, section by section, as the autopilot arranges it. */
  async function movement(e: Ensemble, seed: number): Promise<Played[]> {
    const scale = `${e.tonic}:${e.modes[0]}`;
    const away = colourMoves(e, scale);
    const out: Played[] = [];
    let prev: PrevView | null = null;
    for (const [i, role] of FORM.entries()) {
      const occurrence = FORM.slice(0, i).filter((r) => r === role).length;
      const { section, view } = arrangeSection({
        ensemble: e,
        role,
        scale,
        away,
        bpm: e.bpm.default,
        rampBars: 0,
        bars: barsFor(role, e.bpm.default),
        prev,
        sameEnsemble: prev !== null,
        beatless: false,
        targets: null,
        name: 'Test',
        seed: seed + i,
        occurrence,
        variants: lib.variants?.get(e.id),
      });
      const check = await checker.checkSection(checkInput(section, prev));
      expect([...check.errors, ...check.parts.flatMap((p) => p.errors)], `${e.id} ${role}`).toEqual([]);
      out.push({ role, section, check, rms: rmsDb(section, check) });
      prev = view;
    }
    return out;
  }

  const played = new Map<string, Played[]>();
  beforeAll(async () => {
    await Promise.all(ENSEMBLES.map(async (id, i) => played.set(id, await movement(ens(id), 11 * i))));
  }, 120_000);

  const contrast = (a: Played, b: Played) => ({
    intensity: Math.round((a.check.mix!.descriptors.intensity - b.check.mix!.descriptors.intensity) * 100) / 100,
    db: Math.round((a.rms - b.rms) * 10) / 10,
  });

  it('quiet sections are clearly lower and thinner than the groove before them (≥ 0.12 intensity or ≥ 3 dB)', () => {
    for (const [id, sections] of played) {
      for (let i = 1; i < sections.length; i++) {
        const [a, b] = [sections[i - 1]!, sections[i]!];
        if (a.role !== 'groove' || (b.role !== 'breakdown' && b.role !== 'interlude')) continue;
        const c = contrast(a, b);
        expect(c.intensity >= 0.12 || c.db >= 3, `${id} ${a.role}→${b.role} ${JSON.stringify(c)}`).toBe(true);
      }
      const breakdown = sections.find((s) => s.role === 'breakdown')!;
      expect(breakdown.section.parts.some((p) => PERCUSSIVE_ROLES.has(p.role)), `${id} breakdown drums`).toBe(false);
    }
  });

  it('a drop lands clearly above the build before it, and every build measures a rise of at least 0.2', () => {
    for (const [id, sections] of played) {
      for (let i = 1; i < sections.length; i++) {
        const [a, b] = [sections[i - 1]!, sections[i]!];
        if (a.role !== 'build') continue;
        const { intensity, tension } = a.check.mix!.spans;
        expect(Math.max(intensity.end - intensity.start, tension.end - tension.start), `${id} build rise`).toBeGreaterThanOrEqual(0.2);
        const c = contrast(b, a);
        expect(c.intensity >= 0.12 || c.db >= 3, `${id} build→drop ${JSON.stringify(c)}`).toBe(true);
      }
    }
  });

  it('intros start sparse: quieter or thinner than the groove that follows', () => {
    for (const [id, sections] of played) {
      const c = contrast(sections[1]!, sections[0]!);
      expect(c.intensity >= 0.05 || c.db >= 3, `${id} intro→groove ${JSON.stringify(c)}`).toBe(true);
    }
  });

  it('never arranges a role the same way twice in a movement', () => {
    const distances: number[] = [];
    for (const [id, sections] of played) {
      const byRole = new Map<SectionRole, Played[]>();
      for (const s of sections) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);
      for (const [role, list] of byRole) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const [a, b] = [list[i]!, list[j]!];
            const signature = (s: Played) => JSON.stringify([s.section.scale, s.check.parts.map((p) => [p.id, p.digest?.instrument]), s.section.parts.map((p) => [p.id, p.level, p.enterBar, p.exitBar, p.knobs.map((k) => k.default)]), s.section.parts.map((p) => p.code)]);
            expect(signature(a), `${id} ${role} #${i}/#${j} arranged identically`).not.toBe(signature(b));
            // Measurably different too: the conductor's fingerprints never coincide.
            const d = fingerprintDistance(a.check.fingerprint!, b.check.fingerprint!);
            expect(d, `${id} ${role} #${i}/#${j} fingerprint distance`).toBeGreaterThan(0.005);
            distances.push(d);
          }
        }
      }
      // The bridge is a change of colour: another key than the groove before it, when the ensemble has one.
      const bridge = sections.findIndex((s) => s.role === 'bridge');
      if (colourMoves(ens(id), sections[0]!.section.scale).length) expect(sections[bridge]!.section.scale, `${id} bridge key`).not.toBe(sections[bridge - 1]!.section.scale);
    }
    // On average further apart than the conductor's "barely differs" (stasis) threshold of 0.05.
    expect(distances.reduce((a, d) => a + d, 0) / distances.length).toBeGreaterThan(0.05);
  });

  it('keeps knob rests and lanes inside a range that ends on a third decimal (0.125–0.875)', () => {
    const base = ens('dub-techno');
    const e: Ensemble = { ...base, parts: base.parts.map((p) => (p.knobs ? { ...p, knobs: p.knobs.map((k) => ({ ...k, default: 0.875, min: 0.125, max: 0.875 })) } : p)) };
    let prev: PrevView | null = null;
    const roles: SectionRole[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove', 'interlude', 'bridge', 'outro'];
    for (const [i, role] of roles.entries()) {
      const { section, view } = arrangeSection({ ensemble: e, role, scale: 'C:minor', away: colourMoves(e, 'C:minor'), bpm: 118, rampBars: 0, bars: 16, prev, sameEnsemble: prev !== null, beatless: false, targets: null, name: 'x', seed: i, occurrence: 0 });
      for (const p of section.parts) {
        for (const k of p.knobs) expect(k.min <= k.default && k.default <= k.max, `${role} ${p.id} ${k.name} default ${k.default}`).toBe(true);
        for (const a of p.automation.filter((x) => x.target.startsWith('knob:'))) {
          const k = p.knobs.find((x) => `knob:${x.name}` === a.target)!;
          expect([a.from, a.to].every((v) => v >= k.min && v <= k.max), `${role} ${p.id} ${JSON.stringify(a)}`).toBe(true);
        }
      }
      // Knobs that end the section at the top of their range are where the rounding used to overshoot.
      prev = { ...view, parts: view.parts.map((p) => ({ ...p, knobValuesAtEnd: Object.fromEntries(Object.keys(p.knobValuesAtEnd).map((n) => [n, 0.875])) })) };
    }
  });

  it('the away key, variants and knob moves pass the real checker (validated once at boot)', () => {
    for (const [id, sections] of played) {
      const keys = new Set(sections.map((s) => s.section.scale));
      if (colourMoves(ens(id), sections[0]!.section.scale).length) expect(keys.size, `${id} keys`).toBeGreaterThanOrEqual(2);
      for (const s of sections) for (const p of s.check.parts) if (p.digest?.keyFit !== null && p.digest?.keyFit !== undefined) expect(p.digest.keyFit, `${id} ${s.role} ${p.id}`).toBe(1);
    }
  });
});

describe('new sides', () => {
  /** Plays side after side: each opens from the intro of the one before, as the conductor would ask at its end. */
  function tour(lib: AutopilotLibrary, sides: number): { ensemble: Ensemble; bpm: number; groove: string; plan: ReturnType<typeof planCandidates>[number]['plan'] }[] {
    const out: ReturnType<typeof tour> = [];
    let ctx = turnContext({ kind: 'movement', id: 'side-0' });
    for (let i = 0; i < sides; i++) {
      const [first] = planCandidates(lib, ctx, 'compose');
      const plan = first!.plan;
      out.push({ ensemble: first!.opens!, bpm: plan.movement!.bpm, groove: plan.movement!.groove, plan });
      const intro = plan.sections[plan.movement!.startsAtSection]!;
      const now = summarize({ ...intro, role: 'outro' }, `s${i}`, 100 * (i + 1));
      ctx = turnContext({ now, movement: { ...movementOf(plan.movement!.name, plan.movement!.bpm, plan.movement!.scale), groove: plan.movement!.groove, ageMin: 8 }, kind: 'movement', id: `side-${i + 1}` });
    }
    return out;
  }

  it('change ensemble and groove family, with legal tempo moves, and visit the library before repeating', () => {
    const sides = tour({ ensembles: LIBRARY, sounds: new Map() }, 12);
    const ids = sides.map((s) => s.ensemble.id);
    expect(new Set(ids).size, ids.join(' ')).toBe(ids.length);
    for (let i = 1; i < sides.length; i++) {
      const [a, b] = [sides[i - 1]!, sides[i]!];
      expect(b.groove, `${a.ensemble.id} → ${b.ensemble.id}`).not.toBe(a.groove);
      const jump = Math.abs(b.bpm - a.bpm);
      const intro = b.plan.sections[b.plan.movement!.startsAtSection]!;
      const beatless = !intro.parts.some((p) => PERCUSSIVE_ROLES.has(p.role));
      const multiple = [2, 0.5].some((r) => Math.abs(b.bpm / a.bpm - r) <= 0.03 * r);
      expect(jump <= 12 || beatless || multiple, `${a.ensemble.id} ${a.bpm} → ${b.ensemble.id} ${b.bpm}`).toBe(true);
      if (jump > 2 && jump <= 12 && !multiple) expect(intro.tempoRampBars).toBeGreaterThanOrEqual(Math.ceil(jump));
    }
  });

  it('rotate through the synth-only library too', () => {
    const synth = LIBRARY.filter((e) => ['glass-drift', 'pilot-light', 'synth-house', 'synth-techno', 'chiptune', 'fm-bells', 'night-drive'].includes(e.id));
    const sides = tour({ ensembles: synth, sounds: new Map() }, 6);
    const ids = sides.map((s) => s.ensemble.id);
    expect(new Set(ids).size, ids.join(' ')).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < sides.length; i++) expect(ids[i], ids.join(' ')).not.toBe(ids[i - 1]);
    for (let i = 1; i < sides.length; i++) expect(sides[i]!.groove, ids.join(' ')).not.toBe(sides[i - 1]!.groove);
  });

  it('open on the part a recipe brings in first when the ensemble lacks its opening layer', () => {
    // Synth techno has no colour layer; one intro recipe opens on colour and brings the rest in later.
    const e = ens('synth-techno');
    for (let rotation = 0; rotation < 3; rotation++) {
      const { section } = arrangeSection({ ensemble: e, role: 'intro', scale: 'F:minor', bpm: 130, rampBars: 0, bars: 24, prev: null, sameEnsemble: false, beatless: true, targets: null, name: 'x', seed: 1, occurrence: 0, rotation });
      const opening = section.parts.filter((p) => p.enterBar === 0).map((p) => p.id);
      expect(opening, `rotation ${rotation}`).toContain('drone');
      expect(opening, `rotation ${rotation}`).not.toContain('sub');
    }
  });

  it('are recognised as the autopilot\'s own, variants and away keys included', () => {
    const e = ens('fm-bells');
    const scale = 'F:lydian';
    const { section } = arrangeSection({ ensemble: e, role: 'bridge', scale, away: colourMoves(e, scale), bpm: 96, rampBars: 0, bars: 16, prev: null, sameEnsemble: false, beatless: false, targets: null, name: 'x', seed: 3, occurrence: 0 });
    expect(section.scale).not.toBe(scale);
    const summary = summarize(section, 'b-1', 8);
    expect(recognize(LIBRARY, summary)?.id).toBe('fm-bells');
  });
});
