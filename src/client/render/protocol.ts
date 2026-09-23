// Messages between the main thread and the record renderer ("the Lathe"). The renderer runs in a
// dedicated worker on an OffscreenCanvas when available (measured: main-thread rendering starved
// Strudel's scheduler), with the same code driving a main-thread canvas as a fallback.
import type { VisualEvent } from '../engine/types.ts';
import type { MovementInfo } from '../../shared/program.ts';
import type { PadPoint } from '../../shared/protocol.ts';
import type { Reaction, SectionRole } from '../../shared/music.ts';

export type RenderTier = 'full' | 'lite' | 'calm';

/** Maps performance.now() (ms) to cycles so the renderer can run its own animation clock. */
export interface ClockSample {
  perfMs: number;
  cycle: number;
  cps: number;
}

export interface SideSection {
  id: string;
  name: string;
  role: SectionRole;
  startCycle: number;
  bars: number;
}

export type ToRenderer =
  | { type: 'init'; canvas: OffscreenCanvas | HTMLCanvasElement; width: number; height: number; dpr: number; tier: RenderTier }
  | { type: 'resize'; width: number; height: number; dpr: number }
  | { type: 'tier'; tier: RenderTier }
  | { type: 'pause'; paused: boolean }
  | { type: 'clock'; sample: ClockSample }
  /** Triggered events (as they are scheduled) — imprinted into the groove when their onset passes. */
  | { type: 'events'; events: VisualEvent[] }
  /** Lookahead snapshot for pre-echo ghosts: replaces the previous lookahead window. */
  | { type: 'lookahead'; fromCycle: number; toCycle: number; events: VisualEvent[] }
  | { type: 'side'; movement: MovementInfo | null; sections: SideSection[] }
  | { type: 'levels'; master: number; parts: Record<string, number>; energy: number }
  | { type: 'crowd'; pull: PadPoint; needle: PadPoint }
  | { type: 'etch'; etches: { type: Reaction; cycle: number; hue: number }[] }
  /** Musical moments with a visual gesture (see docs/DESIGN.md §States). */
  | { type: 'moment'; kind: 'drop' | 'build' | 'breakdown' | 'section' | 'silence'; cycle: number };

export type FromRenderer =
  | { type: 'ready' }
  /** Frame-time stats for automatic tier downgrades. */
  | { type: 'stats'; p95FrameMs: number; fps: number }
  | { type: 'error'; message: string };
