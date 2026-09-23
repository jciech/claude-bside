// The autopilot's plans against the conductor's real acceptance (plan schema, plan shape, carried
// parts, tempo rules): each plan is committed as the autopilot into a real conductor whose schedule
// ends where the plan's turn context says it does. The checker is the conductor tests' deterministic
// double; the real checker's verdicts on the library's code are pinned by boot validation and
// test/composer/room.test.ts. Properties: a walk through the whole tour from every ensemble, in the
// full and the synth-only library, over many seeds, commits every plan as written; and after a
// handoff at any tempo, every candidate the autopilot offers is accepted.
import { describe, expect, it } from 'vitest';
import { planCandidates, type AutopilotLibrary, type PlanMode } from '../../src/server/composer/autopilot.ts';
import { LIBRARY, type Ensemble } from '../../src/server/composer/library/index.ts';
import { createConductor } from '../../src/server/conductor/conductor.ts';
import type { Broadcaster, Conductor, Store } from '../../src/server/types.ts';
import type { SectionSummary, TurnContext } from '../../src/shared/composer-api.ts';
import { BPM_MAX, BPM_MIN } from '../../src/shared/music.ts';
import type { MovementPlan, Plan, SectionPlan } from '../../src/shared/plan.ts';
import { catalog, config, createFakeChecker, createFakeClock, createFakeCrowd, createFakeScripted, createManualComposer, createMemoryLog } from '../conductor/harness.ts';
import { movementOf, summarize, turnContext } from './fixtures.ts';

const SYNTH_ONLY = ['glass-drift', 'pilot-light', 'synth-house', 'synth-techno', 'chiptune', 'fm-bells', 'night-drive'];
const FULL: AutopilotLibrary = { ensembles: LIBRARY, sounds: new Map() };
const LIBRARIES: [string, AutopilotLibrary][] = [
  ['full', FULL],
  ['synth-only', { ensembles: LIBRARY.filter((e) => SYNTH_ONLY.includes(e.id)), sounds: new Map() }],
];
const ens = (id: string) => LIBRARY.find((e) => e.id === id)!;

const nothingKept: Store = { readJson: () => undefined, writeJson() {}, append() {}, readJsonl: () => [], flush: async () => {} };
const nobodyListening: Broadcaster = { emit() {}, toListener() {} };

/**
 * A real conductor that booted with `boot`: driver external with nobody at the terminal, the clock
 * standing still, nothing persisted or broadcast (thousands of these run, so they stay cheap).
 */
async function conductorBootingWith(boot: Plan): Promise<Conductor> {
  const scripted = createFakeScripted();
  scripted.make = () => boot;
  const log = createMemoryLog();
  const nobody = createManualComposer('external');
  const conductor = createConductor({
    clock: createFakeClock(),
    crowd: createFakeCrowd(),
    checker: createFakeChecker(),
    store: nothingKept,
    log,
    config: { ...config, driver: 'external' },
    catalog,
    composers: { claude: nobody, external: nobody, scripted },
    broadcaster: nobodyListening,
    wallNow: () => 1_700_000_000_000,
    newEpoch: () => 'ep1',
  });
  await conductor.start();
  expect(log.lines.filter((l) => l.msg.includes('boot section rejected')).map((l) => JSON.stringify(l.data))).toEqual([]);
  return conductor;
}

/** Commits a plan as the autopilot, after the schedule's last section: null when accepted, else why not. */
async function commit(conductor: Conductor, plan: Plan): Promise<string | null> {
  const result = await conductor.commit({ plan, mode: 'horizon' }, 'scripted');
  return result.accepted ? null : result.errors.map((e) => `${e.path ?? ''} ${e.message}`).join('; ');
}

