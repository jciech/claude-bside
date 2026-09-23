// Room state as Svelte stores. The room connection (or the mock) is the only writer; components
// read. Reducers are pure so they can be tested without a socket.
import { writable, type Writable } from 'svelte/store';
import { EMPTY_MIXER, type MixerState, type MovementInfo, type SectionProgram } from '../../shared/program.ts';
import type { EtchType } from '../../shared/music.ts';
import type { ComposerStatus, CrowdFrame, ForkState, LinerNote, RequestCard, RoomSnapshot, ScheduleUpdate } from '../../shared/protocol.ts';
import { sectionExtents } from '../../shared/schedule.ts';
import type { Timeline } from '../../shared/timeline.ts';

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'full';

export interface ScheduleState {
  epoch: string | null;
  rev: number;
  timeline: Timeline | null;
  movements: MovementInfo[];
  /** Sorted by startCycle. */
  sections: SectionProgram[];
}

export interface Nack {
  event: string;
  reason: string;
  at: number;
}

export interface Etch {
  type: EtchType;
  cycle: number;
  hue: number;
}

export interface RoomStores {
  connection: Writable<ConnectionStatus>;
  schedule: Writable<ScheduleState>;
  mixer: Writable<MixerState>;
  crowd: Writable<CrowdFrame | null>;
  fork: Writable<ForkState | null>;
  notes: Writable<LinerNote[]>;
  requests: Writable<RequestCard[]>;
  composer: Writable<ComposerStatus | null>;
  you: Writable<{ hue: number } | null>;
  sourceUrl: Writable<string>;
  nack: Writable<Nack | null>;
  /** The listener's own reactions, etched at once (the room's frame confirms them later). */
  etches: Writable<Etch[]>;
}

export const EMPTY_SCHEDULE: ScheduleState = { epoch: null, rev: -1, timeline: null, movements: [], sections: [] };
export const MAX_NOTES = 50;
/** Sections that ended this many bars ago are dropped (the engine forgets them too). */
const KEEP_PAST_BARS = 16;
export const DEFAULT_SOURCE_URL = 'https://github.com/jciech/claude-bside';

export function createRoomStores(): RoomStores {
  return {
    connection: writable<ConnectionStatus>('connecting'),
    schedule: writable<ScheduleState>(EMPTY_SCHEDULE),
    mixer: writable<MixerState>(EMPTY_MIXER),
    crowd: writable<CrowdFrame | null>(null),
    fork: writable<ForkState | null>(null),
    notes: writable<LinerNote[]>([]),
    requests: writable<RequestCard[]>([]),
    composer: writable<ComposerStatus | null>(null),
    you: writable<{ hue: number } | null>(null),
    sourceUrl: writable(DEFAULT_SOURCE_URL),
    nack: writable<Nack | null>(null),
    etches: writable<Etch[]>([]),
  };
}

const byStart = (a: SectionProgram, b: SectionProgram) => a.startCycle - b.startCycle;

export function scheduleFromSnapshot(s: Pick<RoomSnapshot, 'epoch' | 'rev' | 'timeline' | 'movements' | 'sections'>): ScheduleState {
  return { epoch: s.epoch, rev: s.rev, timeline: s.timeline, movements: [...s.movements], sections: [...s.sections].sort(byStart) };
}

/**
 * Applies an atomic update. Returns the state unchanged for stale revs; `gap` tells the caller a
 * rev was skipped (it should resync with a fresh hello).
 */
export function applyScheduleUpdate(state: ScheduleState, u: ScheduleUpdate): { state: ScheduleState; gap: boolean; stale: boolean } {
  if (state.epoch !== null && u.epoch !== state.epoch) return { state, gap: true, stale: false };
  if (u.rev <= state.rev) return { state, gap: false, stale: true };
  const gap = state.rev >= 0 && u.rev > state.rev + 1;
  const revoked = new Set(u.revokes);
  const byId = new Map(state.sections.filter((s) => !revoked.has(s.id)).map((s) => [s.id, s]));
  for (const s of u.upserts) byId.set(s.id, s);
  return {
    state: { epoch: u.epoch, rev: u.rev, timeline: u.timeline, movements: [...u.movements], sections: [...byId.values()].sort(byStart) },
    gap,
    stale: false,
  };
}

/** Drops sections that ended long ago, keeping the one before the current (tails, fresh ink). */
export function pruneSections(sections: readonly SectionProgram[], nowCycle: number): SectionProgram[] {
  const extents = sectionExtents(sections);
  const current = extents.findIndex((e) => e.section.startCycle <= nowCycle && nowCycle < e.endCycle);
  return extents.filter((e, i) => e.endCycle + KEEP_PAST_BARS >= nowCycle || i >= current - 1).map((e) => e.section);
}

/** Etches older than this are dropped (the crowd frame carries the last 16 bars too). */
const ETCH_BARS = 16;

export function recordEtch(stores: RoomStores, etch: Etch): void {
  stores.etches.update((list) => [...list.filter((e) => e.cycle > etch.cycle - ETCH_BARS), etch]);
}

export function appendNote(notes: readonly LinerNote[], note: LinerNote): LinerNote[] {
  if (notes.some((n) => n.id === note.id)) return [...notes];
  return [...notes, note].sort((a, b) => a.cycle - b.cycle).slice(-MAX_NOTES);
}

export function applySnapshotToStores(stores: RoomStores, s: RoomSnapshot): void {
  stores.schedule.set(scheduleFromSnapshot(s));
  stores.mixer.set(s.mixer);
  stores.crowd.set(s.crowd);
  stores.fork.set(s.fork);
  stores.notes.set(s.notes.slice(-MAX_NOTES));
  stores.requests.set(s.requests);
  stores.composer.set(s.composer);
  stores.you.set({ hue: s.you.hue });
  stores.sourceUrl.set(s.sourceUrl || DEFAULT_SOURCE_URL);
}

/** The section sounding at `cycle` (its extent runs to the next section's start). */
export function sectionAtCycle(sections: readonly SectionProgram[], cycle: number): SectionProgram | null {
  for (const e of sectionExtents(sections)) if (e.section.startCycle <= cycle && cycle < e.endCycle) return e.section;
  return null;
}

/** The first section starting after `cycle`. */
export function nextSection(sections: readonly SectionProgram[], cycle: number): SectionProgram | null {
  return [...sections].sort(byStart).find((s) => s.startCycle > cycle) ?? null;
}

/** The movement (side) in effect at `cycle`: the latest one that has started. */
export function movementAt(movements: readonly MovementInfo[], cycle: number): MovementInfo | null {
  let found: MovementInfo | null = null;
  for (const m of movements) if (m.startCycle <= cycle && (!found || m.startCycle >= found.startCycle)) found = m;
  return found ?? movements[0] ?? null;
}
