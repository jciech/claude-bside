// A stand-in Engine for the Lathe harness: a synthetic side shaped like test/fixtures/snapshot.json
// (same movement and voice roles, extended to intro → groove → build → drop → breakdown → …), events
// generated deterministically per part, on a clock that is this page's epoch time. It emits haps
// ahead of time on a 50 ms tick like the real SyncedScheduler, section starts, meters and health.
import type { Engine, EngineEvents, EngineState, Meters, VisualEvent } from '../../../src/client/engine/types.ts';
import { ROLE_FAMILY, type PartRole, type SectionRole } from '../../../src/shared/music.ts';
import type { MovementInfo, SectionProgram } from '../../../src/shared/program.ts';
import type { SideSection } from '../../../src/client/render/protocol.ts';

type Pattern = (bar: number, barInSection: number, sectionBars: number) => { at: number; dur: number; midi: number | null; gain: number }[];

interface FakePart {
  id: string;
  role: PartRole;
  level: number;
  enter?: number;
  pattern: Pattern;
}

interface FakeSection {
  id: string;
  name: string;
  role: SectionRole;
  startCycle: number;
  bars: number;
  parts: FakePart[];
}

const hash = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const deg = (root: number, d: number) => root + 12 * Math.floor(d / 7) + DORIAN[((d % 7) + 7) % 7]!;
const PROGRESSION = [0, 3, 5, 2];

const every = (n: number, gain: number | ((i: number) => number), dur = 0.1): Pattern => () =>
  Array.from({ length: n }, (_, i) => ({ at: i / n, dur, midi: null, gain: typeof gain === 'number' ? gain : gain(i) }));

const parts = {
  kick: { id: 'kick', role: 'kick', level: 0.9, pattern: every(4, 0.9, 0.2) },
  kickDrop: {
    id: 'kick',
    role: 'kick',
    level: 0.95,
    pattern: (bar) => [...every(4, 0.95, 0.2)(bar, 0, 0), ...(bar % 2 ? [{ at: 0.875, dur: 0.1, midi: null, gain: 0.6 }] : [])],
  },
  snare: { id: 'snare', role: 'snare', level: 0.7, pattern: () => [0.25, 0.75].map((at) => ({ at, dur: 0.1, midi: null, gain: 0.7 })) },
  roll: {
    id: 'snare',
    role: 'snare',
    level: 0.7,
    pattern: (_bar, k, bars) => {
      const n = [2, 4, 8, 16][Math.min(3, Math.floor((k / bars) * 4))]!;
      return Array.from({ length: n }, (_, i) => ({ at: i / n, dur: 0.05, midi: null, gain: 0.35 + 0.5 * ((k * n + i) / (bars * n)) }));
    },
  },
  hats8: { id: 'hats', role: 'hats', level: 0.6, enter: 4, pattern: every(8, (i) => (i % 2 ? 0.2 : 0.35), 0.05) },
  hats16: { id: 'hats', role: 'hats', level: 0.6, pattern: every(16, (i) => [0.3, 0.12, 0.2, 0.12][i % 4]!, 0.03) },
  bass: {
    id: 'bass',
    role: 'bass',
    level: 0.7,
    enter: 8,
    pattern: (bar) => [0, 0.375, 0.5].map((at, i) => ({ at, dur: i === 2 ? 0.45 : 0.3, midi: deg(38, PROGRESSION[bar % 4]! + (i === 1 ? 4 : 0)), gain: 0.7 })),
  },
  bass8: {
    id: 'bass',
    role: 'bass',
    level: 0.75,
    pattern: (bar) => Array.from({ length: 8 }, (_, i) => ({ at: i / 8, dur: 0.1, midi: deg(38, PROGRESSION[bar % 4]! + (i % 3 === 2 ? 7 : 0)), gain: 0.75 })),
  },
  pad: {
    id: 'pad',
    role: 'pad',
    level: 0.5,
    pattern: (bar) => [0, 2, 4].map((d) => ({ at: 0, dur: 1, midi: deg(50, PROGRESSION[bar % 4]! + d), gain: 0.45 })),
  },
  chords: {
    id: 'chords',
    role: 'chords',
    level: 0.55,
    pattern: (bar) => [0.375, 0.875].flatMap((at) => [0, 2, 4, 6].map((d) => ({ at, dur: 0.1, midi: deg(62, PROGRESSION[bar % 4]! + d), gain: 0.5 }))),
  },
  arp: {
    id: 'arp',
    role: 'arp',
    level: 0.5,
    pattern: (bar) => Array.from({ length: 16 }, (_, i) => ({ at: i / 16, dur: 0.05, midi: deg(62, PROGRESSION[bar % 4]! + [0, 2, 4, 7][i % 4]!), gain: 0.4 })),
  },
  lead: {
    id: 'lead',
    role: 'lead',
    level: 0.55,
    enter: 8,
    pattern: (bar) =>
      [0, 2, 4, 7, 4, 5, 3, 1].flatMap((d, i) =>
        hash(bar, i) < 0.35 ? [] : [{ at: i / 8, dur: 0.1, midi: deg(62, d + (bar % 2 ? 2 : 0)), gain: 0.55 }],
      ),
  },
  texture: {
    id: 'texture',
    role: 'texture',
    level: 0.4,
    pattern: (bar) => Array.from({ length: 6 }, (_, i) => ({ at: hash(bar, i), dur: 0.05, midi: null, gain: 0.3 + 0.3 * hash(i, bar) })),
  },
} satisfies Record<string, FakePart>;

