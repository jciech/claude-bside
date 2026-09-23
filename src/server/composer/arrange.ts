// The autopilot's arranger: realises a section role from an ensemble by bringing layers in and out,
// continuing every part the section before was already playing (same code → carried, no restart),
// and shaping it with entries, exits, fader and knob automation, a transition and a liner note.
import { MAX_PARTS_PER_SECTION, PERCUSSIVE_ROLES, SECTION_LENGTHS, type SectionLength, type SectionRole, type Span } from '../../shared/music.ts';
import type { Automation, PartPlan, SectionPlan } from '../../shared/plan.ts';
import { CROSSFADE_MAX_BARS } from '../../shared/schedule.ts';
import type { Ensemble, Layer, TemplatePart } from './library/index.ts';
import { fillScale } from './library/scale.ts';

/** What the arranger needs to know about the section before (a SectionSummary fits). */
export interface PrevView {
  bars: number;
  parts: readonly { id: string; code: string; exitBar: number | null; level: number; knobValuesAtEnd: Readonly<Record<string, number>> }[];
}

export interface ArrangeInput {
  ensemble: Ensemble;
  role: SectionRole;
  scale: string;
  bpm: number;
  /** Ramp from the previous tempo over this many bars (0 = none). */
  rampBars: number;
  bars: SectionLength;
  prev: PrevView | null;
  /** The previous section was this ensemble in this scale (so its parts can continue). */
  sameEnsemble: boolean;
  /** Leave out percussive parts (a beatless bridge lets the tempo jump). */
  beatless: boolean;
  targets: { intensity: Span; brightness: Span } | null;
  name: string;
  seed: number;
}

export interface Arranged {
  section: SectionPlan;
  /** The section as the next one sees it (filled code for carried parts too). */
  view: PrevView;
}

interface LayerRule {
  /** Entry as a fraction of the section (fresh parts only). */
  enter?: number;
  /** Exit as a fraction; 1 = the last bar. */
  exit?: number;
  level?: number;
  fadeOut?: boolean;
  rise?: boolean;
}

const RULES: Record<SectionRole, Partial<Record<Layer, LayerRule>>> = {
  intro: { harmony: {}, color: {}, pulse: { enter: 0.5 }, low: { enter: 0.75 } },
  groove: { beat: {}, back: {}, pulse: {}, low: {}, harmony: {}, color: { level: 0.7 }, hook: { enter: 0.5 } },
  build: { beat: { exit: 1 }, back: {}, pulse: { rise: true }, low: {}, harmony: {}, hook: { enter: 0.5 } },
  drop: { beat: {}, back: {}, pulse: {}, low: {}, harmony: {}, hook: {}, color: { level: 0.8 } },
  breakdown: { harmony: {}, hook: {}, color: {}, low: { exit: 0.25 } },
  bridge: { back: {}, pulse: {}, low: {}, harmony: {}, color: {} },
  interlude: { harmony: {}, color: {}, hook: { enter: 0.5, level: 0.8 } },
  outro: { beat: { exit: 0.5 }, back: { exit: 0.5 }, pulse: { exit: 0.75 }, low: { exit: 0.75 }, harmony: { fadeOut: true }, color: { fadeOut: true }, hook: { exit: 0.25 } },
  transition: { harmony: {}, color: {}, pulse: {} },
  reprise: { beat: {}, back: {}, pulse: {}, low: {}, harmony: {}, hook: {}, color: { level: 0.8 } },
};

/** Composed length per role at moderate tempi; doubled from 150 BPM so sections last long enough. */
const ROLE_BARS: Record<SectionRole, SectionLength> = {
  intro: 16,
  groove: 32,
  build: 16,
  drop: 32,
  breakdown: 16,
  bridge: 16,
  interlude: 16,
  outro: 16,
  transition: 8,
  reprise: 32,
};

export function barsFor(role: SectionRole, bpm: number, minBars = 0): SectionLength {
  const base = ROLE_BARS[role] * (bpm >= 150 ? 2 : 1);
  const want = Math.max(base, role === 'transition' ? 0 : minBars);
  return SECTION_LENGTHS.find((l) => l >= want) ?? 64;
}

