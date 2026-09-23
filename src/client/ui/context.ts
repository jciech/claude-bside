// What every component of the room shares, provided once by ListeningRoom.svelte.
import { getContext, setContext } from 'svelte';
import type { Readable, Writable } from 'svelte/store';
import type { EngineState, PartError } from '../engine/types.ts';
import type { Room } from '../room/types.ts';
import type { Pulse } from './pulse.ts';
import type { Settings } from './settings.ts';

export type Layout = 'desktop' | 'tablet' | 'phone';

export interface RoomContext {
  room: Room;
  pulse: Pulse;
  settings: Writable<Settings>;
  layout: Readable<Layout>;
  engineState: Readable<EngineState>;
  /** Calm visuals: the setting, or prefers-reduced-motion when the setting is unset. */
  calm: Readable<boolean>;
  /** The latest engine error per instance key (`${sectionId}:${partId}`). */
  partErrors: Readable<Record<string, PartError>>;
  /** Part ids the listener muted in their own mix. */
  mutes: Writable<Set<string>>;
}

const KEY = Symbol('bside-room');

export function provideRoom(ctx: RoomContext): void {
  setContext(KEY, ctx);
}

export function useRoom(): RoomContext {
  const ctx = getContext<RoomContext | undefined>(KEY);
  if (!ctx) throw new Error('useRoom() outside the room');
  return ctx;
}
