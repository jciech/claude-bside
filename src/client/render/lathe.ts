// The Lathe: the record Claude is cutting live (docs/DESIGN.md "The Lathe", "Musical states",
// "Tiers"). History is texture, detail lives at the needle: every event is imprinted once into an
// accumulating archive canvas (lacquer, grooves and glyphs together) when its onset passes, so a
// frame costs one rotated drawImage of the record, the label, and the few dozen glyphs near the
// stylus. Raster fill is the real cost on phones, so every full-area layer is paid for once.
// Runs unchanged in the render worker (OffscreenCanvas) and on the main thread.
import { VOICE_FAMILIES, type EtchType, type VoiceFamily } from '../../shared/music.ts';
import type { MovementInfo } from '../../shared/program.ts';
import type { PadPoint } from '../../shared/protocol.ts';
import type { VisualEvent } from '../engine/types.ts';
import { FlashLimiter } from './flash.ts';
import {
  canvasAngle,
  grooveRadius,
  layoutRecord,
  polar,
  recordAngle,
  sheenHue,
  sheenIntensity,
  sideLetter,
  sideSpec,
  smoothstep,
  spiralBars,
  TAU,
  type Layout,
  type SideSpec,
  laneOffset,
} from './geometry.ts';
import { applyMoment, DROP_INVERT_BARS, INITIAL_MOOD, lookAt, type Look, type MomentKind, type Mood } from './moments.ts';
import type { RenderTier, SideSection } from './protocol.ts';
import { familySprites, glowSprite } from './sprites.ts';
import { context2d, makeCanvas, RIM_FONT, type AnyCanvas, type Ctx2D } from './surface.ts';
import { BLOOM_SIZE, GHOST_SIZE, INK, rgba, SUSTAINED_FAMILIES, VOICE_COLOR } from './tokens.ts';

const LIMITS = {
  /** Imprinted events kept for archive rebuilds (resize, side geometry changes). */
  history: 30_000,
  /** While paused, due events are imprinted once this many are waiting. */
  pendingWhilePaused: 4096,
  blooms: 256,
  etches: 2000,
  ghosts: { full: 160, lite: 72, calm: 72 } satisfies Record<RenderTier, number>,
  /** Archive backing store edge (docs: ≤ 2048² desktop). */
  archivePx: 2048,
} as const;

/** The record's drop shadow reaches this far out (× R); the archive covers it too. */
const SHADOW_EXTENT = 1.07;

const TIME = {
  bloomCollapseSec: 0.9,
  /** Events imprinted later than this after their onset don't bloom (backfill, catching up). */
  bloomMaxLateSec: 1,
  calmFadeInSec: 0.15,
  etchDriftMs: 2600,
  sideFadeBars: 1,
  thumpTauSec: 0.11,
  lookTauSec: 0.35,
  crowdTauSec: 0.6,
} as const;

const THUMP_SCALE = 0.006;
const STYLUS_LIFT_CSS = 6;
const GROOVE_STEP = 1 / 64;
const DEFAULT_PLANNED_BARS = 128;
const DEFAULT_TRACK_BARS = 16;
/** Events are sent at most a lookahead window early; anything further out is not for this record. */
const MAX_AHEAD_BARS = 8;

interface Glyph {
  key: string;
  instance: string;
  family: VoiceFamily;
  cycle: number;
  duration: number;
  lane: number;
  gain: number;
  /** Archive ink at imprint time (drop bars cut deeper, breakdown pads wash wider), kept for rebuilds. */
  ink: number;
}

interface EtchMark {
  type: EtchType;
  cycle: number;
  hue: number;
}

interface Side {
  id: string | null;
  startCycle: number;
  plannedBars: number;
  trackStarts: number[];
  sections: SideSection[];
  spec: SideSpec;
  rimText: string;
}

const FAMILIES = new Set<string>(VOICE_FAMILIES);

function eventKey(e: VisualEvent): string {
  return `${e.instance}|${e.cycle.toFixed(5)}|${e.midi ?? ''}|${e.sound}`;
}

function toGlyph(e: VisualEvent, key: string): Glyph {
  const family = FAMILIES.has(e.family) ? e.family : 'fx';
  return {
    key,
    instance: e.instance,
    family,
    cycle: e.cycle,
    duration: Number.isFinite(e.duration) ? Math.max(0, e.duration) : 0,
    lane: laneOffset(family, e.midi),
    gain: Number.isFinite(e.gain) ? Math.min(1, Math.max(0, e.gain)) : 0.5,
    ink: 1,
  };
}

function rimTextFor(movement: MovementInfo | null): string {
  if (!movement) return 'CLAUDE B-SIDE · LIVE · ';
  const bpm = Number.isInteger(movement.bpm) ? String(movement.bpm) : movement.bpm.toFixed(1);
  return `CLAUDE B-SIDE · SIDE ${sideLetter(movement.side)} · ${bpm} BPM · `;
}

function sameSpec(a: SideSpec, b: SideSpec, drawnTo: number | null): boolean {
  if (a.startCycle !== b.startCycle || a.bars !== b.bars || a.landSlots !== b.landSlots) return false;
  // Lands still ahead of the cut don't change anything drawn yet.
  const upTo = drawnTo ?? Number.NEGATIVE_INFINITY;
  const past = (s: SideSpec) => s.lands.filter((c) => c <= upTo).join(',');
  return past(a) === past(b);
}

/** Exponential approach of `from` toward `to` over dt with time constant tau. */
function approach(from: number, to: number, dt: number, tau: number): number {
  return from + (to - from) * (1 - Math.exp(-dt / tau));
}

