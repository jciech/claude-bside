// The movement arc (ARCHITECTURE §9): a baseline the crowd bends, a shape over movement progress,
// role offsets, and the peak/floor budgets. Everything here is pure; the conductor feeds it
// timings. Targets are advisory for composers; budgets are enforced by accept.ts.
import type { FormStep } from '../../shared/plan.ts';
import type { ArcShape, Groove, SectionRole, Span } from '../../shared/music.ts';
import type { PadPoint } from '../../shared/protocol.ts';

export interface Baseline {
  intensity: number;
  brightness: number;
}

export interface Arc {
  baseline: Baseline;
  amplitude: number;
  arcShape: ArcShape;
  groove: Groove;
}

export const ARC_AMPLITUDE: Record<ArcShape, number> = {
  plateau: 0.1,
  wave: 0.2,
  'ramp-up': 0.25,
  'ramp-down': 0.25,
  'peak-and-release': 0.35,
  terraced: 0.2,
};

/** Expected offsets per role, ×amplitude, as [start, end]. */
export const ROLE_OFFSETS: Record<SectionRole, { intensity: [number, number]; brightness: [number, number] }> = {
  intro: { intensity: [-1.2, -1.2], brightness: [-0.6, -0.6] },
  groove: { intensity: [0, 0], brightness: [0, 0] },
  build: { intensity: [-0.4, 0.8], brightness: [-0.2, 0.6] },
  drop: { intensity: [1.2, 1.2], brightness: [0.4, 0.4] },
  breakdown: { intensity: [-1.6, -1.6], brightness: [-0.4, -0.4] },
  bridge: { intensity: [-0.6, -0.6], brightness: [0, 0] },
  interlude: { intensity: [-1.0, -1.0], brightness: [0, 0] },
  outro: { intensity: [-1.2, -2.0], brightness: [-0.6, -0.6] },
  transition: { intensity: [0, 0], brightness: [0, 0] },
  reprise: { intensity: [0, 0], brightness: [0, 0] },
};

export const BUDGET_WINDOW_MS = 10 * 60_000;
export const PEAK_BUDGET_S = 180;
export const FLOOR_BUDGET_S = 240;
export const FLOOR_LEVEL = 0.2;
const BASELINE_STEP = 0.15;
const BASELINE_RANGE: [number, number] = [0.25, 0.7];
const TARGET_RANGE: [number, number] = [0.05, 0.95];

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;
export const lerpSpan = (s: Span, t: number) => s.start + (s.end - s.start) * clamp(t, 0, 1);

/** Ambient movements (quiet baseline or free groove) are exempt from the floor budget and baseline clamp. */
export function isAmbient(m: { baseline: Baseline; groove: Groove }): boolean {
  return m.baseline.intensity <= 0.3 || m.groove === 'free';
}

/** Intensity at or above this is a peak for a movement with this baseline. */
export function peakThreshold(baseline: Baseline): number {
  return Math.max(0.8, baseline.intensity + 0.25);
}

/** Offset of the arc's centre from the baseline (intensity) at movement progress p ∈ [0, 1]. */
export function arcCentre(shape: ArcShape, p: number): number {
  const q = clamp(p, 0, 1);
  switch (shape) {
    case 'plateau':
      return 0;
    case 'wave':
      return 0.1 * Math.sin(4 * Math.PI * q);
    case 'ramp-up':
      return -0.15 + 0.3 * q;
    case 'ramp-down':
      return 0.15 - 0.3 * q;
    case 'peak-and-release':
      return q <= 0.7 ? -0.1 + 0.25 * (q / 0.7) : 0.15 - 0.3 * ((q - 0.7) / 0.3);
    case 'terraced':
      return -0.1 + 0.075 * Math.min(3, Math.floor(q * 4));
  }
}

/** Where a role sits on the arc at progress p (brightness follows half the arc's swell). */
export function roleTargets(role: SectionRole, arc: Arc, p: number): { intensity: Span; brightness: Span } {
  const c = arcCentre(arc.arcShape, p);
  const o = ROLE_OFFSETS[role];
  const at = (base: number, offset: number) => round2(clamp(base + arc.amplitude * offset, ...TARGET_RANGE));
  return {
    intensity: { start: at(arc.baseline.intensity + c, o.intensity[0]), end: at(arc.baseline.intensity + c, o.intensity[1]) },
    brightness: { start: at(arc.baseline.brightness + c / 2, o.brightness[0]), end: at(arc.baseline.brightness + c / 2, o.brightness[1]) },
  };
}

