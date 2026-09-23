// One checker job: validate → compile (vm) → analyse every part of a section, as it will sound.
// Runs inside a checker worker (imported after registerStrudelHooks), or directly in tests.
import * as core from '@strudel/core';
import * as tonal from '@strudel/tonal';
import type { Issue, PartCheck, SectionCheck } from '../../shared/analysis.ts';
import { laneValue, lanesFor } from '../../shared/automation.ts';
import { MAX_PART_ONSETS_PER_BAR } from '../../shared/limits.ts';
import type { Knob } from '../../shared/plan.ts';
import type { CheckPartInput, CheckSectionInput } from '../types.ts';
import { analysedLoopBars, analyzeSection, probeBars, scoreBarOf, type AnalyzeSectionInput } from '../../strudel/analyze.ts';
import type { SoundIndex } from '../../strudel/catalog.ts';
import { CompileError, compilePart, runtimeIssue } from '../../strudel/compile.ts';
import { validatePart } from '../../strudel/validate.ts';
import { createVmEvaluator } from './vm-evaluator.ts';

const evaluator = createVmEvaluator();
const now = () => performance.now();
const ms = (t0: number) => Math.round((now() - t0) * 100) / 100;
const withPath = (issues: Issue[], path: string): Issue[] => issues.map((i) => (i.path ? i : { ...i, path }));

/** Global Strudel state a previous job could have touched (voicing dictionaries, timelines, RNG, steps). */
function resetStrudelState(): void {
  tonal.resetVoicings();
  core.reset_state();
  core.useRNG('legacy');
  core.calculateSteps(true);
}

/** Binds every knob to one of its declared extremes, as a signal like the engine's binding. */
function knobsAt(knobs: Knob[], which: 'min' | 'max') {
  const values = new Map(knobs.map((k) => [k.name, k[which]]));
  return (name: string) => {
    const value = values.get(name);
    return core.signal(() => value);
  };
}

/**
 * Binds every knob like the performer (src/client/engine/types.ts): its lane at the score bar where the
 * value is read, from its default, clamped to its range — without the room's follow offset.
 */
function knobsAlongLanes(part: CheckPartInput, section: { bars: number; loopBars: number }) {
  const knobs = new Map(part.knobs.map((k) => [k.name, k]));
  return (name: string) => {
    const knob = knobs.get(name)!;
    const lanes = lanesFor(part.automation ?? [], `knob:${name}`);
    const [lo, hi] = [Math.min(knob.min, knob.max), Math.max(knob.min, knob.max)];
    return core.signal((t: unknown) => {
      // A fresh part is read on score time already; a continuing one on its own pattern time.
      const bar = part.continues === false ? Number(t) : scoreBarOf(Number(t) - part.patternBarAtStart, section.bars, section.loopBars);
      return Math.min(hi, Math.max(lo, laneValue(lanes, bar, knob.default)));
    });
  };
}

/** Automation and the room's pad can push knobs to their declared extremes: check limits and density there too. */
function knobExtremes(part: CheckPartInput, bpm: number): { errors: Issue[]; warnings: Issue[] } {
  const found = { errors: [] as Issue[], warnings: [] as Issue[] };
  for (const edge of part.knobs.length ? (['min', 'max'] as const) : []) {
    try {
      const { pattern } = compilePart(part.code, { knob: knobsAt(part.knobs, edge), evaluator });
      const { violations, densest } = probeBars(pattern, part.patternBarAtStart, 2, bpm);
      if (densest.onsets > MAX_PART_ONSETS_PER_BAR) {
        found.errors.push({
          severity: 'error',
          rule: 'density',
          message: `With its knobs at their ${edge}, the part plays ${densest.onsets} events in bar ${densest.bar}; a part may play at most ${MAX_PART_ONSETS_PER_BAR} per bar.`,
          path: part.id,
          hint: `Narrow the knob's ${edge}, or keep knobs out of what sets the number of events.`,
        });
      }
      for (const v of violations) {
        found.warnings.push({
          severity: 'warning',
          rule: 'knob-range',
          message: `With its knobs at their ${edge}, ${v.key} reaches ${String(v.value)} (allowed ${v.range}); listeners hear it clamped.`,
          path: part.id,
          hint: `Narrow the knob's ${edge} so ${v.key} stays inside ${v.range}.`,
        });
      }
    } catch {
      // The lane binding compiled; extremes that fail are reported by the analysis at runtime.
    }
  }
  return found;
}

