import { describe, expect, it } from 'vitest';
import { MockScore, SIDE_FORM } from '../../src/client/room/mock-score.ts';
import { buildScore } from '../../src/client/engine/score.ts';
import { validatePart } from '../../src/strudel/validate.ts';
import { plannedPlayBars } from '../../src/shared/schedule.ts';
import { snapshot } from '../engine/fixtures.ts';

function composed(n: number): MockScore {
  const score = new MockScore(snapshot);
  for (let i = 0; i < n; i++) score.append();
  return score;
}

describe('mock score', () => {
  it('places tracks back to back with fresh ids and sides', () => {
    const score = composed(SIDE_FORM.length + 2);
    const s = score.sections;
    for (let i = 1; i < s.length; i++) expect(s[i]!.startCycle).toBe(s[i - 1]!.startCycle + plannedPlayBars(s[i - 1]!));
    expect(new Set(s.map((x) => x.id)).size).toBe(s.length);
    expect(score.movements.map((m) => m.side)).toEqual([1, 2]);
    expect(s[SIDE_FORM.length]!.movementId).toBe('mock-m2');
    expect(s[SIDE_FORM.length]!.track).toBe(1);
  });

  it('follows the conductor rules for carried parts and orbits', () => {
    const s = composed(12).sections;
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1]!;
      const orbits = new Set<number>();
      for (const part of s[i]!.parts) {
        expect(orbits.has(part.orbit)).toBe(false);
        orbits.add(part.orbit);
        const before = prev.parts.find((p) => p.id === part.id);
        if (part.continues) {
          expect(before?.code).toBe(part.code);
          expect(part.orbit).toBe(before!.orbit);
          expect(part.originCycle).toBe(before!.originCycle);
        } else {
          // A fresh or rewritten instance never shares an orbit with anything still ringing out.
          expect(prev.parts.some((p) => p.orbit === part.orbit)).toBe(false);
          expect(part.originCycle).toBe(s[i]!.startCycle);
        }
      }
    }
  });

  it('only uses code the allowlist accepts', () => {
    for (const section of composed(SIDE_FORM.length).sections) {
      for (const part of section.parts) expect(validatePart(part.code, { knobs: part.knobs.map((k) => k.name) }).errors).toEqual([]);
    }
  });

  it('the engine accepts the schedule (one instance per part, continuing where declared)', () => {
    const sections = composed(8).sections;
    const score = buildScore(sections, new Map());
    const continuing = score.instances.filter((x) => x.continuing).length;
    expect(continuing).toBe(sections.reduce((n, s) => n + s.parts.filter((p) => p.continues).length, 0));
  });

  it('Stay moves every later track and keeps continuing parts anchored', () => {
    const score = composed(4);
    const groove = score.sections[1]!;
    const after = score.sections.slice(2).map((s) => s.startCycle);
    const changed = score.jump(groove.id, { atBar: 24, toBar: 16 });
    expect(changed).toHaveLength(3);
    expect(score.sections.slice(2).map((s) => s.startCycle)).toEqual(after.map((c) => c + 8));
    for (let i = 2; i < score.sections.length; i++) {
      for (const p of score.sections[i]!.parts.filter((x) => x.continues)) {
        expect(p.originCycle).toBe(score.sections[i - 1]!.parts.find((q) => q.id === p.id)!.originCycle);
      }
    }
  });

  it('reports played tracks per side for late joiners', () => {
    const score = composed(4);
    const m = score.movementsAt(50)[0]!;
    expect(m.tracks.map((t) => t.name)).toEqual([score.sections[0]!.name, score.sections[1]!.name]);
  });
});