/**
 * Offsets from the ensemble's mood (intensity), and density/tension spans per role, calibrated
 * against what the checker measures for the library's arrangements (tension only rises when a
 * section gets brighter and denser toward its end, which the build's riser does).
 */
const SHAPES: Record<SectionRole, { intensity: [number, number]; density: [number, number]; tension: [number, number] }> = {
  intro: { intensity: [-0.2, -0.05], density: [0.4, 0.65], tension: [0.05, 0.15] },
  groove: { intensity: [0, 0], density: [0.85, 0.9], tension: [0.06, 0.08] },
  build: { intensity: [-0.05, 0.1], density: [0.85, 0.95], tension: [0.1, 0.5] },
  drop: { intensity: [0.05, 0.05], density: [0.95, 0.95], tension: [0.1, 0.1] },
  breakdown: { intensity: [-0.1, -0.15], density: [0.7, 0.6], tension: [0.08, 0.12] },
  bridge: { intensity: [-0.1, -0.1], density: [0.7, 0.7], tension: [0.05, 0.05] },
  interlude: { intensity: [-0.2, -0.15], density: [0.45, 0.6], tension: [0.03, 0.08] },
  outro: { intensity: [0, -0.15], density: [0.85, 0.5], tension: [0.08, 0.05] },
  transition: { intensity: [-0.1, -0.05], density: [0.6, 0.6], tension: [0.05, 0.15] },
  reprise: { intensity: [0.05, 0.05], density: [0.95, 0.95], tension: [0.1, 0.1] },
};

const RISER: TemplatePart = { id: 'riser', role: 'texture', layer: 'color', code: '', level: 0.7 };

/**
 * The build's riser, synth-only so it works with every ensemble: a noise roll that doubles in
 * density and opens its high-pass across the section. Pattern time starts at the section's bar 0,
 * so the ramps span exactly `bars`.
 */
export function riserCode(bars: number): string {
  const q = bars / 4;
  return [
    `s("white*<4!${q} 8!${q} 16!${2 * q}>")`,
    `  .hpf(saw.range(200, 10000).slow(${bars}))`,
    '  .decay(0.06)',
    '  .sustain(0)',
    `  .gain(saw.range(0.02, 0.4).slow(${bars}))`,
    '  .pan(sine.range(0.35, 0.65).fast(2))',
  ].join('\n');
}

const clamp01 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 100) / 100;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function targetsFor(role: SectionRole, ensemble: Ensemble, expected: ArrangeInput['targets']): SectionPlan['targets'] {
  const shape = SHAPES[role];
  const mood = ensemble.mood;
  const span = (pair: [number, number]): Span => ({ start: clamp01(pair[0]), end: clamp01(pair[1]) });
  return {
    intensity: expected?.intensity ?? span([mood.intensity + shape.intensity[0], mood.intensity + shape.intensity[1]]),
    brightness: expected?.brightness ?? span([mood.brightness, mood.brightness]),
    density: span(shape.density),
    tension: span(shape.tension),
  };
}

function transitionFor(input: ArrangeInput, present: readonly { continuing: boolean }[]): SectionPlan['transitionIn'] {
  const { prev, role, bars } = input;
  if (!prev || present.every((p) => p.continuing)) return { type: 'cut', bars: 0 };
  const room = Math.floor(Math.min(CROSSFADE_MAX_BARS, bars / 2, prev.bars / 2));
  if (input.rampBars > 0 || input.beatless) return { type: 'filter', bars: Math.min(4, prev.bars) };
  if (!input.sameEnsemble) return room >= 1 ? { type: 'crossfade', bars: Math.min(room, 8) } : { type: 'cut', bars: 0 };
  if (role === 'drop' || role === 'reprise') return input.seed % 2 === 0 ? { type: 'breath', bars: 1 } : { type: 'riser', bars: Math.min(4, prev.bars) };
  if (role === 'breakdown') return { type: 'filter', bars: Math.min(4, prev.bars) };
  return { type: 'cut', bars: 0 };
}

