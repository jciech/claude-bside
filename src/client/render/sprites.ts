// Pre-rendered glow sprites: blooms, ghosts and the stylus are drawImage calls, never per-frame
// gradients. Each family has its own shape so the canvas never relies on colour alone
// (docs/DESIGN.md glyph grammar): orbs for drums and bass, a sparkle for hats, a bright bead for
// leads, a soft ring for pads, dust for fx.
import { VOICE_FAMILIES, type VoiceFamily } from '../../shared/music.ts';
import { context2d, makeCanvas, type AnyCanvas, type Ctx2D } from './surface.ts';
import { rgba, VOICE_COLOR } from './tokens.ts';

type Shape = 'orb' | 'bead' | 'ring' | 'spark' | 'dust';

const FAMILY_SHAPE: Record<VoiceFamily, Shape> = {
  kick: 'orb',
  bass: 'orb',
  snare: 'orb',
  keys: 'orb',
  hat: 'spark',
  lead: 'bead',
  pad: 'ring',
  fx: 'dust',
};

function orb(g: Ctx2D, color: string, x: number, y: number, r: number, core: number): void {
  const grd = g.createRadialGradient(x, y, 0, x, y, r);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(core, color);
  grd.addColorStop(Math.min(0.9, core + 0.33), rgba(color, 0.33));
  grd.addColorStop(1, rgba(color, 0));
  g.fillStyle = grd;
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

function drawShape(g: Ctx2D, shape: Shape, color: string, size: number): void {
  const c = size / 2;
  switch (shape) {
    case 'orb':
      orb(g, color, c, c, c, 0.12);
      break;
    case 'bead':
      orb(g, color, c, c, c, 0.22);
      break;
    case 'ring': {
      const grd = g.createRadialGradient(c, c, 0, c, c, c);
      grd.addColorStop(0, rgba(color, 0.08));
      grd.addColorStop(0.5, rgba(color, 0.3));
      grd.addColorStop(0.64, rgba(color, 0.42));
      grd.addColorStop(0.82, rgba(color, 0.12));
      grd.addColorStop(1, rgba(color, 0));
      g.fillStyle = grd;
      g.fillRect(0, 0, size, size);
      break;
    }
    case 'spark': {
      g.globalCompositeOperation = 'lighter';
      for (const vertical of [false, true]) {
        const grd = vertical ? g.createLinearGradient(c, 0, c, size) : g.createLinearGradient(0, c, size, c);
        grd.addColorStop(0, rgba(color, 0));
        grd.addColorStop(0.5, 'rgba(255,255,255,0.9)');
        grd.addColorStop(1, rgba(color, 0));
        g.fillStyle = grd;
        const w = size * 0.07;
        if (vertical) g.fillRect(c - w / 2, 0, w, size);
        else g.fillRect(0, c - w / 2, size, w);
      }
      orb(g, color, c, c, size * 0.32, 0.15);
      break;
    }
    case 'dust':
      for (const [dx, dy] of [
        [-0.18, 0.08],
        [0.16, -0.14],
        [0.06, 0.2],
      ] as const) {
        orb(g, color, c + dx * size, c + dy * size, size * 0.2, 0.2);
      }
      break;
  }
}

export function familySprites(size: number): Record<VoiceFamily, AnyCanvas> {
  const out = {} as Record<VoiceFamily, AnyCanvas>;
  for (const family of VOICE_FAMILIES) {
    const canvas = makeCanvas(size, size);
    drawShape(context2d(canvas), FAMILY_SHAPE[family], VOICE_COLOR[family], size);
    out[family] = canvas;
  }
  return out;
}

export function glowSprite(color: string, size: number): AnyCanvas {
  const canvas = makeCanvas(size, size);
  orb(context2d(canvas), color, size / 2, size / 2, size / 2, 0.14);
  return canvas;
}
