// The scripted autopilot (ARCHITECTURE §7.4): a boot-validated library of ensembles plus carry-vamp
// arrangement moves. `fallbackPlan` is synchronous (the conductor fills gaps and boots with it);
// `compose` is the autopilot acting as the room's composer, committing through the same tools as
// everyone else and trying its next candidate when a plan is rejected.
import { createHash } from 'node:crypto';
import type { Issue, SectionCheck } from '../../shared/analysis.ts';
import type { Catalog } from '../../shared/catalog.ts';
import type { PlanRequest, TurnContext } from '../../shared/composer-api.ts';
import type { Knob, Plan } from '../../shared/plan.ts';
import { vampLoopFor } from '../../shared/schedule.ts';
import type { CheckPartInput, CheckSectionInput, ComposeOutcome, ComposerTools, Checker, Logger, ScriptedComposer } from '../types.ts';
import { planCandidates, type AutopilotLibrary } from './autopilot.ts';
import { LIBRARY, type Ensemble } from './library/index.ts';
import { fillScale, scaleOf } from './library/scale.ts';
import { partVariants, type Variant } from './variants.ts';

export interface ScriptedOptions {
  catalog: Catalog;
  checker: Checker;
  log: Logger;
  /**
   * Only ensembles built from superdough's own synths (nothing to download): CI, end-to-end tests,
   * offline rooms. Defaults to BSIDE_AUTOPILOT=synth.
   */
  synthOnly?: boolean;
  /** Ensembles to validate and use (default: the whole library). */
  library?: readonly Ensemble[];
}

const VALIDATION_CONCURRENCY = 4;
const MAX_COMPOSE_ATTEMPTS = 3;
const BOOT_CHECK_ATTEMPTS = 3;
/** A check that failed for the checker's own reasons (load, a crashed worker), not the code's. */
const INCONCLUSIVE_RULES: ReadonlySet<string> = new Set(['timeout', 'busy', 'internal']);
const inconclusive = (check: SectionCheck) => check.errors.some((e) => INCONCLUSIVE_RULES.has(e.rule));
const WIDE_MODES = /pentatonic|pelog|hirajoshi|in-sen|iwato|kumoi/;

// Knob defaults move per section and stay inside the declared range, so a verdict holds for any of them.
const codeKey = (code: string, knobs: readonly Knob[]) =>
  createHash('sha1').update(`${code}\u0000${JSON.stringify(knobs.map((k) => [k.name, k.min, k.max, k.follows]))}`).digest('hex');

/**
 * Two keys cover an ensemble's register: tonic C in its main mode (lowest notes) and tonic B in its
 * widest mode (pentatonic degrees climb furthest). Every other key lies between them.
 */
function validationScales(ens: Ensemble): string[] {
  const wide = ens.modes.find((m) => WIDE_MODES.test(m)) ?? ens.modes[ens.modes.length - 1]!;
  return [scaleOf('C', ens.modes[0]!), scaleOf('B', wide)];
}

function partsFor(ens: Ensemble, scale: string): CheckPartInput[] {
  return ens.parts.map((p) => ({
    id: p.id,
    role: p.role,
    code: fillScale(p.code, scale),
    knobs: p.knobs ?? [],
    chromatic: false,
    level: p.level,
    enterBar: 0,
    exitBar: null,
    patternBarAtStart: 0,
  }));
}

const describe = (issues: readonly Issue[]) => issues.slice(0, 3).map((i) => `${i.path ? `${i.path}: ` : ''}${i.rule}: ${i.message}`);

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export interface ValidatedLibrary {
  lib: AutopilotLibrary;
  /** Part code (+ knob ranges) → passed the checker. */
  verdicts: Map<string, boolean>;
}

/**
 * Checks every ensemble in its two validation keys, and every code variant of its parts, with the
 * real checker; ensembles that fail are dropped, variants that fail are never played.
 */