/** Every candidate for `ctx`, each committed to its own conductor booted with `boot`: what was rejected. */
async function rejected(lib: AutopilotLibrary, boot: Plan, ctx: TurnContext, what: string): Promise<string[]> {
  const out: string[] = [];
  for (const mode of ['compose', 'fallback'] as const) {
    for (const candidate of planCandidates(lib, ctx, mode)) {
      const conductor = await conductorBootingWith(boot);
      const error = await commit(conductor, candidate.plan);
      await conductor.stop();
      if (error) out.push(`${what} (${mode}): ${candidate.kind} ${candidate.opens?.id ?? ''} at ${candidate.plan.movement?.bpm ?? ''} → ${error}`);
    }
  }
  return out;
}

const atTempo = (plan: Plan, bpm: number): Plan => ({ ...plan, sections: plan.sections.map((s) => ({ ...s, bpm })), movement: { ...plan.movement!, bpm } });

/** A side of `start` at `bpm`, as the autopilot opens it. */
const sideOf = (start: Ensemble, bpm: number, id: string, lib: AutopilotLibrary = FULL) =>
  atTempo(planCandidates({ ...lib, ensembles: [start] }, turnContext({ kind: 'movement', id }), 'compose')[0]!.plan, bpm);

/** The conductor asking for a new side after `side`'s first section, the side being 8 minutes old. */
function sideChange(side: Plan, id: string, tail = summarize(side.sections[0]!, 's1', 100), history: TurnContext['history']['sections'] = []): TurnContext {
  const m = side.movement!;
  const ctx = turnContext({ now: tail, movement: { ...movementOf(m.name, m.bpm, m.scale), groove: m.groove, ageMin: 8 }, kind: 'movement', sectionsWanted: 2, id });
  return { ...ctx, history: { ...ctx.history, sections: history } };
}

