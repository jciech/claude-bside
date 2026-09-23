// The mock room's endless schedule: sides of tracks built from the fixture's two sections
// (test/fixtures/snapshot.json), placed back to back with fresh ids and the conductor's rules for
// carried parts — same code continues on its orbit with its origin; anything else gets a fresh
// orbit — so the real engine performs it exactly as it would a server schedule. Pure.
import type { SectionRole, Span, TransitionType } from '../../shared/music.ts';
import type { MovementInfo, ProgramPart, SectionProgram } from '../../shared/program.ts';
import type { RoomSnapshot } from '../../shared/protocol.ts';
import { plannedPlayBars, type Jump } from '../../shared/schedule.ts';

export type TemplateKey = 'intro' | 'groove' | 'build' | 'drop' | 'breakdown';

interface PartSpec {
  from: 0 | 1;
  id: string;
  enterBar?: number;
  exitBar?: number | null;
  level?: number;
}

interface Template {
  role: SectionRole;
  bars: 16 | 32;
  transition: { type: TransitionType; bars: number };
  vamp: boolean;
  intensity: Span;
  brightness: Span;
  parts: PartSpec[];
}

const TEMPLATES: Record<TemplateKey, Template> = {
  intro: {
    role: 'intro',
    bars: 16,
    transition: { type: 'cut', bars: 0 },
    vamp: false,
    intensity: { start: 0.2, end: 0.42 },
    brightness: { start: 0.35, end: 0.48 },
    parts: [{ from: 0, id: 'kick' }, { from: 0, id: 'hats' }, { from: 0, id: 'bass' }, { from: 0, id: 'pad' }],
  },
  groove: {
    role: 'groove',
    bars: 32,
    transition: { type: 'crossfade', bars: 2 },
    vamp: true,
    intensity: { start: 0.52, end: 0.62 },
    brightness: { start: 0.5, end: 0.58 },
    parts: [{ from: 1, id: 'kick' }, { from: 1, id: 'hats' }, { from: 1, id: 'bass' }, { from: 1, id: 'lead' }, { from: 1, id: 'fill' }],
  },
  build: {
    role: 'build',
    bars: 16,
    transition: { type: 'crossfade', bars: 2 },
    vamp: false,
    intensity: { start: 0.45, end: 0.82 },
    brightness: { start: 0.45, end: 0.7 },
    parts: [{ from: 1, id: 'kick' }, { from: 1, id: 'hats', enterBar: 4 }, { from: 1, id: 'bass' }, { from: 0, id: 'pad' }],
  },
  drop: {
    role: 'drop',
    bars: 32,
    transition: { type: 'riser', bars: 4 },
    vamp: true,
    intensity: { start: 0.82, end: 0.86 },
    brightness: { start: 0.66, end: 0.7 },
    parts: [{ from: 1, id: 'kick' }, { from: 1, id: 'hats' }, { from: 1, id: 'bass', level: 0.8 }, { from: 1, id: 'lead', enterBar: 0 }, { from: 0, id: 'pad', level: 0.35 }],
  },
  breakdown: {
    role: 'breakdown',
    bars: 16,
    transition: { type: 'filter', bars: 2 },
    vamp: true,
    intensity: { start: 0.3, end: 0.26 },
    brightness: { start: 0.42, end: 0.36 },
    parts: [{ from: 0, id: 'pad', level: 0.6 }, { from: 0, id: 'bass', enterBar: 4 }, { from: 1, id: 'lead', enterBar: 8, level: 0.4 }],
  },
};

/** One side of the record. */
export const SIDE_FORM: readonly TemplateKey[] = ['intro', 'groove', 'build', 'drop', 'breakdown', 'groove'];