export async function validateLibrary(opts: ScriptedOptions): Promise<ValidatedLibrary> {
  const { checker, log, catalog } = opts;
  const synthOnly = opts.synthOnly ?? process.env.BSIDE_AUTOPILOT === 'synth';
  const kinds = new Map(catalog.sounds.map((s) => [s.id, s.kind]));
  const verdicts = new Map<string, boolean>();

  /** A boot check, tried again while the checker (not the code) is what failed. */
  const bootCheck = async (input: CheckSectionInput): Promise<SectionCheck> => {
    let check = await checker.checkSection(input, { priority: 'audition' });
    for (let attempt = 1; attempt < BOOT_CHECK_ATTEMPTS && inconclusive(check); attempt++) {
      await new Promise((r) => setTimeout(r, 250 * attempt));
      check = await checker.checkSection(input, { priority: 'audition' });
    }
    return check;
  };

  const validate = async (ens: Ensemble): Promise<{ ens: Ensemble; sounds: string[]; variants: Map<string, Variant[]> } | null> => {
    const sounds = new Set<string>();
    const scales = validationScales(ens);
    for (const scale of scales) {
      const parts = partsFor(ens, scale);
      let check;
      try {
        check = await bootCheck({ parts, bpm: ens.bpm.default, scale, bars: 16, vampLoopBars: vampLoopFor(16) });
      } catch (e) {
        log.warn('scripted: ensemble could not be checked', { ensemble: ens.id, error: (e as Error).message });
        return null;
      }
      if (!inconclusive(check)) check.parts.forEach((p, i) => verdicts.set(codeKey(parts[i]!.code, parts[i]!.knobs), p.ok));
      if (!check.ok) {
        log.warn('scripted: ensemble dropped', { ensemble: ens.id, scale, issues: describe([...check.errors, ...check.parts.flatMap((p) => p.errors)]) });
        return null;
      }
      for (const p of check.parts) for (const s of p.analysis?.sounds ?? []) if (s.share > 0 || s.onsets > 0) sounds.add(s.id);
    }
    if (synthOnly && [...sounds].some((id) => kinds.get(id) !== 'synth')) return null;
    return { ens, sounds: [...sounds], variants: await validateVariants(ens, scales) };
  };

  /**
   * Which code variants each part may play: those that pass on their own in both validation keys.
   * All variants of an ensemble are checked together; only part-level findings count (they never
   * play together, so the mix limits don't apply).
   */
  const validateVariants = async (ens: Ensemble, scales: string[]): Promise<Map<string, Variant[]>> => {
    const candidates = ens.parts.flatMap((p) => partVariants(p).filter((v) => v.variant !== 'base').map((v) => ({ part: p, ...v })));
    const passed = new Map<string, Set<Variant>>(ens.parts.map((p) => [p.id, new Set(candidates.filter((c) => c.part.id === p.id).map((c) => c.variant))]));
    for (const scale of scales) {
      if (!candidates.length) break;
      const parts: CheckPartInput[] = candidates.map((c, i) => ({
        id: `v${i}`,
        role: c.part.role,
        code: fillScale(c.code, scale),
        knobs: c.part.knobs ?? [],
        chromatic: false,
        level: c.part.level,
        enterBar: 0,
        exitBar: null,
        patternBarAtStart: 0,
      }));
      let check: SectionCheck | null = null;
      try {
        check = await bootCheck({ parts, bpm: ens.bpm.default, scale, bars: 16, vampLoopBars: vampLoopFor(16) });
      } catch (e) {
        log.warn('scripted: variants could not be checked', { ensemble: ens.id, error: (e as Error).message });
      }
      // Unchecked variants are simply not played; only real verdicts are remembered.
      const settled = check !== null && !inconclusive(check);
      if (check && !settled) log.warn('scripted: variants could not be checked', { ensemble: ens.id, issues: describe(check.errors) });
      parts.forEach((part, i) => {
        const ok = settled && check!.parts[i]!.ok;
        if (settled) verdicts.set(codeKey(part.code, part.knobs), ok);
        if (!ok) passed.get(candidates[i]!.part.id)!.delete(candidates[i]!.variant);
      });
    }
    return new Map([...passed].map(([id, set]) => [id, ['base' as Variant, ...set]]));
  };

  const started = Date.now();
  const candidates = opts.library ?? LIBRARY;
  const results = (await mapLimited(candidates, VALIDATION_CONCURRENCY, validate)).filter((r): r is NonNullable<typeof r> => r !== null);
  if (!results.length) throw new Error('scripted: no library ensemble passed validation; the autopilot has nothing to play');
  const lib: AutopilotLibrary = {
    ensembles: results.map((r) => r.ens),
    sounds: new Map(results.map((r) => [r.ens.id, r.sounds])),
    variants: new Map(results.map((r) => [r.ens.id, r.variants])),
  };
  log.info('scripted: library ready', {
    ensembles: lib.ensembles.length,
    of: candidates.length,
    synthOnly,
    variants: results.reduce((a, r) => a + [...r.variants.values()].reduce((b, v) => b + v.length - 1, 0), 0),
    ms: Date.now() - started,
  });
  return { lib, verdicts };
}