export class Lathe {
  private readonly canvas: AnyCanvas;
  private readonly ctx: Ctx2D;
  private tier: RenderTier;
  private dpr = 1;
  private L!: Layout;
  private side: Side;
  private pendingSide: Side | null = null;

  private archive!: AnyCanvas;
  private actx!: Ctx2D;
  private archiveScale = 1;
  private fading: { canvas: AnyCanvas; scale: number; from: number; to: number } | null = null;
  private label!: AnyCanvas;
  private labelInverted!: AnyCanvas;
  private sprites!: Record<VoiceFamily, AnyCanvas>;
  private readonly stylusGlow: AnyCanvas;
  private readonly etchGlow: AnyCanvas;

  private pending: Glyph[] = [];
  private readonly seen = new Map<string, number>();
  private history: Glyph[] = [];
  private blooms: Glyph[] = [];
  private ghosts: Glyph[] = [];
  private cutTo: number | null = null;
  private etchMarks: EtchMark[] = [];
  private readonly etchSeen = new Set<string>();
  private drifting: { mark: EtchMark; bornMs: number }[] = [];

  private levels: { master: number; parts: Record<string, number>; energy: number } = { master: 0, parts: {}, energy: 0 };
  private crowdTarget = { pull: { x: 0, y: 0 }, needle: { x: 0, y: 0 } };
  private crowd = { pull: { x: 0, y: 0 }, needle: { x: 0, y: 0 } };
  private mood: Mood = INITIAL_MOOD;
  private moments: { kind: MomentKind; cycle: number }[] = [];
  private readonly limiter = new FlashLimiter();
  private smooth = { spread: 0.2, ghostAlpha: 1, sheenBoost: 0, sheenSaturation: 1 };
  private pulse = 0;
  private lastFrameMs = 0;

  constructor(canvas: AnyCanvas, width: number, height: number, dpr: number, tier: RenderTier) {
    this.canvas = canvas;
    this.ctx = context2d(canvas);
    this.tier = tier;
    this.side = this.makeSide(null, [], 0, DEFAULT_PLANNED_BARS, 0);
    this.sprites = familySprites(this.spriteSize());
    this.stylusGlow = glowSprite(INK.clay, 64);
    this.etchGlow = glowSprite(INK.paper, 32);
    this.resize(width, height, dpr);
  }

  // ─── inputs ─────────────────────────────────────────────────────────────────────────────────

  resize(width: number, height: number, dpr: number): void {
    const ratio = Math.max(0.5, Math.min(4, dpr || 1));
    const w = Math.max(1, Math.round(width * ratio));
    const h = Math.max(1, Math.round(height * ratio));
    // Rebuilding the archive costs a pass over the history: skip resizes that change nothing.
    if (this.L && w === this.canvas.width && h === this.canvas.height && ratio === this.dpr) return;
    this.dpr = ratio;
    this.canvas.width = w;
    this.canvas.height = h;
    this.relayout();
  }

  setTier(tier: RenderTier): void {
    if (tier === this.tier) return;
    const wasFull = this.tier === 'full';
    this.tier = tier;
    if (tier === 'calm') this.blooms = [];
    // Sprite resolution and the lacquer's grain belong to Full only.
    if (wasFull !== (tier === 'full')) {
      this.sprites = familySprites(this.spriteSize());
      this.rebuildArchive();
    }
  }

  /** Re-renders what depends on the rim font once it has loaded. */
  refreshLabel(): void {
    this.renderLabels();
  }

  setSide(movement: MovementInfo | null, sections: SideSection[], cycle: number): void {
    if (!movement) return;
    const starts = [...movement.tracks.map((t) => t.startCycle), ...sections.map((s) => s.startCycle)];
    const next = this.makeSide(movement, sections, movement.startCycle, movement.plannedBars, cycle, starts);
    // A side committed ahead of time turns the record over when it starts, not when it arrives.
    if (this.side.id !== null && next.id !== this.side.id && next.startCycle > cycle) {
      this.pendingSide = next;
      return;
    }
    if (this.pendingSide?.id === next.id) this.pendingSide = null;
    this.applySide(next, cycle);
  }

  addEvents(events: readonly VisualEvent[], cycle: number, paused: boolean): void {
    for (const e of events) {
      if (!Number.isFinite(e.cycle) || e.cycle > cycle + MAX_AHEAD_BARS) continue;
      const key = eventKey(e);
      if (this.seen.has(key)) continue;
      this.seen.set(key, e.cycle);
      this.pending.push(toGlyph(e, key));
    }
    if (paused && this.pending.length > LIMITS.pendingWhilePaused) this.cut(cycle, lookAt(this.mood, cycle), 1, false);
  }

  setLookahead(events: readonly VisualEvent[]): void {
    const cap = LIMITS.ghosts[this.tier];
    const ghosts: Glyph[] = [];
    for (const e of events) {
      if (ghosts.length >= cap) break;
      if (Number.isFinite(e.cycle)) ghosts.push(toGlyph(e, ''));
    }
    this.ghosts = ghosts;
  }

  setLevels(master: number, parts: Record<string, number>, energy: number): void {
    this.levels = { master: Math.min(1, Math.max(0, master)), parts, energy: Math.min(1, Math.max(0, energy)) };
  }

  setCrowd(pull: PadPoint, needle: PadPoint): void {
    this.crowdTarget = { pull: { ...pull }, needle: { ...needle } };
  }

