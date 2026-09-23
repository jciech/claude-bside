// createLathe: the UI's only handle on the record renderer (src/client/render/protocol.ts). It moves
// the canvas into a module worker when OffscreenCanvas is available (measured: main-thread
// rendering starved Strudel's scheduler) and otherwise runs the same renderer on the main thread,
// feeds it from the engine (feed.ts), picks the tier (the user's choice as a ceiling, lowered on
// frame-time, long-task or scheduler trouble), and pauses with the tab.
import type { EtchType } from '../../shared/music.ts';
import type { MovementInfo } from '../../shared/program.ts';
import type { PadPoint } from '../../shared/protocol.ts';
import type { Engine } from '../engine/types.ts';
import { epochNow } from './clock.ts';
import { EngineFeed } from './feed.ts';
import type { CreateLathe, FromRenderer, LabelState, LatheHost, LatheOptions, RenderPrefs, RenderTier, SideSection, ToRenderer } from './protocol.ts';
import { createRenderer, type Renderer } from './renderer.ts';
import { resolveTier, TierGovernor, type ResolvedTier } from './tiers.ts';

export type { LabelState } from './protocol.ts';

type Stats = { p95FrameMs: number; fps: number };
type Etch = { type: EtchType; cycle: number; hue: number };

/** Frame rate of the main-thread fallback: it shares the thread with the audio scheduler. */
const MAIN_THREAD_FPS = 30;

