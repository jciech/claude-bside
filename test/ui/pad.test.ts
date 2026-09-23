import { describe, expect, it } from 'vitest';
import { clampPad, nudgeAxis, padToPixel, pointerToPad, quantizePad, school } from '../../src/client/ui/pad.ts';
import { PadSchema } from '../../src/shared/protocol.ts';

const rect = { left: 100, top: 50, width: 200, height: 100 };

describe('pad math', () => {
  it('maps the pad corners: left = dark, top = intense', () => {
    expect(pointerToPad(100, 50, rect)).toEqual({ x: -1, y: 1 });
    expect(pointerToPad(300, 150, rect)).toEqual({ x: 1, y: -1 });
    expect(pointerToPad(200, 100, rect)).toEqual({ x: 0, y: 0 });
  });

  it('clamps pointers dragged outside the pad', () => {
    expect(pointerToPad(-500, 900, rect)).toEqual({ x: -1, y: -1 });
  });

  it('round-trips pixel ↔ pad coordinates', () => {
    for (const p of [{ x: 0.3, y: -0.4 }, { x: -1, y: 1 }, { x: 0, y: 0 }]) {
      const [px, py] = padToPixel(p, rect.width, rect.height);
      const back = pointerToPad(px + rect.left, py + rect.top, rect);
      expect(back.x).toBeCloseTo(p.x, 9);
      expect(back.y).toBeCloseTo(p.y, 9);
    }
  });

  it('quantises to something the server schema accepts', () => {
    const q = quantizePad({ x: 0.123456, y: -1.2 });
    expect(q).toEqual({ x: 0.123, y: -1 });
    expect(PadSchema.safeParse({ ...quantizePad({ x: Number.NaN, y: 2 }), active: true }).success).toBe(true);
  });

  it('nudges by 0.1, or 0.25 with shift, and stays in range', () => {
    expect(nudgeAxis(0, 'ArrowRight', false)).toBe(0.1);
    expect(nudgeAxis(0, 'ArrowDown', true)).toBe(-0.25);
    expect(nudgeAxis(0.95, 'ArrowUp', false)).toBe(1);
    expect(nudgeAxis(0.2, 'Home', false)).toBe(-1);
    expect(nudgeAxis(0.2, 'a', false)).toBeNull();
  });

  it('schools gently and deterministically', () => {
    const p = { x: 0.5, y: 0.5 };
    const a = school(p, 3, 10);
    expect(a).toEqual(school(p, 3, 10));
    expect(Math.abs(a.x - p.x)).toBeLessThanOrEqual(0.025 + 1e-9);
    expect(clampPad(school({ x: 1, y: 1 }, 1, 2))).toEqual(school({ x: 1, y: 1 }, 1, 2));
  });
});
