// Carry-vamp: after a handoff the autopilot keeps playing whatever was playing — every part carried
// and continuing — and keeps it alive with deterministic arrangement moves: one part steps out for
// eight bars and comes back, a knob drifts and returns, and every third section is a breakdown
// (percussion faded out but kept in place, so the next section can bring it straight back).
import type { SectionSummary } from '../../shared/composer-api.ts';
import { PERCUSSIVE_ROLES, type PartRole, type SectionLength } from '../../shared/music.ts';
import type { Automation, PartPlan, Plan, SectionPlan } from '../../shared/plan.ts';

const GROOVE_NAMES = ['Holding Pattern', 'Same River', 'Circling', 'Long Exposure', 'Afterimage', 'The Band Plays On', 'Still Moving', 'Undertow'];
const BREAKDOWN_NAMES = ['Clearing', 'Open Water', 'Undercurrent', 'Low Tide'];
const CARRY_NAMES = new Set([...GROOVE_NAMES, ...BREAKDOWN_NAMES]);

/** Carry-vamp sections before the autopilot moves on to its own material. */
export const MAX_CARRY_RUN = 3;

const ROLE_WORDS: Record<PartRole, string> = {
  kick: 'the kick',
  snare: 'the snare',
  hats: 'the hats',
  perc: 'the percussion',
  breaks: 'the break',
  bass: 'the bass',
  chords: 'the chords',
  arp: 'the arpeggio',
  lead: 'the lead',
  pad: 'the pad',
  texture: 'the texture',
  vox: 'the voice',
};

export const isCarryName = (name: string) => CARRY_NAMES.has(name);

/** How many carry-vamp sections end the history so far (played, then committed), by name. */
export function carryRun(names: readonly string[]): number {
  let run = 0;
  for (let i = names.length - 1; i >= 0 && isCarryName(names[i]!); i--) run++;
  return run;
}

const round2 = (x: number) => Math.round(x * 100) / 100;

type TailPart = SectionSummary['parts'][number];

function sounding(tail: Pick<SectionSummary, 'bars' | 'parts'>): TailPart[] {
  const live = tail.parts.filter((p) => p.exitBar === null || p.exitBar >= tail.bars);
  return live.length ? live : tail.parts;
}

/** Deterministic rotation of which part steps out in each 8-bar block (never the only part). */
function stepOuts(parts: readonly TailPart[], run: number, bars: number): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (parts.length < 2) return out;
  const order = [...parts].sort((a, b) => Number(a.role === 'kick') - Number(b.role === 'kick'));
  let k = run;
  for (let block = 8; block + 8 <= bars; block += 16) {
    const p = order[k++ % order.length]!;
    out.set(p.id, [...(out.get(p.id) ?? []), block]);
  }
  return out;
}

function knobDrift(p: TailPart, bars: number): Automation[] {
  const k = p.knobs[0];
  if (!k) return [];
  const from = Math.min(k.max, Math.max(k.min, p.knobValuesAtEnd[k.name] ?? k.default));
  const far = from - k.min > k.max - from ? k.min : k.max;
  const to = round2(from + (far - from) * 0.5);
  if (to === round2(from)) return [];
  const half = Math.floor(bars / 2);
  return [
    { target: `knob:${k.name}`, fromBar: 0, toBar: half, from: round2(from), to, curve: 'linear' },
    { target: `knob:${k.name}`, fromBar: half, toBar: bars, from: to, to: round2(from), curve: 'linear' },
  ];
}

export function carrySection(tail: SectionSummary, run: number, bars: SectionLength): SectionPlan {
  const breakdown = run % 3 === 2;
  const parts = sounding(tail);
  const hasPercussion = parts.some((p) => PERCUSSIVE_ROLES.has(p.role));
  const quiet = breakdown && hasPercussion && parts.some((p) => !PERCUSSIVE_ROLES.has(p.role));
  const outs = quiet ? new Map<string, number[]>() : stepOuts(parts, run, bars);
  const ids = new Set(parts.map((p) => p.id));
  const planned: PartPlan[] = parts.map((p) => {
    const level = round2(Math.max(0.05, p.level));
    const automation: Automation[] = [];
    if (quiet && PERCUSSIVE_ROLES.has(p.role)) {
      automation.push({ target: 'level', fromBar: 0, toBar: 2, from: level, to: 0, curve: 'linear' });
    } else {
      for (const at of outs.get(p.id) ?? []) {
        automation.push({ target: 'level', fromBar: at, toBar: at + 1, from: level, to: 0, curve: 'linear' });
        automation.push({ target: 'level', fromBar: at + 7, toBar: at + 8, from: 0, to: level, curve: 'linear' });
      }
      automation.push(...knobDrift(p, bars));
    }
    const duckTargets = (p.duck?.targets ?? []).filter((t) => ids.has(t) && t !== p.id);
    return {
      id: p.id,
      role: p.role,
      code: null,
      restart: false,
      chromatic: p.chromatic,
      level,
      enterBar: 0,
      exitBar: null,
      knobs: [],
      automation,
      duck: p.duck && duckTargets.length ? { targets: duckTargets, depth: p.duck.depth, releaseSec: p.duck.releaseSec } : null,
    };
  });
  const stepping = parts.filter((p) => outs.has(p.id)).map((p) => ROLE_WORDS[p.role]);
  const names = quiet ? BREAKDOWN_NAMES : GROOVE_NAMES;
  return {
    name: names[run % names.length]!,
    role: quiet ? 'breakdown' : 'groove',
    bars,
    bpm: tail.bpm,
    tempoRampBars: 0,
    tempoRampAt: 'start',
    scale: tail.scale,
    chords: tail.chords,
    targets: quiet
      ? {
          intensity: { start: round2(tail.measured.intensity.end * 0.7), end: round2(tail.measured.intensity.end * 0.6) },
          brightness: tail.measured.brightness,
          density: { start: round2(tail.measured.density.end * 0.6), end: round2(tail.measured.density.end * 0.6) },
          tension: tail.measured.tension,
        }
      : structuredClone(tail.measured),
    transitionIn: { type: 'cut', bars: 0 },
    parts: planned,
    reprise: null,
    publicNote: quiet
      ? 'The drums step back and the rest of the band holds the thread; they return next section.'
      : stepping.length
        ? `The band stays with what was playing; ${stepping.join(', then ')} step${stepping.length === 1 ? 's' : ''} out for eight bars and come${stepping.length === 1 ? 's' : ''} back.`
        : 'The band stays with what was playing while the next idea takes shape.',
  };
}

/** A carry-vamp plan of one or two sections continuing `tail`. */
export function carryPlan(tail: SectionSummary, run: number, bars: SectionLength, sections: 1 | 2): Plan {
  const first = carrySection(tail, run, bars);
  const out = [first];
  if (sections === 2) {
    const view: SectionSummary = { ...tail, name: first.name, parts: sounding(tail) };
    out.push(carrySection(view, run + 1, bars));
  }
  return {
    sections: out,
    movement: null,
    fork: null,
    requestDecisions: [],
    motifs: [],
    announcement: null,
    rationale: `autopilot: carry-vamp of "${tail.name}", section ${run + 1} of the carry`,
  };
}