  addEtches(etches: readonly EtchMark[], cycle: number, wallMs: number): void {
    for (const e of etches) {
      if (!Number.isFinite(e.cycle)) continue;
      const key = `${e.type}|${e.cycle.toFixed(3)}|${e.hue}`;
      if (this.etchSeen.has(key)) continue;
      this.etchSeen.add(key);
      if (e.cycle < this.side.startCycle) continue;
      const mark = { type: e.type, cycle: e.cycle, hue: e.hue };
      this.etchMarks.push(mark);
      this.imprintEtch(mark);
      // Etches reported long after the fact (a late joiner's backlog) are only ticked in the rim.
      if (cycle - e.cycle <= 2) this.drifting.push({ mark, bornMs: wallMs });
    }
    if (this.etchMarks.length > LIMITS.etches) this.etchMarks.splice(0, this.etchMarks.length - LIMITS.etches);
    if (this.etchSeen.size > 2 * LIMITS.etches) {
      this.etchSeen.clear();
      for (const m of this.etchMarks) this.etchSeen.add(`${m.type}|${m.cycle.toFixed(3)}|${m.hue}`);
    }
  }

  addMoment(kind: MomentKind, cycle: number): void {
    this.moments.push({ kind, cycle });
    this.moments.sort((a, b) => a.cycle - b.cycle);
  }

  // ─── frame ──────────────────────────────────────────────────────────────────────────────────

  draw(cycle: number, cps: number, wallMs: number): void {
    const dt = this.lastFrameMs ? Math.min(0.25, Math.max(0, (wallMs - this.lastFrameMs) / 1000)) : 0;
    this.lastFrameMs = wallMs;
    if (this.pendingSide && cycle >= this.pendingSide.startCycle) {
      const next = this.pendingSide;
      this.pendingSide = null;
      this.applySide(next, cycle);
    }
    this.fitSide(cycle);
    this.applyMoments(cycle, wallMs);
    const look = lookAt(this.mood, cycle);
    this.follow(look, dt);
    this.cut(cycle, look, cps, true);
    this.pulse *= Math.exp(-dt / TIME.thumpTauSec);
    this.pruneSeen(cycle);
    this.render(cycle, cps, wallMs, look);
  }

  // ─── side and geometry ──────────────────────────────────────────────────────────────────────

  private makeSide(
    movement: MovementInfo | null,
    sections: SideSection[],
    startCycle: number,
    plannedBars: number,
    cycle: number,
    trackStarts: number[] = [],
  ): Side {
    return {
      id: movement?.id ?? null,
      startCycle,
      plannedBars,
      trackStarts,
      sections,
      spec: sideSpec(startCycle, plannedBars, trackStarts, cycle),
      rimText: rimTextFor(movement),
    };
  }

  private applySide(next: Side, cycle: number): void {
    const prev = this.side;
    this.side = next;
    if (prev.id !== next.id) {
      this.history = this.history.filter((g) => g.cycle >= next.startCycle);
      if (prev.id === null) {
        this.relayout();
        return;
      }
      // A new lacquer: the finished side fades out over a bar while the new one starts cutting.
      const old = { canvas: this.archive, scale: this.archiveScale };
      this.cutTo = null;
      this.etchMarks = [];
      this.drifting = [];
      this.relayout();
      this.fading = { ...old, from: cycle, to: cycle + TIME.sideFadeBars };
      return;
    }
    if (prev.rimText !== next.rimText) this.renderLabels();
    if (!sameSpec(prev.spec, next.spec, this.cutTo)) this.relayout();
  }

  /**
   * Past its planned length the spiral is re-laid over more bars (in steps, so rarely). Until the
   * UI names the side, the placeholder side starts wherever the clock is.
   */
  private fitSide(cycle: number): void {
    const s = this.side;
    if (s.id === null && (cycle < s.startCycle || cycle > s.startCycle + s.spec.bars)) {
      this.side = this.makeSide(null, [], Math.floor(cycle), DEFAULT_PLANNED_BARS, cycle);
      this.history = this.history.filter((g) => g.cycle >= this.side.startCycle);
      this.cutTo = null;
      this.relayout();
      return;
    }
    if (spiralBars(s.plannedBars, s.startCycle, cycle) === s.spec.bars) return;
    this.side = { ...s, spec: sideSpec(s.startCycle, s.plannedBars, s.trackStarts, cycle) };
    this.relayout();
  }

  private relayout(): void {
    this.L = layoutRecord(this.canvas.width, this.canvas.height, this.side.spec);
    this.renderLabels();
    this.rebuildArchive();
  }

  private radius(cycle: number): number {
    return grooveRadius(this.L, this.side.spec, cycle);
  }

  private spriteSize(): number {
    return this.tier === 'full' ? 96 : 64;
  }

  private sectionBars(cycle: number): number {
    return this.side.sections.find((s) => Math.abs(s.startCycle - cycle) < 1e-6)?.bars ?? DEFAULT_TRACK_BARS;
  }

  // ─── moments ────────────────────────────────────────────────────────────────────────────────

  private applyMoments(cycle: number, wallMs: number): void {
    while (this.moments.length && this.moments[0]!.cycle <= cycle) {
      const m = this.moments.shift()!;
      if (m.kind === 'drop') {
        // A drop reported late (after a pause) keeps its section's mode but loses its gesture.
        if (cycle - m.cycle < DROP_INVERT_BARS && this.limiter.allowDrop(wallMs)) this.mood = applyMoment(this.mood, 'drop', m.cycle, 0);
        continue;
      }
      this.mood = applyMoment(this.mood, m.kind, m.cycle, this.sectionBars(m.cycle));
    }
  }