const SIDE_NAMES = ['Harbour Lights', 'Paper Moons', 'Slow Signals', 'Night Ferry'];
const TRACK_NAMES = [
  'First Light', 'Glass Harbour', 'Undertow', 'Salt Flats', 'Low Tide', 'Lanterns',
  'Breakwater', 'Drift Net', 'Tin Roof Rain', 'Moth Hours', 'Quiet Engine', 'Blue Hour',
];
const NOTES: Record<TemplateKey, string[]> = {
  intro: [
    'Starting from the floor up: a soft kick, a pad breathing in, the bass creeping up at bar 8.',
    'New side. Just a pulse and a chord for now — everything else has to earn its way in.',
  ],
  groove: [
    'Into the groove: the hats double up, and a square-wave melody arrives at bar 8.',
    'Settling in. The bass keeps its line from before so the ground doesn’t move under you.',
  ],
  build: [
    'Pulling the hats back in one by one. Something is coming — you’ll hear the filter lean forward.',
    'Tightening the screw: the pad rises while the kick holds steady.',
  ],
  drop: [
    'There it is. Everything at once, the lead front and centre.',
    'The riser pays off: full kit, the melody doubled by the room’s pull toward brighter.',
  ],
  breakdown: [
    'Letting the floor go. Just the pad and a bass that barely moves — space to breathe.',
    'Stripping it to the bones for a moment. The melody comes back quieter at bar 8.',
  ],
};

export interface MockTrack {
  section: SectionProgram;
  /** A new side starts with this track. */
  movement: MovementInfo | null;
}

export class MockScore {
  readonly sections: SectionProgram[] = [];
  readonly movements: MovementInfo[] = [];
  private readonly fixture: RoomSnapshot;
  private seq = 0;
  private formIndex = 0;

  constructor(fixture: RoomSnapshot) {
    this.fixture = fixture;
  }

  get last(): SectionProgram | null {
    return this.sections[this.sections.length - 1] ?? null;
  }

  /** Where the last track ends as planned (its start plus its play length). */
  endCycle(): number {
    const last = this.last;
    return last ? last.startCycle + plannedPlayBars(last) : 0;
  }

  /** Composes the next track, placed right after the last one. */
  append(): MockTrack {
    const key = SIDE_FORM[this.formIndex % SIDE_FORM.length]!;
    const newSide = this.formIndex % SIDE_FORM.length === 0;
    const sideNo = Math.floor(this.formIndex / SIDE_FORM.length) + 1;
    this.formIndex++;
    const t = TEMPLATES[key];
    const startCycle = this.endCycle();
    const prev = this.last;
    this.seq++;
    const id = `mock-${String(this.seq).padStart(4, '0')}`;

    let movement: MovementInfo | null = null;
    if (newSide) {
      movement = {
        id: `mock-m${sideNo}`,
        side: sideNo,
        name: SIDE_NAMES[(sideNo - 1) % SIDE_NAMES.length]!,
        bpm: 120,
        scale: 'D:dorian',
        groove: 'four-on-floor',
        arcShape: 'wave',
        blurb: 'A slow tide of D dorian, synth-only.',
        startCycle,
        plannedBars: SIDE_FORM.reduce((n, k) => n + TEMPLATES[k].bars, 0),
        tracks: [],
      };
      this.movements.push(movement);
    }
    const side = this.movements[this.movements.length - 1]!;
    const trackNo = this.sections.filter((s) => s.movementId === side.id).length + 1;

    const section: SectionProgram = {
      id,
      rev: 1,
      index: this.seq,
      track: trackNo,
      movementId: side.id,
      name: TRACK_NAMES[(this.seq - 1) % TRACK_NAMES.length]!,
      role: t.role,
      startCycle,
      bars: t.bars,
      jumps: [],
      vamp: { allowed: t.vamp, loopBars: 8 },
      provisional: true,
      tempo: { fromBpm: 120, toBpm: 120, rampBars: 0, rampAt: 'start' },
      scale: 'D:dorian',
      chords: '<Dm9 G13>',
      transitionIn: prev ? t.transition : { type: 'cut', bars: 0 },
      targets: { intensity: t.intensity, brightness: t.brightness, density: t.intensity, tension: t.intensity },
      measured: { intensity: t.intensity, brightness: t.brightness, density: t.intensity, tension: t.intensity },
      parts: this.parts(t, prev, startCycle),
      publicNote: NOTES[key][Math.floor(this.formIndex / SIDE_FORM.length) % NOTES[key].length]!,
      author: 'claude',
    };
    this.sections.push(section);
    return { section, movement };
  }