const P = parts;
export const SECTIONS: FakeSection[] = [
  { id: 'fx01-0001', name: 'First Light', role: 'intro', startCycle: 0, bars: 16, parts: [P.pad, P.hats8, P.bass, { ...P.kick, enter: 12 }] },
  { id: 'fx01-0002', name: 'Glass Harbour', role: 'groove', startCycle: 16, bars: 16, parts: [P.kick, P.hats16, P.bass, P.pad, P.lead] },
  { id: 'fx01-0003', name: 'Undertow', role: 'build', startCycle: 32, bars: 8, parts: [P.kick, P.roll, P.hats16, P.bass8, P.arp, P.texture] },
  { id: 'fx01-0004', name: 'Salt Flats', role: 'drop', startCycle: 40, bars: 16, parts: [P.kickDrop, P.snare, P.hats16, P.bass8, P.chords, P.lead, P.pad] },
  { id: 'fx01-0005', name: 'Low Tide', role: 'breakdown', startCycle: 56, bars: 8, parts: [P.pad, P.chords, P.texture] },
  { id: 'fx01-0006', name: 'Return', role: 'groove', startCycle: 64, bars: 16, parts: [P.kick, P.snare, P.hats16, P.bass, P.pad, P.lead, P.chords] },
  { id: 'fx01-0007', name: 'Second Wind', role: 'build', startCycle: 80, bars: 8, parts: [P.kick, P.roll, P.hats16, P.bass8, P.arp] },
  { id: 'fx01-0008', name: 'High Water', role: 'drop', startCycle: 88, bars: 16, parts: [P.kickDrop, P.snare, P.hats16, P.bass8, P.chords, P.lead, P.arp] },
  { id: 'fx01-0009', name: 'Last Light', role: 'outro', startCycle: 104, bars: 16, parts: [P.pad, P.chords, P.texture] },
];

export const MOVEMENT: MovementInfo = {
  id: 'fx01-m1',
  side: 2,
  name: 'Harbour Lights',
  bpm: 120,
  scale: 'D:dorian',
  groove: 'four-on-floor',
  arcShape: 'wave',
  blurb: 'A slow tide of D dorian, synth-only.',
  startCycle: 0,
  plannedBars: 128,
  tracks: [],
};

export function sideSections(): SideSection[] {
  return SECTIONS.map((s) => ({ id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: s.bars, provisional: false }));
}

function sectionAtCycle(cycle: number): FakeSection | null {
  let found: FakeSection | null = null;
  for (const s of SECTIONS) if (s.startCycle <= cycle && cycle < s.startCycle + s.bars) found = s;
  return found;
}

function eventsIn(from: number, to: number): VisualEvent[] {
  const out: VisualEvent[] = [];
  for (let bar = Math.floor(from); bar < to; bar++) {
    const s = sectionAtCycle(bar);
    if (!s) continue;
    const k = bar - s.startCycle;
    for (const p of s.parts) {
      if (k < (p.enter ?? 0)) continue;
      for (const n of p.pattern(bar, k, s.bars)) {
        const cycle = bar + n.at;
        if (cycle < from || cycle >= to) continue;
        out.push({
          sectionId: s.id,
          partId: p.id,
          instance: `${s.id}:${p.id}`,
          role: p.role,
          family: ROLE_FAMILY[p.role],
          cycle,
          duration: n.dur,
          midi: n.midi,
          gain: n.gain * p.level,
          pan: 0.5,
          sound: p.id,
          locations: [],
        });
      }
    }
  }
  return out.sort((a, b) => a.cycle - b.cycle);
}