  private follow(look: Look, dt: number): void {
    const s = this.smooth;
    s.spread = approach(s.spread, look.spread, dt, TIME.lookTauSec);
    s.ghostAlpha = approach(s.ghostAlpha, look.ghostAlpha, dt, TIME.lookTauSec);
    s.sheenBoost = approach(s.sheenBoost, look.sheenBoost, dt, TIME.lookTauSec);
    s.sheenSaturation = approach(s.sheenSaturation, look.sheenSaturation, dt, TIME.lookTauSec);
    for (const k of ['pull', 'needle'] as const) {
      this.crowd[k].x = approach(this.crowd[k].x, this.crowdTarget[k].x, dt, TIME.crowdTauSec);
      this.crowd[k].y = approach(this.crowd[k].y, this.crowdTarget[k].y, dt, TIME.crowdTauSec);
    }
  }

  // ─── the archive ────────────────────────────────────────────────────────────────────────────

  /** Cuts the record up to `cycle`: the groove first, then every event whose onset has passed. */
  private cut(cycle: number, look: Look, cps: number, bloom: boolean): void {
    this.cutGrooveTo(cycle);
    if (!this.pending.length) return;
    const due: Glyph[] = [];
    const later: Glyph[] = [];
    for (const g of this.pending) (g.cycle <= cycle ? due : later).push(g);
    if (!due.length) return;
    this.pending = later;
    due.sort((a, b) => a.cycle - b.cycle);
    const calm = this.tier === 'calm';
    for (const g of due) {
      if (g.cycle < this.side.startCycle) continue;
      g.ink = g.family === 'pad' ? look.padWash : look.archiveBoost;
      this.imprint(g);
      this.history.push(g);
      this.mood = this.mood.silent ? { ...this.mood, silent: false } : this.mood;
      if (!bloom || (cycle - g.cycle) / Math.max(0.01, cps) > TIME.bloomMaxLateSec) continue;
      this.blooms.push(g);
      if (g.family === 'kick' && !calm) this.pulse = 1;
    }
    if (this.history.length > LIMITS.history) this.history.splice(0, Math.ceil(LIMITS.history / 10));
    if (this.blooms.length > LIMITS.blooms) this.blooms.splice(0, this.blooms.length - LIMITS.blooms);
  }

  private pruneSeen(cycle: number): void {
    if (this.seen.size < 4096) return;
    for (const [key, c] of this.seen) if (c < cycle - 4) this.seen.delete(key);
  }

  private newArchive(): void {
    const edge = Math.ceil(2 * SHADOW_EXTENT * this.L.R) + 4;
    this.archiveScale = Math.min(1, LIMITS.archivePx / edge);
    const size = Math.ceil(edge * this.archiveScale);
    this.archive = makeCanvas(size, size);
    this.actx = context2d(this.archive);
    // Archive drawing works in device px relative to the record centre, like the frame.
    this.actx.setTransform(this.archiveScale, 0, 0, this.archiveScale, size / 2, size / 2);
    this.paintLacquer(this.actx);
  }

  /** Redraws the archive from the kept history (after a resize or a change of side geometry). */
  private rebuildArchive(): void {
    this.fading = null;
    this.newArchive();
    if (this.cutTo !== null) {
      const to = this.cutTo;
      this.cutTo = null;
      this.cutGrooveTo(to);
    }
    for (const g of this.history) this.imprint(g);
    for (const m of this.etchMarks) this.imprintEtch(m);
  }

  /** The groove hairline, and a glossy land band for every track start the needle has passed. */
  private cutGrooveTo(cycle: number): void {
    const s = this.side.spec;
    if (this.cutTo === null) this.cutTo = s.startCycle;
    if (cycle - this.cutTo < GROOVE_STEP) return;
    const from = Math.max(this.cutTo, cycle - s.bars - 1);
    const g = this.actx;
    g.strokeStyle = 'rgba(128,116,150,0.34)';
    g.lineWidth = Math.max(0.5, this.L.pitch * 0.16);
    g.globalAlpha = 1;
    g.beginPath();
    for (let c = from; ; c = Math.min(cycle, c + GROOVE_STEP)) {
      const p = polar(this.radius(c), recordAngle(c));
      if (c === from) g.moveTo(p.x, p.y);
      else g.lineTo(p.x, p.y);
      if (c >= cycle) break;
    }
    g.stroke();
    for (const land of s.lands) if (land > this.cutTo && land <= cycle) this.imprintLand(land);
    this.cutTo = cycle;
  }

  private imprintLand(land: number): void {
    const L = this.L;
    const g = this.actx;
    const offset = (L.pitch + L.landW) / 2;
    // Between the track's last revolution and the next track's first: [land − 1, land) before the step.
    const trace = () => {
      g.beginPath();
      for (let c = land - 1; c <= land + 1e-9; c += GROOVE_STEP) {
        const p = polar(this.radius(Math.min(c, land - 1e-6)) - offset, recordAngle(c));
        if (c === land - 1) g.moveTo(p.x, p.y);
        else g.lineTo(p.x, p.y);
      }
    };
    g.lineCap = 'butt';
    g.strokeStyle = 'rgba(38,33,48,0.95)';
    g.lineWidth = L.landW * 0.9;
    trace();
    g.stroke();
    g.strokeStyle = 'rgba(239,231,214,0.07)';
    g.lineWidth = Math.max(0.5, L.landW * 0.22);
    trace();
    g.stroke();
  }