  private parts(t: Template, prev: SectionProgram | null, startCycle: number): ProgramPart[] {
    const used = new Set<number>(prev?.parts.map((p) => p.orbit) ?? []);
    const out: ProgramPart[] = [];
    const pending: ProgramPart[] = [];
    for (const spec of t.parts) {
      const base = this.fixture.sections[spec.from]!.parts.find((p) => p.id === spec.id)!;
      // Pickups only make sense over a previous section.
      if (!prev && base.enterBar < 0) continue;
      const part: ProgramPart = {
        ...base,
        knobs: base.knobs.map((k) => ({ ...k })),
        automation: base.automation.filter((a) => a.toBar <= t.bars).map((a) => ({ ...a })),
        enterBar: spec.enterBar ?? Math.min(base.enterBar, t.bars - 4),
        exitBar: spec.exitBar !== undefined ? spec.exitBar : base.exitBar,
        level: spec.level ?? base.level,
      };
      const before = prev?.parts.find((p) => p.id === part.id);
      if (before && before.code === part.code && before.exitBar === null && part.enterBar <= 0) {
        out.push({ ...part, orbit: before.orbit, originCycle: before.originCycle, continues: true, carried: true, enterBar: 0 });
      } else {
        pending.push({ ...part, originCycle: startCycle, continues: false, carried: before?.code === part.code });
      }
    }
    for (const p of out) used.add(p.orbit);
    for (const p of pending) {
      let orbit = 1;
      while (used.has(orbit)) orbit++;
      used.add(orbit);
      out.push({ ...p, orbit });
    }
    return out;
  }

  /** Stay / Move on: adds a jump to `id` and moves every later track by the change in length. */
  jump(id: string, jump: Jump): SectionProgram[] {
    const i = this.sections.findIndex((s) => s.id === id);
    const s = this.sections[i];
    if (!s) return [];
    const before = plannedPlayBars(s);
    const edited = { ...s, rev: s.rev + 1, jumps: [...s.jumps, jump] };
    const shift = plannedPlayBars(edited) - before;
    this.sections[i] = edited;
    const changed = [edited];
    for (let k = i + 1; k < this.sections.length; k++) {
      const later = this.sections[k]!;
      const before = this.sections[k - 1]!;
      // A continuing part stays anchored to its predecessor's origin; fresh parts move with the track.
      const parts = later.parts.map((p) => ({
        ...p,
        originCycle: p.continues ? (before.parts.find((q) => q.id === p.id)?.originCycle ?? p.originCycle) : p.originCycle + shift,
      }));
      const moved = { ...later, rev: later.rev + 1, startCycle: later.startCycle + shift, parts };
      this.sections[k] = moved;
      changed.push(moved);
    }
    for (const m of this.movements) {
      const first = this.sections.find((x) => x.movementId === m.id);
      if (first) m.startCycle = first.startCycle;
    }
    return changed;
  }

  /** Locks a provisional track (clients then show its cue as committed). */
  commit(id: string): SectionProgram | null {
    const i = this.sections.findIndex((s) => s.id === id);
    const s = this.sections[i];
    if (!s || !s.provisional) return null;
    this.sections[i] = { ...s, rev: s.rev + 1, provisional: false };
    return this.sections[i]!;
  }

  /** Movements as clients see them at `cycle`: past tracks of each side filled in. */
  movementsAt(cycle: number): MovementInfo[] {
    return this.movements.map((m) => ({
      ...m,
      tracks: this.sections
        .filter((s) => s.movementId === m.id && s.startCycle + plannedPlayBars(s) <= cycle)
        .map((s) => ({ id: s.id, name: s.name, role: s.role, startCycle: s.startCycle, bars: plannedPlayBars(s) })),
    }));
  }
}
