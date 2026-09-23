// Audition = a section check of loose parts: all playing from bar 0 at full level.
import type { SectionCheck } from '../../shared/analysis.ts';
import type { AuditionInput, AuditionResult } from '../../shared/composer-api.ts';
import { DEFAULT_BPM } from '../../shared/music.ts';
import type { CheckSectionInput } from '../types.ts';

export const AUDITION_DEFAULT_BARS = 16;

export function auditionToSection(input: AuditionInput): CheckSectionInput {
  return {
    parts: input.parts.map((p) => ({
      id: p.id,
      role: p.role,
      code: p.code,
      knobs: p.knobs,
      chromatic: p.chromatic,
      level: 1,
      enterBar: 0,
      exitBar: null,
      patternBarAtStart: 0,
    })),
    bpm: input.bpm ?? DEFAULT_BPM,
    scale: input.scale,
    bars: input.bars ?? AUDITION_DEFAULT_BARS,
  };
}

export function sectionToAudition(input: AuditionInput, check: SectionCheck): AuditionResult {
  const parts = check.parts.map((p, i) => ({
    id: p.id,
    role: input.parts[i]?.role ?? 'texture',
    ok: p.ok,
    errors: p.errors,
    warnings: p.warnings,
    analysis: p.analysis,
    digest: p.digest,
  }));
  return {
    ok: check.errors.length === 0 && parts.every((p) => p.ok),
    errors: check.errors,
    warnings: check.warnings,
    parts,
    mix: check.mix,
    descriptors: check.mix?.descriptors ?? null,
  };
}