export async function createScriptedComposer(opts: ScriptedOptions): Promise<ScriptedComposer> {
  const { checker, log } = opts;
  const { lib, verdicts } = await validateLibrary(opts);

  /**
   * Checks a candidate's fresh part code the boot run hasn't seen (another key), caching verdicts.
   * When the checker itself fails (timeout, busy, a crash) nothing is cached and the candidate goes
   * ahead: the conductor checks every commit anyway.
   */
  const precheck = async (plan: Plan, signal: AbortSignal): Promise<boolean> => {
    for (const s of plan.sections) {
      const fresh = s.parts.filter((p) => p.code !== null && !verdicts.has(codeKey(p.code, p.knobs)));
      if (!fresh.length) continue;
      const parts = fresh.map((p) => ({ id: p.id, role: p.role, code: p.code!, knobs: p.knobs, chromatic: p.chromatic, level: p.level, enterBar: 0, exitBar: null, patternBarAtStart: 0 }));
      try {
        const check = await checker.checkSection({ parts, bpm: s.bpm, scale: s.scale, bars: s.bars, vampLoopBars: vampLoopFor(s.bars) }, { priority: 'audition', signal });
        if (!inconclusive(check)) check.parts.forEach((p, i) => verdicts.set(codeKey(parts[i]!.code, parts[i]!.knobs), p.ok));
      } catch {
        return !signal.aborted;
      }
    }
    return plan.sections.every((s) => s.parts.every((p) => p.code === null || verdicts.get(codeKey(p.code, p.knobs)) !== false));
  };

  return {
    driver: 'scripted',

    fallbackPlan(context: TurnContext): Plan {
      return planCandidates(lib, context, 'fallback')[0]!.plan;
    },

    async compose(request: PlanRequest, tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome> {
      let attempts = 0;
      let reason = 'no candidate plan';
      for (const candidate of planCandidates(lib, request.context, 'compose')) {
        if (attempts >= MAX_COMPOSE_ATTEMPTS) break;
        if (signal.aborted) return { status: 'failed', reason: `aborted: ${String(signal.reason ?? 'signal')}`, attempts };
        if (!(await precheck(candidate.plan, signal))) {
          reason = 'a candidate failed its pre-check';
          continue;
        }
        attempts++;
        const result = await tools.commit(candidate.plan);
        if (result.accepted) return { status: 'committed', result, attempts };
        reason = describe(result.errors).join('; ') || 'rejected';
        if (result.errors.some((e) => e.rule === 'request-closed')) break;
        log.warn('scripted: plan rejected, trying the next candidate', { request: request.id, kind: candidate.kind, errors: describe(result.errors) });
      }
      return { status: 'failed', reason, attempts };
    },
  };
}
