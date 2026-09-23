// Pull pad math: x = dark(-1)…bright(+1), y = calm(-1)…intense(+1), drawn with intense at the top.
import type { PadPoint } from '../../shared/protocol.ts';

export const PAD_STEP = 0.1;
export const PAD_STEP_LARGE = 0.25;
/** The server relaxes a released puck after this long (crowd params `padRelaxMs`). */
export const PAD_RELAX_MS = 90_000;

const clamp1 = (v: number): number => (Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0);

export function clampPad(p: PadPoint): PadPoint {
  return { x: clamp1(p.x), y: clamp1(p.y) };
}

/** Rounds to what is worth sending (the server quantises ghosts to 0.05 anyway). */
export function quantizePad(p: PadPoint): PadPoint {
  const q = (v: number) => Math.round(clamp1(v) * 1000) / 1000;
  return { x: q(p.x), y: q(p.y) };
}

export function pointerToPad(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }): PadPoint {
  return clampPad({
    x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    y: 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2,
  });
}

export function padToPixel(p: PadPoint, width: number, height: number): [number, number] {
  return [((clamp1(p.x) + 1) / 2) * width, ((1 - clamp1(p.y)) / 2) * height];
}

/** Keyboard nudge for the pad's slider pair; null when the key is not a pad key. */
export function nudgeAxis(value: number, key: string, large: boolean): number | null {
  const step = large ? PAD_STEP_LARGE : PAD_STEP;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp1(Math.round((value + step) * 100) / 100);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp1(Math.round((value - step) * 100) / 100);
    case 'PageUp':
      return clamp1(Math.round((value + PAD_STEP_LARGE) * 100) / 100);
    case 'PageDown':
      return clamp1(Math.round((value - PAD_STEP_LARGE) * 100) / 100);
    case 'Home':
      return -1;
    case 'End':
      return 1;
    default:
      return null;
  }
}

/**
 * Gentle deterministic "schooling" for the others' dots between crowd frames: a small wobble around
 * each quantised position, keyed by index so a dot keeps its own rhythm.
 */
export function school(p: PadPoint, index: number, tSec: number, amount = 0.025): PadPoint {
  const phase = index * 2.399963;
  return clampPad({
    x: p.x + Math.sin(tSec * 0.45 + phase) * amount,
    y: p.y + Math.cos(tSec * 0.37 + phase * 1.3) * amount,
  });
}
