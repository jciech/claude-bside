// Canvas plumbing shared by the worker and the main-thread fallback.
import rimFontUrl from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url';

export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
/**
 * OffscreenCanvasRenderingContext2D implements everything the Lathe uses from
 * CanvasRenderingContext2D; one type keeps overloaded calls (drawImage, arc…) type-checkable.
 */
export type Ctx2D = CanvasRenderingContext2D;

export const RIM_FONT = '"Lathe Mono", "JetBrains Mono Variable", ui-monospace, monospace';

export function makeCanvas(width: number, height: number): AnyCanvas {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

export function context2d(canvas: AnyCanvas): Ctx2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return ctx;
}

/** Loads the label's rim font into this thread (workers have their own FontFaceSet). */
export async function loadRimFont(): Promise<boolean> {
  const fonts = (globalThis as { fonts?: FontFaceSet }).fonts ?? globalThis.document?.fonts;
  if (!fonts || typeof FontFace === 'undefined') return false;
  try {
    const face = await new FontFace('Lathe Mono', `url(${rimFontUrl})`, { weight: '100 800' }).load();
    fonts.add(face);
    return true;
  } catch {
    return false;
  }
}
