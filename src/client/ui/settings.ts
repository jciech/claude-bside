// Listener-local preferences, remembered in this browser only. Storage can be missing or throw
// (private mode, blocked site data), so every access is guarded and the defaults always work.
import { writable, type Writable } from 'svelte/store';

export interface Settings {
  /** 0..1, applied to the engine's master volume. */
  volume: number;
  /** null = follow prefers-reduced-motion. */
  calm: boolean | null;
  pauseVisuals: boolean;
  shortcuts: boolean;
}

export const DEFAULT_SETTINGS: Settings = { volume: 0.8, calm: null, pauseVisuals: false, shortcuts: true };
const KEY = 'bside.settings.v1';

export function safeStorage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export function readSettings(storage: Storage | null): Settings {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(raw) as Partial<Settings>;
    return {
      volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : DEFAULT_SETTINGS.volume,
      calm: typeof v.calm === 'boolean' ? v.calm : null,
      pauseVisuals: v.pauseVisuals === true,
      shortcuts: v.shortcuts !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function createSettings(storage: Storage | null = safeStorage()): Writable<Settings> {
  const store = writable(readSettings(storage));
  store.subscribe((s) => {
    try {
      storage?.setItem(KEY, JSON.stringify(s));
    } catch {
      // Not remembered; the room still works.
    }
  });
  return store;
}