/**
 * Slow lane: moves the baseline toward the room (pad space → descriptor space) by at most 0.15,
 * κ = 0.15 + 0.35·confidence, clamped to [0.25, 0.7] unless the movement is ambient.
 */
export function bendBaseline(b: Baseline, pull: PadPoint, confidence: number, groove: Groove): Baseline {
  const k = 0.15 + 0.35 * clamp(confidence, 0, 1);
  const [lo, hi] = isAmbient({ baseline: b, groove }) ? TARGET_RANGE : BASELINE_RANGE;
  const toward = (current: number, padValue: number) =>
    round2(clamp(current + clamp(k * ((clamp(padValue, -1, 1) + 1) / 2 - current), -BASELINE_STEP, BASELINE_STEP), lo, hi));
  return { intensity: toward(b.intensity, pull.y), brightness: toward(b.brightness, pull.x) };
}

/** One stretch of (planned or played) music for the budgets: uniform bars between startMs and endMs. */
export interface BudgetSpan {
  startMs: number;
  endMs: number;
  bars: number;
  intensity: Span;
  peakAt: number;
  floorExempt: boolean;
}

export function budgetSeconds(spans: readonly BudgetSpan[], fromMs: number, toMs: number): { peak: number; floor: number } {
  let peak = 0;
  let floor = 0;
  for (const s of spans) {
    const bars = Math.max(1, Math.round(s.bars));
    const barMs = (s.endMs - s.startMs) / bars;
    for (let i = 0; i < bars; i++) {
      const a = Math.max(fromMs, s.startMs + i * barMs);
      const b = Math.min(toMs, s.startMs + (i + 1) * barMs);
      if (b <= a) continue;
      const v = lerpSpan(s.intensity, bars > 1 ? i / (bars - 1) : 0);
      if (v >= s.peakAt) peak += (b - a) / 1000;
      if (v <= FLOOR_LEVEL && !s.floorExempt) floor += (b - a) / 1000;
    }
  }
  return { peak: round2(peak), floor: round2(floor) };
}

export const isPeakSpan = (s: Pick<BudgetSpan, 'intensity' | 'peakAt'>) => Math.max(s.intensity.start, s.intensity.end) >= s.peakAt;

/** Budget state as the composer sees it: used in the last 10 min, and what a section at `atMs` may still use. */
export function budgetState(spans: readonly BudgetSpan[], nowMs: number, atMs: number) {
  const used = budgetSeconds(spans, nowMs - BUDGET_WINDOW_MS, nowMs);
  const before = budgetSeconds(spans, atMs - BUDGET_WINDOW_MS, atMs);
  return {
    peakSecLast10Min: Math.round(used.peak),
    peakSecAllowedNow: Math.max(0, Math.round(PEAK_BUDGET_S - before.peak)),
    floorSecLast10Min: Math.round(used.floor),
    floorSecAllowedNow: Math.max(0, Math.round(FLOOR_BUDGET_S - before.floor)),
  };
}

const QUIET_CYCLE: SectionRole[] = ['groove', 'interlude', 'groove', 'bridge'];

/** Count of trailing entries equal to `role`. */
export function runLength(roles: readonly SectionRole[], role: SectionRole): number {
  let n = 0;
  for (let i = roles.length - 1; i >= 0 && roles[i] === role; i--) n++;
  return n;
}

export const maxRun = (role: SectionRole) => (role === 'groove' ? 3 : 2);

/** A plausible next role: the movement's form sketch first, otherwise a gentle default cycle. */
export function nextRole(input: { lastRoles: readonly SectionRole[]; progress: number; ageMin: number; formStep: FormStep | null; ambient: boolean }): SectionRole {
  const { lastRoles, progress, ageMin, formStep, ambient } = input;
  const prev = lastRoles[lastRoles.length - 1];
  const fits = (r: SectionRole) => runLength(lastRoles, r) < maxRun(r);
  if (formStep && fits(formStep.role)) return formStep.role;
  if (!prev) return 'intro';
  if (ageMin >= 12 || progress >= 0.9) return prev === 'outro' ? 'transition' : 'outro';
  if (ambient) {
    const next = QUIET_CYCLE[(lastRoles.length + 1) % QUIET_CYCLE.length]!;
    return fits(next) ? next : 'groove';
  }
  switch (prev) {
    case 'build':
      return 'drop';
    case 'drop':
      return fits('breakdown') && lastRoles.length % 2 === 0 ? 'breakdown' : 'groove';
    case 'breakdown':
      return 'build';
    case 'groove':
      return runLength(lastRoles, 'groove') >= 2 ? 'build' : 'groove';
    case 'outro':
      return 'intro';
    default:
      return 'groove';
  }
}

