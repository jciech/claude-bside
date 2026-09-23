// Section builders for engine tests, based on test/fixtures/snapshot.json.
import { readFileSync } from 'node:fs';
import type { RoomSnapshot } from '../../src/shared/protocol.ts';
import type { ProgramPart, SectionProgram } from '../../src/shared/program.ts';

export const snapshot: RoomSnapshot = JSON.parse(readFileSync(new URL('../fixtures/snapshot.json', import.meta.url), 'utf8'));

export const [sectionA, sectionB] = snapshot.sections as [SectionProgram, SectionProgram];

export function part(overrides: Partial<ProgramPart> & { id: string }): ProgramPart {
  return {
    role: 'lead',
    code: 'note("c4")',
    orbit: 1,
    level: 1,
    enterBar: 0,
    exitBar: null,
    knobs: [],
    automation: [],
    duck: null,
    originCycle: 0,
    continues: false,
    carried: false,
    chromatic: false,
    instrument: 'x',
    digest: null,
    ...overrides,
  };
}

export function section(overrides: Partial<SectionProgram> & { id: string; startCycle: number; parts: ProgramPart[] }): SectionProgram {
  return {
    ...sectionA,
    rev: 1,
    bars: 16,
    jumps: [],
    vamp: { allowed: true, loopBars: 8 },
    transitionIn: { type: 'cut', bars: 0 },
    ...overrides,
  };
}