class Host implements LatheHost {
  private canvas: HTMLCanvasElement;
  private readonly engine: Engine;
  private post: (message: ToRenderer) => void = () => {};
  private worker: Worker | null = null;
  private local: Renderer | null = null;
  private ready = false;
  private destroyed = false;
  private feed: EngineFeed;
  private readonly governor = new TierGovernor(performance.now());
  private userTier: RenderTier;
  private prefs: RenderPrefs;
  private resolved: ResolvedTier;
  private size: { width: number; height: number; dpr: number };
  private userPaused = false;
  private hidden = false;
  private paused = false;
  /** Latest UI-supplied state, replayed if the worker fails and the main thread takes over. */
  private replay: {
    side: { movement: MovementInfo | null; sections: SideSection[] } | null;
    crowd: { pull: PadPoint; needle: PadPoint } | null;
    etches: Etch[];
  } = { side: null, crowd: null, etches: [] };
  private readonly statsListeners = new Set<(s: Stats) => void>();
  private readonly labelListeners = new Set<(s: LabelState) => void>();
  private label: LabelState = { inverted: false, listening: false };
  private readonly cleanups: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement, engine: Engine, options: LatheOptions) {
    this.canvas = canvas;
    this.engine = engine;
    this.userTier = options.tier;
    this.prefs = { contrastMore: options.prefs?.contrastMore ?? false };
    this.size = {
      width: canvas.clientWidth || canvas.width,
      height: canvas.clientHeight || canvas.height,
      dpr: globalThis.devicePixelRatio || 1,
    };
    this.resolved = resolveTier(this.userTier, 0);
    if (!(options.useWorker && this.startWorker())) this.startLocal();
    this.feed = this.createFeed();
    this.watchPage();
    this.feed.start();
  }

  // ─── LatheHost ──────────────────────────────────────────────────────────────────────────────

  resize(width: number, height: number, dpr: number): void {
    this.size = { width, height, dpr };
    this.post({ type: 'resize', width, height, dpr: this.dpr() });
  }

  setTier(tier: RenderTier): void {
    this.userTier = tier;
    this.governor.reset(performance.now());
    this.applyTier(true);
  }

  setPrefs(prefs: RenderPrefs): void {
    if (prefs.contrastMore === this.prefs.contrastMore) return;
    this.prefs = { contrastMore: prefs.contrastMore };
    this.post({ type: 'prefs', contrastMore: prefs.contrastMore });
  }

  pause(paused: boolean): void {
    this.userPaused = paused;
    this.syncPause();
  }

  setSide(movement: MovementInfo | null, sections: SideSection[]): void {
    this.replay.side = { movement, sections };
    this.post({ type: 'side', movement, sections });
    this.feed.setSide(movement);
  }

  setCrowd(pull: PadPoint, needle: PadPoint): void {
    this.replay.crowd = { pull, needle };
    this.post({ type: 'crowd', pull, needle });
  }

  etch(etches: Etch[]): void {
    this.replay.etches = etches;
    this.post({ type: 'etch', etches });
  }

  on(event: 'stats', listener: (s: Stats) => void): () => void;
  on(event: 'label', listener: (s: LabelState) => void): () => void;
  on(event: 'stats' | 'label', listener: ((s: Stats) => void) | ((s: LabelState) => void)): () => void {
    if (event === 'stats') {
      const l = listener as (s: Stats) => void;
      this.statsListeners.add(l);
      return () => this.statsListeners.delete(l);
    }
    const l = listener as (s: LabelState) => void;
    this.labelListeners.add(l);
    l(this.label);
    return () => this.labelListeners.delete(l);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.feed.stop();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.worker?.terminate();
    this.local?.destroy();
    this.post = () => {};
    this.statsListeners.clear();
    this.labelListeners.clear();
  }

  // ─── transport ──────────────────────────────────────────────────────────────────────────────

  private dpr(): number {
    return Math.min(this.size.dpr, this.resolved.dprCap);
  }

  private initMessage(canvas: OffscreenCanvas | HTMLCanvasElement): ToRenderer {
    return { type: 'init', canvas, width: this.size.width, height: this.size.height, dpr: this.dpr(), tier: this.resolved.tier, contrastMore: this.prefs.contrastMore };
  }

  private startWorker(): boolean {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof this.canvas.transferControlToOffscreen !== 'function') {
      return false;
    }
    let worker: Worker;
    let offscreen: OffscreenCanvas;
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'lathe' });
    } catch {
      return false;
    }
    try {
      offscreen = this.transferCanvas();
    } catch {
      worker.terminate();
      return false;
    }
    worker.onmessage = (event: MessageEvent<FromRenderer>) => this.receive(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.workerFailed(event.message);
    };
    this.worker = worker;
    this.post = (message) => worker.postMessage(message);
    worker.postMessage(this.initMessage(offscreen), [offscreen]);
    return true;
  }

  /** A canvas can be transferred once; a second createLathe on the same element draws on a fresh copy. */
  private transferCanvas(): OffscreenCanvas {
    try {
      return this.canvas.transferControlToOffscreen();
    } catch {
      this.replaceCanvas();
      return this.canvas.transferControlToOffscreen();
    }
  }

  private replaceCanvas(): void {
    const fresh = this.canvas.cloneNode(false) as HTMLCanvasElement;
    this.canvas.replaceWith(fresh);
    this.canvas = fresh;
  }

  private startLocal(): void {
    try {
      this.canvas.getContext('2d');
    } catch {
      this.replaceCanvas();
    }
    this.resolved = resolveTier(this.userTier, this.governor.level, true);
    const renderer = createRenderer((message) => this.receive(message), { fpsCap: MAIN_THREAD_FPS });
    this.local = renderer;
    this.post = (message) => renderer.handle(message);
    renderer.handle(this.initMessage(this.canvas));
  }

  /**
   * The worker never came up (e.g. no module workers, or a CSP without worker-src). The transferred
   * canvas can't be drawn from this thread, so startLocal puts a fresh copy of the element in its place.
   */
  private workerFailed(message: string): void {
    if (this.ready || this.destroyed || !this.worker) {
      console.warn('[lathe] worker error:', message);
      return;
    }
    console.warn('[lathe] render worker failed, drawing on the main thread:', message);
    this.worker.terminate();
    this.worker = null;
    this.startLocal();
    if (this.paused) this.post({ type: 'pause', paused: true });
    this.feed.stop();
    this.feed = this.createFeed();
    this.feed.setPaused(this.paused);
    this.feed.start();
    const { side, crowd, etches } = this.replay;
    if (side) this.setSide(side.movement, side.sections);
    if (crowd) this.setCrowd(crowd.pull, crowd.needle);
    if (etches.length) this.etch(etches);
  }

  private receive(message: FromRenderer): void {
    if (this.destroyed) return;
    switch (message.type) {
      case 'ready':
        this.ready = true;
        break;
      case 'stats': {
        const stats = { p95FrameMs: message.p95FrameMs, fps: message.fps };
        for (const l of this.statsListeners) l(stats);
        const capped = this.local !== null || this.resolved.tier === 'calm';
        if (this.governor.onStats(stats.p95FrameMs, stats.fps, capped, performance.now())) this.applyTier();
        break;
      }
      case 'error':
        console.warn('[lathe]', message.message);
        break;
    }
  }

  private createFeed(): EngineFeed {
    return new EngineFeed({
      engine: this.engine,
      send: (message) => this.post(message),
      epochNow,
      onLabel: (state) => {
        this.label = state;
        for (const l of this.labelListeners) l(state);
      },
    });
  }

  // ─── tiers and pausing ──────────────────────────────────────────────────────────────────────

  private applyTier(force = false): void {
    const next = resolveTier(this.userTier, this.governor.level, this.local !== null);
    const prev = this.resolved;
    this.resolved = next;
    if (force || next.tier !== prev.tier) this.post({ type: 'tier', tier: next.tier });
    if (next.dprCap !== prev.dprCap) this.post({ type: 'resize', width: this.size.width, height: this.size.height, dpr: this.dpr() });
  }

  private syncPause(): void {
    const paused = this.userPaused || this.hidden;
    if (paused === this.paused) return;
    this.paused = paused;
    this.post({ type: 'pause', paused });
    this.feed.setPaused(paused);
  }

  private watchPage(): void {
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        this.hidden = document.visibilityState === 'hidden';
        this.syncPause();
      };
      onVisibility();
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
    this.cleanups.push(
      this.engine.on('health', (h) => {
        if (h.skips > 0 && !this.paused && this.governor.onSchedulerSkip(performance.now())) this.applyTier();
      }),
    );
    if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      const observer = new PerformanceObserver((list) => {
        list.getEntries().forEach(() => {
          if (!this.paused && this.governor.onLongTask(performance.now())) this.applyTier();
        });
      });
      observer.observe({ type: 'longtask' });
      this.cleanups.push(() => observer.disconnect());
    }
  }
}

export const createLathe: CreateLathe = (canvas, engine, options) => new Host(canvas, engine, options);