  private imprint(glyph: Glyph): void {
    const g = this.actx;
    const L = this.L;
    const p = L.pitch;
    const u = Math.max(1, this.dpr * 0.75);
    const r = this.radius(glyph.cycle) + glyph.lane * p * 0.9;
    const a0 = recordAngle(glyph.cycle);
    const color = VOICE_COLOR[glyph.family];
    const alpha = Math.min(0.85, (0.3 + glyph.gain * 0.55) * glyph.ink);
    g.strokeStyle = color;
    g.fillStyle = color;
    g.lineCap = 'butt';
    const arc = (length: number, width: number, a: number) => {
      g.globalAlpha = a;
      g.lineWidth = width;
      g.beginPath();
      g.arc(0, 0, r, canvasAngle(a0), canvasAngle(recordAngle(glyph.cycle + Math.max(length, 0.006))), true);
      g.stroke();
    };
    const dot = (radius: number, a: number) => {
      const pt = polar(r, a0);
      g.globalAlpha = a;
      g.beginPath();
      g.arc(pt.x, pt.y, radius, 0, TAU);
      g.fill();
    };
    const d = Math.min(1, glyph.duration);
    switch (glyph.family) {
      case 'kick': {
        // A radial notch across the groove: four-on-the-floor reads as four spokes.
        const inner = polar(r - p * 1.2, a0);
        const outer = polar(r + p * 1.2, a0);
        g.globalAlpha = Math.min(0.9, (0.45 + 0.5 * glyph.gain) * glyph.ink);
        g.lineWidth = Math.max(1.2 * u, p * 0.55);
        g.beginPath();
        g.moveTo(inner.x, inner.y);
        g.lineTo(outer.x, outer.y);
        g.stroke();
        break;
      }
      case 'snare':
        arc(0.014, Math.max(1.1 * u, p * 0.9), alpha);
        break;
      case 'hat':
        dot(Math.max(0.6 * u, p * 0.22), alpha * 0.9);
        break;
      case 'fx':
        dot(Math.max(0.5 * u, p * 0.18), alpha * 0.75);
        break;
      case 'pad':
        arc(d * 0.98, Math.max(u, p * 1.6), Math.min(0.12, glyph.ink * (0.6 + glyph.gain)));
        break;
      case 'keys':
        arc(Math.min(glyph.duration * 0.5, 0.03), Math.max(0.9 * u, p * 0.45), alpha * 0.85);
        break;
      case 'bass':
        arc(d * 0.85, Math.max(u, p * 0.5), alpha * 0.8);
        break;
      case 'lead':
        arc(d * 0.6, Math.max(0.9 * u, p * 0.4), alpha);
        break;
    }
    g.globalAlpha = 1;
  }

  /** A listener's reaction leaves a permanent tick in the lead-in at the bar it happened. */
  private imprintEtch(mark: EtchMark): void {
    const g = this.actx;
    const R = this.L.R;
    const a = recordAngle(mark.cycle);
    const inner = polar(R * 0.962, a);
    const outer = polar(R * 0.986, a);
    g.globalAlpha = mark.type === 'bored' || mark.type === 'move' ? 0.28 : 0.5;
    g.strokeStyle = INK.paper;
    g.lineWidth = Math.max(1, 0.6 * this.dpr);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(inner.x, inner.y);
    g.lineTo(outer.x, outer.y);
    g.stroke();
    g.globalAlpha = 1;
  }

  // ─── static layers ──────────────────────────────────────────────────────────────────────────

  /** The blank lacquer under the grooves: radially symmetric, so it can turn with the archive. */
  private paintLacquer(g: Ctx2D): void {
    const L = this.L;
    const R = L.R;
    const shadow = g.createRadialGradient(0, 0, R * 0.97, 0, 0, R * SHADOW_EXTENT);
    shadow.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = shadow;
    g.beginPath();
    g.arc(0, 0, R * SHADOW_EXTENT, 0, TAU);
    g.fill();
    const disc = g.createRadialGradient(0, 0, L.labelR, 0, 0, R);
    disc.addColorStop(0, '#141119');
    disc.addColorStop(0.5, INK.lacquer1);
    disc.addColorStop(0.93, '#110E16');
    disc.addColorStop(1, '#1B1722');
    g.fillStyle = disc;
    g.beginPath();
    g.arc(0, 0, R, 0, TAU);
    g.fill();
    // Lead-in: the glossy uncut band outside the first groove.
    g.strokeStyle = 'rgba(255,255,255,0.022)';
    g.lineWidth = R - L.outerR;
    g.beginPath();
    g.arc(0, 0, (R + L.outerR) / 2, 0, TAU);
    g.stroke();
    // Dead wax: matte ring between the last groove and the label.
    g.strokeStyle = 'rgba(255,255,255,0.016)';
    g.lineWidth = L.innerR - L.labelR;
    g.beginPath();
    g.arc(0, 0, (L.innerR + L.labelR) / 2, 0, TAU);
    g.stroke();
    if (this.tier === 'full') this.grain(g);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 2 * this.dpr;
    g.beginPath();
    g.arc(0, 0, R - 1.5 * this.dpr, 0, TAU);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = 1.2 * this.dpr;
    g.beginPath();
    g.arc(0, 0, R, 0, TAU);
    g.stroke();
  }

