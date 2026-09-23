// The render loop behind the protocol: handles ToRenderer messages, runs its own animation frames
// against the epoch-time clock, and reports frame stats. The worker entry and the main-thread
// fallback both wrap this, so the two paths draw identically.
import { epochNow, RenderClock } from './clock.ts';
import { Lathe } from './lathe.ts';
import type { FromRenderer, RenderTier, ToRenderer } from './protocol.ts';
import { loadRimFont } from './surface.ts';

export interface Renderer {
  handle(message: ToRenderer): void;
  destroy(): void;
}

export interface RendererOptions {
  /** Frame-rate cap for this thread (the main-thread fallback shares it with the audio scheduler). */
  fpsCap: number | null;
}

const CALM_FPS = 30;
const STATS_WINDOW_MS = 1000;
const ERROR_REPORT_INTERVAL_MS = 5000;

type FrameRequest = (callback: (time: number) => void) => number;

const requestFrame: FrameRequest =
  typeof globalThis.requestAnimationFrame === 'function'
    ? (cb) => globalThis.requestAnimationFrame(cb)
    : (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
const cancelFrame: (id: number) => void =
  typeof globalThis.cancelAnimationFrame === 'function' ? (id) => globalThis.cancelAnimationFrame(id) : (id) => clearTimeout(id);

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
}

export function createRenderer(emit: (message: FromRenderer) => void, options: RendererOptions): Renderer {
  const clock = new RenderClock();
  let lathe: Lathe | null = null;
  let tier: RenderTier = 'full';
  let paused = false;
  let frameId: number | null = null;
  let lastDrawAt = Number.NEGATIVE_INFINITY;
  let windowStart = 0;
  let workTimes: number[] = [];
  let lastErrorAt = Number.NEGATIVE_INFINITY;

  const report = (e: unknown) => {
    const now = performance.now();
    if (now - lastErrorAt < ERROR_REPORT_INTERVAL_MS) return;
    lastErrorAt = now;
    emit({ type: 'error', message: e instanceof Error ? `${e.message}` : String(e) });
  };

  const cycleNow = () => clock.cycleAt(epochNow());

  const schedule = () => {
    if (frameId === null && lathe && !paused) frameId = requestFrame(frame);
  };

  const stop = () => {
    if (frameId !== null) cancelFrame(frameId);
    frameId = null;
  };

  function frame(): void {
    frameId = null;
    if (!lathe || paused) return;
    schedule();
    const now = performance.now();
    const cap = Math.min(options.fpsCap ?? Infinity, tier === 'calm' ? CALM_FPS : Infinity);
    // 2 ms of slack so a 60 Hz display still lands every other vsync at a 30 fps cap.
    if (now - lastDrawAt < 1000 / cap - 2 || !clock.ready) return;
    lastDrawAt = now;
    try {
      lathe.draw(cycleNow(), clock.cps(), now);
    } catch (e) {
      report(e);
    }
    workTimes.push(performance.now() - now);
    if (now - windowStart >= STATS_WINDOW_MS) {
      if (windowStart > 0) emit({ type: 'stats', p95FrameMs: p95(workTimes), fps: (workTimes.length * 1000) / (now - windowStart) });
      windowStart = now;
      workTimes = [];
    }
  }

  function apply(m: ToRenderer): void {
    if (m.type === 'init') {
      tier = m.tier;
      lathe = new Lathe(m.canvas, m.width, m.height, m.dpr, m.tier);
      void loadRimFont().then((loaded) => {
        if (loaded) lathe?.refreshLabel();
      });
      emit({ type: 'ready' });
      schedule();
      return;
    }
    if (!lathe) return;
    switch (m.type) {
      case 'resize':
        lathe.resize(m.width, m.height, m.dpr);
        break;
      case 'tier':
        tier = m.tier;
        lathe.setTier(m.tier);
        break;
      case 'pause':
        paused = m.paused;
        windowStart = 0;
        workTimes = [];
        if (paused) stop();
        else schedule();
        break;
      case 'clock':
        clock.update(m.sample, epochNow());
        break;
      case 'events':
        lathe.addEvents(m.events, cycleNow(), paused);
        break;
      case 'lookahead':
        lathe.setLookahead(m.events);
        break;
      case 'side':
        lathe.setSide(m.movement, m.sections, cycleNow());
        break;
      case 'levels':
        lathe.setLevels(m.master, m.parts, m.energy);
        break;
      case 'crowd':
        lathe.setCrowd(m.pull, m.needle);
        break;
      case 'etch':
        lathe.addEtches(m.etches, cycleNow(), performance.now());
        break;
      case 'moment':
        lathe.addMoment(m.kind, m.cycle);
        break;
    }
  }

  return {
    handle(message) {
      try {
        apply(message);
      } catch (e) {
        report(e);
      }
    },
    destroy() {
      stop();
      lathe = null;
    },
  };
}
