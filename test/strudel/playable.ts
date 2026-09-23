// Part code the room plays: every autopilot template in every variant (and the build riser), the
// composer's reference-card examples, the fixture snapshot's parts and the validator's idiomatic
// corpus. Used to calibrate the query budget and to check that the static density bound accepts real
// music.
import { readFileSync } from 'node:fs';
import * as core from '@strudel/core';
import { riserCode } from '../../src/server/composer/arrange.ts';
import { LIBRARY } from '../../src/server/composer/library/index.ts';
import { fillScale } from '../../src/server/composer/library/scale.ts';
import { CARD_EXAMPLES } from '../../src/server/composer/prompt/strudel.ts';
import { partVariants } from '../../src/server/composer/variants.ts';
import type { Knob } from '../../src/shared/plan.ts';
import { compilePart } from '../../src/strudel/compile.ts';
import { LEGIT } from './corpus.ts';

export interface Playable {
  name: string;
  code: string;
  knobs: Knob[];
}

const fixtureParts = (): Playable[] => {
  const snapshot = JSON.parse(readFileSync(new URL('../fixtures/snapshot.json', import.meta.url), 'utf8')) as {
    sections: { id: string; parts: { id: string; code: string; knobs: Knob[] }[] }[];
  };
  return snapshot.sections.flatMap((s) => s.parts.map((p) => ({ name: `fixture ${s.id}.${p.id}`, code: p.code, knobs: p.knobs })));
};

/** Distinct codes only (the scale variants of one template cost the same to query). */
export function playableParts(): Playable[] {
  const all: Playable[] = [];
  for (const ens of LIBRARY) {
    for (const p of ens.parts) {
      for (const v of partVariants(p)) {
        all.push({ name: `${ens.id}.${p.id} (${v.variant})`, code: fillScale(v.code, `${ens.tonic}:${ens.modes[0]}`), knobs: p.knobs ?? [] });
      }
    }
  }
  for (const bars of [4, 8, 16, 32]) all.push({ name: `riser over ${bars} bars`, code: riserCode(bars), knobs: [] });
  CARD_EXAMPLES.forEach((ex, i) => all.push({ name: `reference card #${i}`, code: ex.code, knobs: (ex.knobs ?? []).map((k) => ({ ...k, follows: 'brightness' })) }));
  all.push(...fixtureParts());
  LEGIT.forEach((code, i) => all.push({ name: `legit #${i}`, code, knobs: [{ name: 'cut', default: 800, min: 200, max: 4000, follows: 'brightness' }] }));
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.code) && seen.add(p.code));
}

/** The part as the performer queries it: knobs at their defaults, values sanitised, seeded and shifted to its origin. */
export function compilePlayable(p: Playable, origin = 0): any {
  const defaults = new Map(p.knobs.map((k) => [k.name, k.default]));
  const { pattern } = compilePart(p.code, { knob: (name) => core.signal(() => defaults.get(name) ?? 0) });
  return pattern.withValue((v: unknown) => v).seed(origin).late(origin);
}
