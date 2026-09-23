// The record renderer ("the Lathe"). It runs in a dedicated worker on an OffscreenCanvas when
// available (measured: main-thread rendering starved Strudel's scheduler), with the same drawing
// code on a main-thread canvas as a fallback. `LatheHost` is the only surface the UI uses.
import type { Engine, VisualEvent } from '../engine/types.ts';
import type { MovementInfo } from '../../shared/program.ts';
import type { PadPoint } from '../../shared/protocol.ts';
import type { EtchType, SectionRole } from '../../shared/music.ts';

export type RenderTier = 'full' | 'lite' | 'calm';

/**
 * Maps wall-ish time to cycles. `epochMs` is the SENDER's performance.timeOrigin + performance.now()
 * (a worker's performance.now() has a different origin, so both sides compare epoch time). The host
 * sends a sample on every timeline change, tempo-segment boundary, clock-sync step, and ≥ once a bar.
 */
export interface ClockSample {
  epochMs: number;
  cycle: number;
  cps: number;
}

export interface SideSection {
  id: string;
  name: string;
  role: SectionRole;
  startCycle: number;
  bars: number;
  provisional: boolean;
}

/** The listener's display preferences the renderer honours. */
export interface RenderPrefs {
  /** `prefers-contrast: more`: no sheen (docs/DESIGN.md). */
  contrastMore: boolean;
}

/** What the DOM label over the record shows (it lives outside the canvas). */
export interface LabelState {
  /** Clay-on-ink for the bar after a drop. */
  inverted: boolean;
  /** Nothing is sounding: the label reads "— listening —". */
  listening: boolean;
}

export type ToRenderer =
  | { type: 'init'; canvas: OffscreenCanvas | HTMLCanvasElement; width: number; height: number; dpr: number; tier: RenderTier; contrastMore: boolean }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'tier'; tier: RenderTier }
  | { type: 'prefs'; contrastMore: boolean }
  | { type: 'pause'; paused: boolean }
  | { type: 'clock'; sample: ClockSample }
  /** Triggered events (as they are scheduled) — imprinted into the groove when their onset passes. */
  | { type: 'events'; events: VisualEvent[] }
  /** Lookahead snapshot for pre-echo ghosts: replaces the previous lookahead window. */
  | { type: 'lookahead'; fromCycle: number; toCycle: number; events: VisualEvent[] }
  | { type: 'side'; movement: MovementInfo | null; sections: SideSection[] }
  | { type: 'levels'; master: number; parts: Record<string, number>; energy: number }
  | { type: 'crowd'; pull: PadPoint; needle: PadPoint }
  | { type: 'etch'; etches: { type: EtchType; cycle: number; hue: number }[] }
  /** Musical moments with a visual gesture (docs/DESIGN.md "Musical states"). */
  | { type: 'moment'; kind: 'drop' | 'build' | 'breakdown' | 'section' | 'silence'; cycle: number };

export type FromRenderer =
  | { type: 'ready' }
  /** Frame-time stats for automatic tier downgrades. */
  | { type: 'stats'; p95FrameMs: number; fps: number }
  | { type: 'error'; message: string };

/**
 * Created by the Record component. The host subscribes to the engine itself (hap, sectionStart,
 * meters, lookahead queries ≤ 4 per bar) and derives `moment`s from section roles; the UI supplies
 * side, crowd, etches, the user's tier choice and the display preferences (media queries).
 */
export interface LatheHost {
  resize(width: number, height: number, dpr: number): void;
  setTier(tier: RenderTier): void;
  setPrefs(prefs: RenderPrefs): void;
  pause(paused: boolean): void;
  setSide(movement: MovementInfo | null, sections: SideSection[]): void;
  setCrowd(pull: PadPoint, needle: PadPoint): void;
  etch(etches: { type: EtchType; cycle: number; hue: number }[]): void;
  on(event: 'stats', listener: (s: { p95FrameMs: number; fps: number }) => void): () => void;
  /** The DOM label over the record: the listener is called at once with the current state, then on every change. */
  on(event: 'label', listener: (s: LabelState) => void): () => void;
  destroy(): void;
}

export interface LatheOptions {
  tier: RenderTier;
  useWorker: boolean;
  /** Initial preferences (default: none set); later changes go through setPrefs. */
  prefs?: RenderPrefs;
}

// Factory (implemented in host.ts):
//   createLathe(canvas: HTMLCanvasElement, engine: Engine, options: LatheOptions): LatheHost
export type CreateLathe = (canvas: HTMLCanvasElement, engine: Engine, options: LatheOptions) => LatheHost;