  /** Full tier only: faint lathe rings and dust, baked into the lacquer. */
  private grain(g: Ctx2D): void {
    const L = this.L;
    let seed = 7;
    const rand = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    g.lineWidth = Math.max(0.5, 0.5 * this.dpr);
    for (let r = L.innerR; r < L.outerR; r += 2.5 * this.dpr + rand() * 4 * this.dpr) {
      g.strokeStyle = `rgba(255,255,255,${(0.006 + rand() * 0.012).toFixed(4)})`;
      g.beginPath();
      g.arc(0, 0, r, 0, TAU);
      g.stroke();
    }
    const specks = Math.round((L.R * L.R) / (90 * this.dpr * this.dpr));
    g.fillStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i < specks; i++) {
      const r = L.labelR + rand() * (L.R - L.labelR);
      const a = rand() * TAU;
      g.fillRect(r * Math.cos(a), r * Math.sin(a), this.dpr * 0.8, this.dpr * 0.8);
    }
  }

  private renderLabels(): void {
    this.label = this.renderLabel(INK.labelPaper, '#F6EFDF', INK.labelInk, INK.clay);
    this.labelInverted = this.renderLabel(INK.clay, '#EC906F', INK.clayInk, INK.clayInk);
  }

  /** The paper label: the rim text and the off-centre clay spindle hole turn with the record. The title is DOM. */
  private renderLabel(paper: string, highlight: string, ink: string, hole: string): AnyCanvas {
    const r = this.L.labelR;
    const half = Math.ceil(r) + 2;
    const canvas = makeCanvas(half * 2, half * 2);
    const g = context2d(canvas);
    g.translate(half, half);
    const grd = g.createRadialGradient(-r * 0.25, -r * 0.3, 0, 0, 0, r);
    grd.addColorStop(0, highlight);
    grd.addColorStop(1, paper);
    g.fillStyle = grd;
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.fill();
    g.strokeStyle = rgba(ink, 0.35);
    g.lineWidth = Math.max(1, r * 0.01);
    for (const k of [0.9, 0.7]) {
      g.beginPath();
      g.arc(0, 0, r * k, 0, TAU);
      g.stroke();
    }
    const size = Math.max(6 * this.dpr, r * 0.072);
    g.font = `600 ${size.toFixed(1)}px ${RIM_FONT}`;
    g.fillStyle = ink;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const phrase = this.side.rimText;
    const textR = r * 0.8;
    const repeats = Math.max(1, Math.round((TAU * textR) / Math.max(1, g.measureText(phrase).width * 1.08)));
    const chars = [...phrase.repeat(repeats)];
    const step = TAU / chars.length;
    chars.forEach((ch, i) => {
      g.save();
      g.rotate(i * step);
      g.fillText(ch, 0, -textR);
      g.restore();
    });
    // The B-side quirk: the spindle hole is off-centre.
    g.fillStyle = hole;
    g.beginPath();
    g.arc(r * 0.09, -r * 0.05, Math.max(2 * this.dpr, r * 0.036), 0, TAU);
    g.fill();
    return canvas;
  }

  // ─── the frame ──────────────────────────────────────────────────────────────────────────────

  private render(cycle: number, cps: number, wallMs: number, look: Look): void {
    const g = this.ctx;
    const L = this.L;
    const calm = this.tier === 'calm';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.translate(L.cx, L.cy);
    // The platter turns clockwise one revolution per bar; only the fractional turn matters.
    const theta = calm ? 0 : TAU * (cycle - Math.floor(cycle));
    const thump = calm ? 1 : 1 + this.pulse * THUMP_SCALE;

    g.save();
    g.scale(thump, thump);
    g.save();
    g.rotate(theta);
    this.drawArchive(cycle);
    g.restore();
    if (!calm) this.drawLens(cycle);
    g.save();
    g.rotate(theta);
    g.globalCompositeOperation = 'lighter';
    this.drawGhosts(cycle, look, calm);
    this.drawBlooms(cycle, cps, calm);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    const label = look.inverted ? this.labelInverted : this.label;
    g.drawImage(label, -label.width / 2, -label.height / 2);
    this.drawEtches(wallMs, calm);
    g.restore();
    g.restore();

    if (!calm && look.shockwave !== null) this.drawShockwave(look.shockwave);
    this.drawSheen();
    this.drawStylus(cycle, thump, calm);
  }

  private drawArchive(cycle: number): void {
    const g = this.ctx;
    const f = this.fading;
    const k = f ? (cycle - f.from) / (f.to - f.from) : 1;
    if (f && (k >= 1 || k < 0)) this.fading = null;
    else if (f) {
      g.globalAlpha = 1 - smoothstep(k);
      this.drawScaled(f.canvas, f.scale);
      g.globalAlpha = smoothstep(k);
    }
    this.drawScaled(this.archive, this.archiveScale);
    g.globalAlpha = 1;
  }

  private drawScaled(image: AnyCanvas, scale: number): void {
    const w = image.width / scale;
    const h = image.height / scale;
    this.ctx.drawImage(image, -w / 2, -h / 2, w, h);
  }

  /** The loupe: a dark lens around the stylus where the groove opens into a curved staff. */
  private drawLens(cycle: number): void {
    const g = this.ctx;
    const L = this.L;
    const spread = this.smooth.spread * L.R;
    const sr = this.radius(cycle);
    const outer = sr + spread * 0.62;
    const inner = Math.max(L.labelR * 1.05, sr - spread * 0.62);
    const top = -Math.PI / 2;
    if (typeof g.createConicGradient === 'function') {
      const lens = g.createConicGradient(top - 1.1, 0, 0);
      lens.addColorStop(0, 'rgba(7,6,10,0)');
      lens.addColorStop(0.07, 'rgba(7,6,10,0.8)');
      lens.addColorStop(0.24, 'rgba(7,6,10,0.8)');
      lens.addColorStop(0.3, 'rgba(7,6,10,0)');
      lens.addColorStop(1, 'rgba(7,6,10,0)');
      g.fillStyle = lens;
    } else {
      g.fillStyle = 'rgba(7,6,10,0.6)';
    }
    g.beginPath();
    g.arc(0, 0, outer, top - 1.1, top + 0.8);
    g.arc(0, 0, inner, top + 0.8, top - 1.1, true);
    g.closePath();
    g.fill();
    const w = Math.max(1, 0.8 * this.dpr);
    g.lineWidth = w;
    g.strokeStyle = 'rgba(239,231,214,0.06)';
    for (const edge of [outer, inner]) {
      g.beginPath();
      g.arc(0, 0, edge, top - 0.95, top + 0.62);
      g.stroke();
    }
    for (const k of [-0.4, -0.2, 0, 0.2, 0.4]) {
      g.strokeStyle = k === 0 ? rgba(INK.clay, 0.3) : 'rgba(239,231,214,0.085)';
      g.beginPath();
      g.arc(0, 0, sr + k * spread, top - 0.95, top + 0.7);
      g.stroke();
    }
  }

  /** Pre-echo: next bar's events approach the needle, brightening as they come. */
  private drawGhosts(cycle: number, look: Look, calm: boolean): void {
    const g = this.ctx;
    const L = this.L;
    const bars = look.lookaheadBars;
    const spread = this.smooth.spread * L.R;
    for (const gh of this.ghosts) {
      const ahead = (gh.cycle - cycle) / bars;
      if (ahead <= 0 || ahead > 1) continue;
      const lanePx = calm ? L.pitch * 0.9 + 0.02 * L.R : spread;
      const p = polar(this.radius(gh.cycle) + gh.lane * lanePx, recordAngle(gh.cycle));
      const size = calm ? 0.018 * L.R + 2 * this.dpr : GHOST_SIZE[gh.family] * L.R + 2 * this.dpr;
      g.globalAlpha = calm
        ? 0.3
        : Math.pow(1 - ahead, 1.2) * 0.75 * (0.6 + 0.6 * this.levels.energy) * this.smooth.ghostAlpha;
      g.drawImage(this.sprites[gh.family], p.x - size / 2, p.y - size / 2, size, size);
    }
  }

  /** Sounding events bloom at full spread, then collapse into the groove as they turn away. */
  private drawBlooms(cycle: number, cps: number, calm: boolean): void {
    const g = this.ctx;
    const L = this.L;
    const spread = this.smooth.spread * L.R;
    const inGroove = L.pitch * 0.9;
    const keep: Glyph[] = [];
    for (const e of this.blooms) {
      const age = (cycle - e.cycle) / Math.max(0.01, cps);
      const end = e.duration / Math.max(0.01, cps);
      let alpha: number;
      let size: number;
      let lanePx: number;
      if (calm) {
        // Calm: a dot fades in over 150 ms where the event was cut, then fades; nothing moves.
        alpha = Math.min(1, age / TIME.calmFadeInSec) * Math.exp(-Math.max(0, age - 0.4) * 3);
        size = 0.03 * L.R;
        lanePx = inGroove;
      } else {
        const sustained = SUSTAINED_FAMILIES.has(e.family);
        const env = sustained && age < end ? 0.75 + 0.25 * Math.exp(-3 * age) : Math.exp(-5 * (age - (sustained ? end : 0)));
        const collapse = smoothstep(1 - age / TIME.bloomCollapseSec);
        const level = this.levels.parts[e.instance] ?? 0.5;
        alpha = Math.min(1, env * (0.35 + e.gain)) * (e.family === 'pad' ? 0.3 : 0.95);
        size = BLOOM_SIZE[e.family] * L.R * (0.6 + 0.5 * level) * (0.5 + 0.5 * collapse);
        lanePx = inGroove + collapse * (spread - inGroove);
      }
      if (alpha < 0.01 && age > 0.2) continue;
      keep.push(e);
      const p = polar(this.radius(e.cycle) + e.lane * lanePx, recordAngle(e.cycle));
      g.globalAlpha = alpha;
      g.drawImage(this.sprites[e.family], p.x - size / 2, p.y - size / 2, size, size);
    }
    this.blooms = keep;
  }

  /** Reactions float out of the rim at the bar they happened. */
  private drawEtches(wallMs: number, calm: boolean): void {
    if (!this.drifting.length) return;
    const g = this.ctx;
    const R = this.L.R;
    const dpr = this.dpr;
    this.drifting = this.drifting.filter((d) => wallMs - d.bornMs < TIME.etchDriftMs);
    for (const d of this.drifting) {
      const k = (wallMs - d.bornMs) / TIME.etchDriftMs;
      const p = polar(R * (1 + (calm ? 0 : 0.05 * k)), recordAngle(d.mark.cycle));
      const size = (7 + 7 * (1 - k)) * dpr;
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = (1 - k) * 0.85;
      g.drawImage(this.etchGlow, p.x - size / 2, p.y - size / 2, size, size);
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = (1 - k) * 0.5;
      g.strokeStyle = `hsl(${d.mark.hue} 55% 70%)`;
      g.lineWidth = Math.max(1, 0.7 * dpr);
      g.beginPath();
      g.arc(p.x, p.y, size * 0.32, 0, TAU);
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** The drop: one ring from the label to the rim over a beat. Never strobes (see flash.ts). */
  private drawShockwave(progress: number): void {
    const g = this.ctx;
    const L = this.L;
    const r = L.labelR + (L.R - L.labelR) * (1 - (1 - progress) ** 3);
    const fade = 1 - progress;
    g.strokeStyle = INK.paper;
    g.globalAlpha = 0.1 * fade;
    g.lineWidth = 0.07 * L.R * (1 - 0.4 * progress);
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.stroke();
    g.globalAlpha = 0.42 * fade;
    g.lineWidth = Math.max(1.5 * this.dpr, 0.008 * L.R);
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.stroke();
    g.globalAlpha = 1;
  }

  /** A fixed two-lobe highlight the record turns under: hue follows the needle (and the room's pull). */
  private drawSheen(): void {
    const g = this.ctx;
    if (typeof g.createConicGradient !== 'function') return;
    const L = this.L;
    const k = sheenIntensity(this.crowd.needle.y) + this.smooth.sheenBoost;
    const sat = Math.round(62 * this.smooth.sheenSaturation);
    const start = -Math.PI / 2 + 0.6;
    const sheen = g.createConicGradient(start, 0, 0);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.08, `hsl(${sheenHue(this.crowd.needle.x).toFixed(1)} ${sat}% 82% / ${k.toFixed(3)})`);
    sheen.addColorStop(0.16, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.58, `hsl(${sheenHue(this.crowd.pull.x).toFixed(1)} ${sat}% 78% / ${(k * 0.8).toFixed(3)})`);
    sheen.addColorStop(0.66, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    // Only the two lobes are filled: the rest of the gradient is transparent, and fill is the cost.
    g.beginPath();
    for (const from of [0, 0.5]) {
      const a0 = start + from * TAU;
      const a1 = a0 + 0.16 * TAU;
      g.moveTo(L.R * Math.cos(a0), L.R * Math.sin(a0));
      g.arc(0, 0, L.R, a0, a1);
      g.arc(0, 0, L.labelR, a1, a0, true);
      g.closePath();
    }
    g.fill();
  }

  /** Claude's cutting head: fixed at 12 o'clock, walking inward as the side fills (calm: a dot orbits). */
  private drawStylus(cycle: number, thump: number, calm: boolean): void {
    const g = this.ctx;
    const dpr = this.dpr;
    const silent = this.mood.silent;
    const sr = this.radius(cycle) * thump + (silent ? STYLUS_LIFT_CSS * dpr : 0);
    const tip = calm ? polar(sr, recordAngle(cycle)) : { x: 0, y: -sr };
    if (!calm) this.drawTonearm(tip.x, tip.y);
    const hot = calm || silent ? 0.3 : this.levels.master;
    const glow = (14 + 12 * hot) * dpr;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = silent ? 0.45 : 0.9;
    g.drawImage(this.stylusGlow, tip.x - glow / 2, tip.y - glow / 2, glow, glow);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = INK.clay;
    g.beginPath();
    g.arc(tip.x, tip.y, (calm ? 2.5 : 2.2) * dpr, 0, TAU);
    g.fill();
    if (calm) {
      // The only thing that moves in Calm: make it easy to find.
      g.globalAlpha = 0.6;
      g.strokeStyle = INK.paper;
      g.lineWidth = 1.2 * dpr;
      g.beginPath();
      g.arc(tip.x, tip.y, 5.5 * dpr, 0, TAU);
      g.stroke();
      g.globalAlpha = 1;
    }
  }

  private drawTonearm(sx: number, sy: number): void {
    const g = this.ctx;
    const R = this.L.R;
    const dpr = this.dpr;
    // Pivot at the top right, pulled in where the canvas is barely wider than the record (phones).
    const px = Math.min(R * 0.98, this.canvas.width / 2 - 34 * dpr);
    const py = Math.max(-R * 1.04, -this.canvas.height / 2 + 20 * dpr);
    // The arm ends at the back of the headshell, up and right of the stylus tip.
    const hx = sx + 10 * dpr;
    const hy = sy - 8 * dpr;
    const cx = px - R * 0.15;
    const cy = sy - R * 0.25;
    const arm = () => {
      g.beginPath();
      g.moveTo(px, py);
      g.quadraticCurveTo(cx, cy, hx, hy);
    };
    g.lineCap = 'round';
    g.save();
    g.translate(2 * dpr, 3 * dpr);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 5 * dpr;
    arm();
    g.stroke();
    g.restore();
    g.strokeStyle = INK.metal;
    g.lineWidth = 3.2 * dpr;
    arm();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.32)';
    g.lineWidth = dpr;
    arm();
    g.stroke();
    // Counterweight behind the pivot, along the arm.
    const back = Math.atan2(py - cy, px - cx);
    g.save();
    g.translate(px + Math.cos(back) * 13 * dpr, py + Math.sin(back) * 13 * dpr);
    g.rotate(back);
    g.fillStyle = '#4A4452';
    g.fillRect(-6 * dpr, -6 * dpr, 12 * dpr, 12 * dpr);
    g.restore();
    g.fillStyle = INK.lacquer3;
    g.strokeStyle = '#6D6577';
    g.lineWidth = dpr;
    g.beginPath();
    g.arc(px, py, 10 * dpr, 0, TAU);
    g.fill();
    g.stroke();
    g.fillStyle = INK.metalLight;
    g.beginPath();
    g.arc(px, py, 4.5 * dpr, 0, TAU);
    g.fill();
    // Headshell: a tapered plate from the end of the arm to just past the stylus.
    const along = Math.atan2(sy - hy, sx - hx);
    const length = Math.hypot(sx - hx, sy - hy) + 3 * dpr;
    g.save();
    g.translate(hx, hy);
    g.rotate(along);
    g.fillStyle = INK.headshell;
    g.strokeStyle = 'rgba(221,213,199,0.6)';
    g.lineWidth = dpr;
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(-2 * dpr, -3.5 * dpr);
    g.lineTo(length, -5.5 * dpr);
    g.lineTo(length, 5.5 * dpr);
    g.lineTo(-2 * dpr, 3.5 * dpr);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
  }
}
