// Builders for composer tests: complete TurnContexts, section summaries as the conductor would
// report them, and a log that records lines.
import { readFileSync } from 'node:fs';
import type { Catalog } from '../../src/shared/catalog.ts';
import type { CrowdSummary, SectionSummary, TurnContext } from '../../src/shared/composer-api.ts';
import type { SectionRole } from '../../src/shared/music.ts';
import type { PartPlan, SectionPlan } from '../../src/shared/plan.ts';
import type { Logger } from '../../src/server/types.ts';

export const smallCatalog: Catalog = JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'));
export const fullCatalog: Catalog = JSON.parse(readFileSync(new URL('../../palette/catalog.json', import.meta.url), 'utf8'));

export interface MemoryLog extends Logger {
  lines: { level: string; msg: string; data?: Record<string, unknown> }[];
}

export function memoryLog(): MemoryLog {
  const lines: MemoryLog['lines'] = [];
  const at = (level: string) => (msg: string, data?: Record<string, unknown>) => void lines.push({ level, msg, data });
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

const flat = (v: number) => ({ start: v, end: v });

export function crowd(over: Partial<CrowdSummary> = {}): CrowdSummary {
  const reaction = { perListenerPerMin: 0, z: 0 };
  return {
    listeners: 3,
    pad: { brightness: 0.5, intensity: 0.5, turnout: 0.3, consensus: 0.6, effectiveVoices: 2, split: null },
    pressure: { brightness: 0, intensity: 0 },
    keepVsMoveOn: 0,
    reactions: { fire: reaction, vibe: reaction, bored: reaction, harsh: reaction },
    requests: [],
    promises: [],
    forkResult: null,
    ...over,
  };
}

/**
 * A SectionSummary of a planned section, as the conductor would report it once committed: carried
 * parts show the code they carry (from `prev`), knobs end at their automation's last value.
 */
export function summarize(section: SectionPlan, id: string, startCycle: number, prev: SectionSummary | null = null): SectionSummary {
  return {
    id,
    name: section.name,
    role: section.role,
    startCycle,
    bars: section.bars,
    bpm: section.bpm,
    scale: section.scale,
    chords: section.chords,
    provisional: false,
    targets: section.targets,
    measured: section.targets,
    parts: section.parts.map((p: PartPlan) => {
      const carried = p.code === null ? prev?.parts.find((q) => q.id === p.id) : undefined;
      const knobs = carried ? carried.knobs : p.knobs;
      const values: Record<string, number> = {};
      for (const k of knobs) {
        const lanes = p.automation.filter((a) => a.target === `knob:${k.name}`).sort((a, b) => a.toBar - b.toBar);
        values[k.name] = lanes.length ? lanes[lanes.length - 1]!.to : (carried?.knobValuesAtEnd[k.name] ?? k.default);
      }
      return {
        id: p.id,
        role: p.role,
        instrument: 'test',
        evPerBar: 4,
        register: null,
        sync: 0,
        bright: 0.5,
        loud: 0.5,
        period: 1,
        keyFit: 1,
        code: p.code ?? carried?.code ?? 's("sbd")',
        level: p.level,
        enterBar: p.enterBar,
        exitBar: p.exitBar,
        knobs,
        knobValuesAtEnd: values,
        duck: p.duck,
        chromatic: p.chromatic,
        patternBarAtEnd: section.bars,
      };
    }),
  };
}

export interface ContextOptions {
  kind?: 'section' | 'movement';
  sectionsWanted?: 1 | 2;
  now?: SectionSummary | null;
  committed?: SectionSummary[];
  movement?: TurnContext['movement'];
  expected?: SectionRole[];
  history?: { id: string; name: string; role?: SectionRole }[];
  crowd?: Partial<CrowdSummary>;
  vamping?: boolean;
  id?: string;
}

export function turnContext(o: ContextOptions = {}): TurnContext {
  const now = o.now ?? null;
  const committed = o.committed ?? [];
  const tail = committed[committed.length - 1] ?? now;
  const start = tail ? tail.startCycle + tail.bars : 4;
  return {
    request: {
      id: o.id ?? 'ep1-r1',
      kind: o.kind ?? 'section',
      reasons: ['horizon'],
      softDeadlineSec: 40,
      hardDeadlineSec: 60,
      sectionsWanted: o.sectionsWanted ?? 1,
      startCycle: start,
      replaces: [],
      vamping: o.vamping ?? false,
      scheduleRev: 3,
    },
    clock: { cycle: Math.max(0, start - 8), bpm: tail?.bpm ?? 120, secondsPerBar: 240 / (tail?.bpm ?? 120) },
    movement: o.movement === undefined ? null : o.movement,
    now: now ? { ...now, barsLeft: 4 } : null,
    committed,
    expected: (o.expected ?? []).map((role, i) => ({ role, startCycle: start + i * 16, targets: { intensity: flat(0.5), brightness: flat(0.5) }, notes: [] })),
    crowd: crowd(o.crowd),
    memory: { lastRationale: null, movementIntent: null, form: [], motifs: [] },
    history: {
      sections: (o.history ?? []).map((h) => ({ id: h.id, name: h.name, role: h.role ?? 'groove', bpm: tail?.bpm ?? 120, scale: tail?.scale ?? 'C:minor', sounds: [], intensity: 0.5, fireZ: 0, keep: 0 })),
      lovedMoments: [],
      repriseCandidates: [],
      recentScales: [],
    },
    novelty: { cooldown: [], flags: [], crate: [] },
    health: { lastPlan: null, clientErrors: [], notes: [] },
    rules: {
      bpm: [60, 180],
      maxBpmDeltaInMovement: 4,
      sectionLengths: [8, 16, 24, 32, 48, 64],
      maxParts: 8,
      minPlanBars: 30,
      maxPlanBars: 50,
      forkAllowed: false,
      budget: { peakSecLast10Min: 0, peakSecAllowedNow: 180, floorSecLast10Min: 0, floorSecAllowedNow: 240, lastRoles: [] },
    },
  };
}

export function movementOf(name: string, bpm: number, scale: string): NonNullable<TurnContext['movement']> {
  return {
    id: 'ep1-m1',
    name,
    ageMin: 3,
    bpm,
    scale,
    groove: 'four-on-floor',
    arcShape: 'wave',
    baseline: { intensity: 0.5, brightness: 0.5 },
    progress: 0.3,
    signature: [],
    palette: [],
  };
}
