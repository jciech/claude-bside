// One checker job: validate → compile (vm) → analyse every part of a section, as it will sound.
// Runs inside a checker worker (imported after registerStrudelHooks), or directly in tests.
import * as core from '@strudel/core';
import * as tonal from '@strudel/tonal';
import type { Issue, PartCheck, SectionCheck } from '../../shared/analysis.ts';
import type { Knob } from '../../shared/plan.ts';
import type { CheckPartInput, CheckSectionInput } from '../types.ts';
import { analyzeSection, limitViolations, type AnalyzeSectionInput } from '../../strudel/analyze.ts';
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

/** Binds every knob to one of its declared values, as a signal like the engine's binding. */
function knobsAt(knobs: Knob[], which: 'default' | 'min' | 'max') {
  const values = new Map(knobs.map((k) => [k.name, k[which]]));
  return (name: string) => {
    const value = values.get(name);
    return core.signal(() => value);
  };
}

/** Automation and the room's pad can push knobs to their declared extremes: check limits there too. */
function knobExtremes(part: CheckPartInput, bpm: number): Issue[] {
  if (!part.knobs.length) return [];
  const issues: Issue[] = [];
  for (const edge of ['min', 'max'] as const) {
    try {
      const { pattern } = compilePart(part.code, { knob: knobsAt(part.knobs, edge), evaluator });
      for (const v of limitViolations(pattern, part.patternBarAtStart, 2, bpm)) {
        issues.push({
          severity: 'warning',
          rule: 'knob-range',
          message: `With its knobs at their ${edge}, ${v.key} reaches ${String(v.value)} (allowed ${v.range}); listeners hear it clamped.`,
          path: part.id,
          hint: `Narrow the knob's ${edge} so ${v.key} stays inside ${v.range}.`,
        });
      }
    } catch {
      // The default binding compiled; extremes that fail are reported by the analysis at runtime.
    }
  }
  return issues;
}

export function runCheck(input: CheckSectionInput, deps: { index: SoundIndex; onPart?(id: string): void }): SectionCheck {
  resetStrudelState();
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
      const { pattern } = compilePart(part.code, { knob: knobsAt(part.knobs, 'default'), evaluator });
      compiled.push({ ...part, pattern });
      compiledChecks.push(check);
      check.warnings.push(...knobExtremes(part, input.bpm));
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