export interface FakeEngineOptions {
  /** Cycle at page time `t0Ms` (epoch ms). */
  startCycle: number;
  t0Ms: number;
  cps: number;
  running: boolean;
}

export class FakeEngine implements Engine {
  state: EngineState;
  private readonly o: FakeEngineOptions;
  private readonly listeners: { [E in keyof EngineEvents]: Set<EngineEvents[E]> } = {
    state: new Set(),
    hap: new Set(),
    partError: new Set(),
    sectionStart: new Set(),
    preload: new Set(),
    health: new Set(),
    needsGesture: new Set(),
  };
  private handedTo: number;
  private lastNow: number;
  private lastHealth = 0;

  constructor(options: FakeEngineOptions) {
    this.o = options;
    this.state = options.running ? 'running' : 'ready';
    this.handedTo = options.startCycle;
    this.lastNow = options.startCycle;
    setInterval(() => this.tick(), 50);
  }

  private epoch(): number {
    return performance.timeOrigin + performance.now();
  }

  private tick(): void {
    const now = this.now();
    for (const s of SECTIONS) if (s.startCycle > this.lastNow && s.startCycle <= now) this.emit('sectionStart', s.id);
    this.lastNow = now;
    if (this.state === 'running') {
      const horizon = now + 0.25 * this.o.cps;
      for (const e of eventsIn(this.handedTo, horizon)) this.emit('hap', e, (e.cycle - now) / this.o.cps);
      this.handedTo = Math.max(this.handedTo, horizon);
    }
    if (performance.now() - this.lastHealth > 1000) {
      this.lastHealth = performance.now();
      this.emit('health', { skips: 0, lateMs: 0, droppedHaps: 0 });
    }
  }

  private emit<E extends keyof EngineEvents>(event: E, ...args: Parameters<EngineEvents[E]>): void {
    for (const l of this.listeners[event] as Set<(...a: unknown[]) => void>) l(...args);
  }

  now(): number {
    return this.o.startCycle + ((this.epoch() - this.o.t0Ms) / 1000) * this.o.cps;
  }
  cps(): number {
    return this.o.cps;
  }
  query(fromCycle: number, toCycle: number): VisualEvent[] {
    return eventsIn(fromCycle, toCycle);
  }
  sectionAt(cycle: number): SectionProgram | null {
    const s = sectionAtCycle(cycle);
    return s ? (this.program(s) as SectionProgram) : null;
  }
  sections(): SectionProgram[] {
    return SECTIONS.map((s) => this.program(s) as SectionProgram);
  }
  private program(s: FakeSection): Pick<SectionProgram, 'id' | 'name' | 'role' | 'startCycle' | 'bars'> {
    return { id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: s.bars as SectionProgram['bars'] };
  }
  meters(): Meters {
    const now = this.now();
    const s = sectionAtCycle(now);
    const parts: Record<string, number> = {};
    for (const p of s?.parts ?? []) parts[`${s!.id}:${p.id}`] = Math.min(1, p.level * (0.75 + 0.25 * Math.sin(now * 6.28 + p.level * 9)));
    const loud = s?.role === 'drop' ? -11 : s?.role === 'breakdown' ? -24 : -16;
    return { master: { rmsDb: s ? loud + 2 * Math.sin(now * 12.57) : -120, peakDb: s ? loud + 8 : -120 }, parts };
  }
  on<E extends keyof EngineEvents>(event: E, listener: EngineEvents[E]): () => void {
    this.listeners[event].add(listener);
    return () => this.listeners[event].delete(listener);
  }

  // Unused by the renderer.
  async prepare(): Promise<void> {}
  async unlock(): Promise<void> {}
  suspend(): void {}
  applySnapshot(): void {}
  applySchedule(): void {}
  onResyncNeeded(): () => void {
    return () => {};
  }
  setMixer(): void {}
  activeLocations(): Map<string, { start: number; end: number }[]> {
    return new Map();
  }
  preloadProgress(): { loaded: number; total: number } {
    return { loaded: 0, total: 0 };
  }
  setVolume(): void {}
  setLocalMute(): void {}
  telemetry(): ReturnType<Engine['telemetry']> {
    return { cycle: this.now(), rmsDb: -120, peakDb: -120, centroidHz: 0, clipPct: 0, errors: [], preloadFailed: [] };
  }
  analyser(): AnalyserNode | null {
    return null;
  }
}
