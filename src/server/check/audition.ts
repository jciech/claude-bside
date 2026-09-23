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

/**
 * AuditionResult has no section-level issue list, so section issues (mix density, an invalid scale,
 * timeout, busy) are reported on the first part with their own `path`.
 */
export function sectionToAudition(input: AuditionInput, check: SectionCheck): AuditionResult {
  return {
    parts: check.parts.map((p, i) => {
      const errors = i === 0 ? [...p.errors, ...check.errors] : p.errors;
      const warnings = i === 0 ? [...p.warnings, ...check.warnings] : p.warnings;
      return {
        id: p.id,
        role: input.parts[i]?.role ?? 'texture',
        ok: p.ok && errors.length === 0,
        errors,
        warnings,
        analysis: p.analysis,
        digest: p.digest,
      };
    }),
    mix: check.mix,
    descriptors: check.mix?.descriptors ?? null,
  };
}