/** Knob lanes: builds open every knob toward its far end; breakdowns dip filters and bring them back. */
function knobLanes(part: TemplatePart, role: SectionRole, bars: number, start: Readonly<Record<string, number>> | null): Automation[] {
  const lanes: Automation[] = [];
  for (const k of part.knobs ?? []) {
    const from = Math.min(k.max, Math.max(k.min, start?.[k.name] ?? k.default));
    const curve = k.min > 0 && k.name === 'cut' ? 'exp' : 'linear';
    if (role === 'build') {
      const to = k.follows.startsWith('-') ? k.min : k.max;
      if (to !== from) lanes.push({ target: `knob:${k.name}`, fromBar: 0, toBar: bars, from: round2(from), to, curve });
    } else if (role === 'breakdown' && k.name === 'cut') {
      const low = round2(k.min + 0.3 * (k.max - k.min));
      const half = Math.max(1, Math.floor(bars / 2));
      lanes.push({ target: `knob:${k.name}`, fromBar: 0, toBar: half, from: round2(from), to: low, curve });
      lanes.push({ target: `knob:${k.name}`, fromBar: half, toBar: bars, from: low, to: k.default, curve });
    }
  }
  return lanes;
}

export function arrangeSection(input: ArrangeInput): Arranged {
  const { ensemble, role, bars, prev } = input;
  const rules = RULES[role];
  const prevParts = new Map((prev?.parts ?? []).map((p) => [p.id, p]));

  let chosen = ensemble.parts.filter((p) => rules[p.layer] && !(input.beatless && PERCUSSIVE_ROLES.has(p.role)));
  if (!chosen.length) chosen = ensemble.parts.filter((p) => !PERCUSSIVE_ROLES.has(p.role)).slice(0, 2);
  if (!chosen.length) chosen = ensemble.parts.slice(0, 1);

  const barAt = (fraction: number) => Math.min(bars - 1, Math.max(1, Math.round(fraction * bars)));
  const drafts = chosen.map((tp) => {
    const rule = rules[tp.layer] ?? {};
    const code = fillScale(tp.code, input.scale);
    const before = prevParts.get(tp.id);
    const continuing = !!before && before.code === code && before.exitBar === null;
    const level = round2(Math.min(1, tp.level * (rule.level ?? 1)));
    const enterBar = continuing || rule.enter === undefined ? 0 : barAt(rule.enter);
    const exitBar = rule.exit === undefined ? null : rule.exit >= 1 ? bars - 1 : barAt(rule.exit);
    const automation: Automation[] = [...knobLanes(tp, role, bars, continuing ? before.knobValuesAtEnd : null)];
    if (rule.rise) automation.push({ target: 'level', fromBar: 0, toBar: bars, from: round2(level * 0.5), to: level, curve: 'linear' });
    if (rule.fadeOut) automation.push({ target: 'level', fromBar: Math.floor(bars / 2), toBar: bars, from: level, to: round2(level * 0.05), curve: 'exp' });
    return { tp, code, continuing, level, enterBar, exitBar: exitBar !== null && exitBar <= enterBar ? null : exitBar, automation };
  });
  if (!drafts.some((d) => d.enterBar === 0)) drafts[0]!.enterBar = 0;

  if (role === 'build' && drafts.length < MAX_PARTS_PER_SECTION && !drafts.some((d) => d.tp.id === RISER.id)) {
    drafts.push({ tp: RISER, code: riserCode(bars), continuing: false, level: RISER.level, enterBar: 0, exitBar: null, automation: [] });
  }
  const ids = new Set(drafts.map((d) => d.tp.id));
  const parts: PartPlan[] = drafts.map((d) => {
    const targets = (d.tp.duck?.targets ?? []).filter((t) => ids.has(t) && t !== d.tp.id);
    return {
      id: d.tp.id,
      role: d.tp.role,
      code: d.continuing ? null : d.code,
      restart: false,
      chromatic: false,
      level: d.level,
      enterBar: d.enterBar,
      exitBar: d.exitBar,
      knobs: d.continuing ? [] : (d.tp.knobs ?? []),
      automation: d.automation,
      duck: d.tp.duck && targets.length ? { targets, depth: d.tp.duck.depth, releaseSec: d.tp.duck.releaseSec } : null,
    };
  });

  const section: SectionPlan = {
    name: input.name,
    role,
    bars,
    bpm: input.bpm,
    tempoRampBars: Math.min(bars, input.rampBars),
    tempoRampAt: 'start',
    scale: input.scale,
    chords: null,
    targets: targetsFor(role, ensemble, input.targets),
    transitionIn: transitionFor(input, drafts),
    parts,
    reprise: null,
    publicNote: linerNote(ensemble, role, drafts.map((d) => ({ layer: d.tp.layer, enterBar: d.enterBar, exitBar: d.exitBar })), prev !== null && !input.sameEnsemble),
  };
  const view: PrevView = {
    bars,
    parts: drafts.map((d) => ({
      id: d.tp.id,
      code: d.code,
      exitBar: d.exitBar,
      level: d.level,
      knobValuesAtEnd: Object.fromEntries((d.tp.knobs ?? []).map((k) => [k.name, endValue(d.automation, `knob:${k.name}`, prevParts.get(d.tp.id)?.knobValuesAtEnd[k.name] ?? k.default)])),
    })),
  };
  return { section, view };
}