export interface ExpectedInput {
  arc: Arc;
  /** Movement progress at the first section's start. */
  progress: number;
  /** Progress per bar (1 / plannedBars). */
  progressPerBar: number;
  ageMin: number;
  startCycle: number;
  count: 1 | 2;
  /** A new movement opens with the last expected section. */
  newMovement: Arc | null;
  lastRoles: SectionRole[];
  formSteps: FormStep[];
  budget: { peakSecAllowedNow: number; floorSecAllowedNow: number };
  /** Consecutive peak sections at the end of what is played and committed. */
  peakRun: number;
  secondsPerBar: number;
}

export interface Expected {
  role: SectionRole;
  startCycle: number;
  targets: { intensity: Span; brightness: Span };
  notes: string[];
}

const TYPICAL_BARS = 32;

/** The conductor's advisory suggestion for each wanted section, already inside the budgets. */
export function expectedSections(input: ExpectedInput): Expected[] {
  const out: Expected[] = [];
  const roles = [...input.lastRoles];
  let cycle = input.startCycle;
  let peakRun = input.peakRun;
  let { peakSecAllowedNow: peakLeft, floorSecAllowedNow: floorLeft } = input.budget;
  for (let i = 0; i < input.count; i++) {
    const opensNew = input.newMovement !== null && i === input.count - 1;
    const arc = opensNew ? input.newMovement! : input.arc;
    const formStep = opensNew ? null : (input.formSteps[i] ?? null);
    const bars = formStep?.bars ?? TYPICAL_BARS;
    const progress = opensNew ? 0 : input.progress + (cycle - input.startCycle) * input.progressPerBar;
    const role: SectionRole = opensNew
      ? 'intro'
      : input.newMovement && i === 0 && input.count === 2
        ? 'outro'
        : nextRole({ lastRoles: roles, progress, ageMin: input.ageMin, formStep, ambient: isAmbient(arc) });
    const targets = roleTargets(role, arc, progress);
    const notes: string[] = [];
    if (formStep?.note) notes.push(`Form sketch: ${formStep.note}`);

    const peakAt = peakThreshold(arc.baseline);
    const sec = bars * input.secondsPerBar;
    const peaky = Math.max(targets.intensity.start, targets.intensity.end) >= peakAt;
    if (peaky && (peakRun >= 2 || peakLeft < sec / 2)) {
      const cap = round2(peakAt - 0.03);
      targets.intensity = { start: Math.min(targets.intensity.start, cap), end: Math.min(targets.intensity.end, cap) };
      notes.push(peakRun >= 2 ? 'Two peaks in a row already: this one should not peak.' : `Peak budget: about ${Math.round(peakLeft)} s of peak intensity (≥ ${round2(peakAt)}) left in this 10-minute window.`);
    }
    const floory = Math.min(targets.intensity.start, targets.intensity.end) <= FLOOR_LEVEL && !isAmbient(arc);
    if (floory && floorLeft < sec / 2) {
      targets.intensity = { start: Math.max(targets.intensity.start, 0.23), end: Math.max(targets.intensity.end, 0.23) };
      notes.push(`Floor budget: about ${Math.round(floorLeft)} s of near-silence (≤ ${FLOOR_LEVEL}) left in this 10-minute window.`);
    }
    if (role === 'build') notes.push('A build must measure at least 0.2 more intense or tense in its last 4 bars than its first 4.');
    if (roles[roles.length - 1] === 'build') notes.push('Follows a build: start with less tension than the build ends with.');
    if (role === 'outro' && !opensNew && input.ageMin >= 12) notes.push(`This side has run ${Math.round(input.ageMin)} min: close it, or open a new movement.`);
    if (opensNew) notes.push('Opens a new movement: new tempo centre, key, groove and palette; use at least 2 crate sounds.');

    const isPeak = Math.max(targets.intensity.start, targets.intensity.end) >= peakAt;
    peakRun = isPeak ? peakRun + 1 : 0;
    if (isPeak) peakLeft = Math.max(0, peakLeft - sec);
    out.push({ role, startCycle: cycle, targets, notes });
    roles.push(role);
    cycle += bars;
  }
  return out;
}