/** Someone else's groove (drums, bass, hats, keys) at `bpm`. */
function foreignSection(bpm: number, scale: string, name: string): SectionPlan {
  return {
    name,
    role: 'groove',
    bars: 32,
    bpm,
    tempoRampBars: 0,
    tempoRampAt: 'start',
    scale,
    chords: null,
    targets: { intensity: { start: 0.5, end: 0.6 }, brightness: { start: 0.5, end: 0.5 }, density: { start: 0.5, end: 0.5 }, tension: { start: 0.3, end: 0.3 } },
    transitionIn: { type: 'cut', bars: 0 },
    parts: [
      { id: 'kick', role: 'kick', code: 's("sbd*4").gain(0.9)', restart: false, chromatic: false, level: 0.9, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: { targets: ['bass'], depth: 0.4, releaseSec: 0.1 } },
      { id: 'bass', role: 'bass', code: 'n("<0 3>").scale("C2:minor").s("sawtooth").lpf(knob("cut"))', restart: false, chromatic: false, level: 0.7, enterBar: 0, exitBar: null, knobs: [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' }], automation: [], duck: null },
      { id: 'hats', role: 'hats', code: 's("white*8").hpf(8000).gain(0.2)', restart: false, chromatic: false, level: 0.6, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null },
      { id: 'keys', role: 'chords', code: 'n("[0,2,4]").scale("C3:minor").s("triangle")', restart: false, chromatic: false, level: 0.5, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null },
    ],
    reprise: null,
    publicNote: 'Someone else was playing.',
  };
}

/**
 * After a handoff: someone else's movement centred on `centre` whose last section plays at `bpm`, carried
 * three times already, so the autopilot moves on to its own material.
 */
function handoff(centre: number, bpm: number, scale: string, ageMin: number, id: string): { boot: Plan; ctx: TurnContext } {
  const tail = foreignSection(bpm, scale, 'Undercurrent');
  const boot: Plan = {
    sections: [tail],
    movement: { name: 'Claude side', startsAtSection: 0, bpm: centre, scale, groove: 'four-on-floor', arcShape: 'wave', form: [], palette: [], signature: [], blurb: 'Someone else.' },
    fork: null,
    requestDecisions: [],
    motifs: [],
    announcement: null,
    rationale: 'handoff',
  };
  const ctx = turnContext({
    now: summarize(tail, 'h3', 100),
    movement: { ...movementOf('Claude side', centre, scale), ageMin },
    history: ['Glass Harbour', 'Holding Pattern', 'Same River'].map((name, i) => ({ id: `h${i}`, name })),
    expected: ['groove', 'build'],
    kind: ageMin >= 6 ? 'movement' : 'section',
    sectionsWanted: 2,
    id,
  });
  return { boot, ctx };
}

interface Side {
  ensemble: string;
  groove: string;
  bpm: number;
}

/**
 * Plays side after side from `start`: each turn asks for a new side (as the conductor does once a side
 * is old enough) with the schedule's last section as the tail, commits the first candidate to the
 * conductor, and follows it. Alternate turns end the side on an outro already or let the plan close
 * it, and every third turn is a gap-filling fallback. The first side takes the bottom, the middle or
 * the top of its ensemble's tempo range.
 */
async function walk(lib: AutopilotLibrary, start: Ensemble, seed: number): Promise<{ sides: Side[]; failures: string[] }> {
  const tempi = [start.bpm.min, start.bpm.default, start.bpm.max].map((b) => Math.min(BPM_MAX, Math.max(BPM_MIN, b)));
  const first = sideOf(start, tempi[seed % tempi.length]!, `walk${seed}-${start.id}`, lib);
  const conductor = await conductorBootingWith(first);
  let movement: MovementPlan = first.movement!;
  const played: SectionSummary[] = [];
  const add = (sections: readonly SectionPlan[]) => {
    for (const s of sections) {
      const prev = played.at(-1) ?? null;
      played.push(summarize(s, `s${played.length}`, prev ? prev.startCycle + prev.bars : 4, prev));
    }
  };
  add(first.sections);
  const sides: Side[] = [{ ensemble: start.id, groove: movement.groove, bpm: movement.bpm }];
  const failures: string[] = [];
  for (let turn = 0; sides.length <= lib.ensembles.length && turn < 3 * lib.ensembles.length; turn++) {
    const tail = played.at(-1)!;
    const mode: PlanMode = (seed + turn) % 3 === 2 ? 'fallback' : 'compose';
    const now = (seed + turn) % 2 === 0 ? { ...tail, role: 'outro' as const } : tail;
    const history = played.slice(-13, -1).map((s) => ({ id: s.id, name: s.name, role: s.role, bpm: s.bpm, scale: s.scale, sounds: [], intensity: 0.5, fireZ: 0, keep: 0 }));
    const [candidate] = planCandidates(lib, sideChange({ ...first, movement }, `walk${seed}-${start.id}-${turn}`, now, history), mode);
    const error = await commit(conductor, candidate!.plan);
    if (error) {
      failures.push(`${start.id} seed ${seed} turn ${turn} (${mode}, ${movement.bpm} BPM ${movement.scale}, tail ${tail.bpm}): ${candidate!.kind} ${candidate!.opens?.id ?? ''} → ${error}`);
      break;
    }
    add(candidate!.plan.sections);
    if (candidate!.plan.movement) {
      movement = candidate!.plan.movement;
      sides.push({ ensemble: candidate!.opens!.id, groove: movement.groove, bpm: movement.bpm });
    }
  }
  await conductor.stop();
  return { sides, failures };
}

describe('the autopilot against the conductor', () => {
  it('opens the next side inside the room\'s tempo range, even in half time from a fast side', async () => {
    // Field drift follows dub techno on the tour, and half of 112–118 BPM is below the room's 60.
    const below: Ensemble = { ...ens('field-drift'), bpm: { min: 50, max: 76, default: 62 } };
    const failures: string[] = [];
    for (const [name, lib] of [['library', FULL], ['a range reaching below the floor', { ...FULL, ensembles: LIBRARY.map((e) => (e.id === 'field-drift' ? below : e)) }]] as const) {
      for (const bpm of [112, 114, 116, 118]) {
        for (let seed = 0; seed < 4; seed++) {
          const side = sideOf(ens('dub-techno'), bpm, `dub-${seed}`);
          const ctx = sideChange(side, `after-dub-${bpm}-${seed}`);
          for (const c of planCandidates(lib, ctx, 'compose')) if (c.plan.movement) expect(c.plan.movement.bpm, `${name}: ${c.opens!.id} after dub techno at ${bpm}`).toBeGreaterThanOrEqual(BPM_MIN);
          failures.push(...(await rejected(lib, side, ctx, `${name}: dub techno at ${bpm}, seed ${seed}`)));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('moves to half or double time only where the old movement\'s centre allows it too', async () => {
    // Tails 3–4 BPM off a centre: exact half or double of the tail can miss the centre's by more than 3 %.
    const failures: string[] = [];
    for (const [id, centre, bpm] of [['deep-house', 63, 60], ['drum-and-bass', 80, 83], ['lofi', 147, 151], ['jazz-trio', 63, 67], ['one-drop', 141, 145]] as const) {
      for (let seed = 0; seed < 6; seed++) {
        const { boot, ctx } = handoff(centre, bpm, 'C:minor', 8, `double-${id}-${seed}`);
        failures.push(...(await rejected({ ensembles: [ens(id)], sounds: new Map() }, boot, ctx, `${id}: centre ${centre}, tail ${bpm}, seed ${seed}`)));
      }
    }
    expect(failures).toEqual([]);
  });

  for (const [name, lib] of LIBRARIES) {
    it(`walks the whole tour from every ensemble, every plan accepted (${name} library)`, async () => {
      const seeds = name === 'full' ? [0, 1, 2] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
      const failures: string[] = [];
      for (const seed of seeds) {
        for (const start of lib.ensembles) {
          const { sides, failures: f } = await walk(lib, start, seed);
          failures.push(...f);
          if (f.length) continue;
          expect(sides.length, `${start.id} seed ${seed}`).toBe(lib.ensembles.length + 1);
          for (let i = 1; i < sides.length; i++) {
            const [a, b] = [sides[i - 1]!, sides[i]!];
            expect(b.ensemble, `${start.id} seed ${seed}: ${a.ensemble} → ${b.ensemble}`).not.toBe(a.ensemble);
            expect(b.groove, `${start.id} seed ${seed}: ${a.ensemble} → ${b.ensemble}`).not.toBe(a.groove);
          }
        }
      }
      expect(failures).toEqual([]);
    }, 120_000);
  }

  it('wherever the room steers the next side, from every ensemble, every candidate is accepted', async () => {
    const failures: string[] = [];
    const corners = [[0.95, 0.95], [0.05, 0.05], [0.95, 0.05], [0.05, 0.95]] as const;
    for (const [name, lib] of LIBRARIES) {
      for (const start of lib.ensembles) {
        for (const [i, [intensity, brightness]] of corners.entries()) {
          const side = sideOf(start, start.bpm.default, `steered-${start.id}-${i}`, lib);
          const ctx = sideChange(side, `steered-${start.id}-${i}`);
          const steered = { ...ctx, crowd: { ...ctx.crowd, listeners: 10, pad: { intensity, brightness, turnout: 1, consensus: 1, effectiveVoices: 10, split: null } } };
          failures.push(...(await rejected(lib, side, steered, `${name}: ${start.id}, pad ${intensity}/${brightness}`)));
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('after a handoff at any tempo, every candidate is accepted, in either library', async () => {
    const scales = ['C:minor', 'F#:dorian', 'Bb:major'];
    const failures: string[] = [];
    let n = 0;
    for (const [name, lib] of LIBRARIES) {
      for (let centre = BPM_MIN; centre <= BPM_MAX; centre += 4) {
        for (const offset of [-4, -3, 3, 4]) {
          const bpm = Math.min(BPM_MAX, Math.max(BPM_MIN, centre + offset));
          const ageMin = n % 2 === 0 ? 5 : 8;
          const { boot, ctx } = handoff(centre, bpm, scales[n++ % scales.length]!, ageMin, `handoff-${centre}-${offset}`);
          failures.push(...(await rejected(lib, boot, ctx, `${name}: centre ${centre}, tail ${bpm}, age ${ageMin}`)));
        }
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