function endValue(lanes: readonly Automation[], target: string, base: number): number {
  const mine = lanes.filter((a) => a.target === target).sort((a, b) => a.toBar - b.toBar);
  return mine.length ? mine[mine.length - 1]!.to : base;
}

// ─── Liner notes ────────────────────────────────────────────────────────────────────────────────

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function list(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A short, specific note in the autopilot's voice, from the ensemble's layer labels. */
export function linerNote(ensemble: Ensemble, role: SectionRole, present: { layer: Layer; enterBar: number; exitBar: number | null }[], arriving: boolean): string {
  const label = (layer: Layer) => (present.some((p) => p.layer === layer) ? ensemble.labels[layer] : undefined);
  const at = (layer: Layer) => present.find((p) => p.layer === layer);
  const all = present.map((p) => ensemble.labels[p.layer]).filter((l, i, a): l is string => !!l && a.indexOf(l) === i);
  const opener = arriving ? `${ensemble.name}: ` : '';
  let text: string;
  switch (role) {
    case 'intro': {
      const first = label('harmony') ?? label('color') ?? all[0] ?? 'a single voice';
      const later = [label('pulse'), label('low')].filter((l): l is string => !!l);
      text = `It opens on ${first}${later.length ? `, with ${list(later)} joining along the way` : ''}.`;
      break;
    }
    case 'groove': {
      const base = [label('beat'), label('low')].filter((l): l is string => !!l);
      const hook = at('hook');
      text = `Into the groove: ${list(base.length ? base : all.slice(0, 2))}${label('harmony') ? ` under ${label('harmony')}` : ''}${hook && hook.enterBar > 0 ? `, and from bar ${hook.enterBar} ${ensemble.labels.hook} in answer` : ''}.`;
      break;
    }
    case 'build': {
      const drops = at('beat')?.exitBar ? label('beat') : undefined;
      text = `Winding it up: a noise riser climbs, filters open, ${label('pulse') ?? 'the rhythm'} thickening${drops ? `, and ${drops} holding back for the last bar` : ''}.`;
      break;
    }
    case 'drop':
    case 'reprise':
      text = `Everything at once: ${list(all.slice(0, 4))}.`;
      break;
    case 'breakdown':
      text = `The drums fall away, leaving ${list([label('harmony'), label('hook')].filter((l): l is string => !!l)) || all[0]} in the air.`;
      break;
    case 'bridge':
      text = `A side road: ${list(all.slice(0, 3))}, the lead resting.`;
      break;
    case 'interlude':
      text = `A breath between songs: ${list(all.slice(0, 3))}.`;
      break;
    case 'outro':
      text = `Winding down: the parts leave one by one, and last of all ${label('harmony') ?? all[all.length - 1] ?? 'the last voice'} fades out.`;
      break;
    case 'transition':
      text = `Crossing over on ${list(all.slice(0, 2))}.`;
      break;
  }
  return (opener ? `${opener}${text.charAt(0).toLowerCase()}${text.slice(1)}` : text).slice(0, 280);
}