export function runCheck(input: CheckSectionInput, deps: { index: SoundIndex; onPart?(id: string): void }): SectionCheck {
  resetStrudelState();
  const bars = Math.max(1, Math.round(input.bars));
  const shape = { bars, loopBars: analysedLoopBars(bars, input.vampLoopBars) };
  const checks: PartCheck[] = [];
  const compiled: AnalyzeSectionInput['parts'] = [];
  const compiledChecks: PartCheck[] = [];

  for (const part of input.parts) {
    deps.onPart?.(part.id);
    const check: PartCheck = {
      id: part.id,
      ok: false,
      errors: [],
      warnings: [],
      analysis: null,
      timings: { validateMs: 0, evaluateMs: 0, analyzeMs: 0 },
      digest: null,
      instrument: '',
    };
    checks.push(check);

    let t0 = now();
    const v = validatePart(part.code, { knobs: part.knobs.map((k) => k.name) });
    check.timings.validateMs = ms(t0);
    check.errors.push(...withPath(v.errors, part.id));
    check.warnings.push(...withPath(v.warnings, part.id));
    for (const k of part.knobs) {
      if (v.ok && !v.knobsUsed.includes(k.name)) {
        check.warnings.push({ severity: 'warning', rule: 'knob-unused', message: `The knob "${k.name}" is declared but the code never reads knob("${k.name}").`, path: part.id });
      }
    }
    if (!v.ok) continue;

    t0 = now();
    try {
      const { pattern } = compilePart(part.code, { knob: knobsAlongLanes(part, shape), evaluator });
      compiled.push({ ...part, pattern });
      compiledChecks.push(check);
      const extremes = knobExtremes(part, input.bpm);
      check.errors.push(...extremes.errors);
      check.warnings.push(...extremes.warnings);
    } catch (e) {
      check.errors.push({ ...(e instanceof CompileError ? e.issue : runtimeIssue(e)), path: part.id });
    }
    check.timings.evaluateMs = ms(t0);
  }

  let section: Pick<SectionCheck, 'mix' | 'fingerprint' | 'errors' | 'warnings'> = { mix: null, fingerprint: null, errors: [], warnings: [] };
  if (compiled.length) {
    try {
      const result = analyzeSection(
        { parts: compiled, bpm: input.bpm, scale: input.scale, bars: input.bars, vampLoopBars: input.vampLoopBars, index: deps.index },
        { onPart: deps.onPart },
      );
      result.parts.forEach((p, i) => {
        const check = compiledChecks[i]!;
        check.analysis = p.analysis;
        check.digest = p.digest;
        check.instrument = p.instrument;
        check.timings.analyzeMs = p.analyzeMs;
        check.errors.push(...p.errors);
        check.warnings.push(...p.warnings);
      });
      section = { mix: result.mix, fingerprint: result.fingerprint, errors: result.errors, warnings: result.warnings };
    } catch (e) {
      section.errors.push({ severity: 'error', rule: 'internal', message: `Analysis failed: ${(e as Error).message}` });
    }
  }

  const parts = checks.map((check) => ({ ...check, ok: check.errors.length === 0 }));
  return {
    ok: section.errors.length === 0 && parts.every((p) => p.ok),
    errors: section.errors,
    warnings: section.warnings,
    parts,
    mix: section.mix,
    fingerprint: section.fingerprint,
  };
}
