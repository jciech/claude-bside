// Lathe harness page (driven by run.ts): createLathe on a fake engine and a fake clock (or the real
// engine), fed like the Record component would feed it.
// URL: ?tier=full|lite|calm&worker=0|1&start=<cycle>&running=0|1
//      &engine=real (the performer engine on test/fixtures/snapshot.json; #unlock starts audio)
//      &nextside=<cycle> (a new side, committed ahead, starts there)
//      &breakworker=1 (the render worker fails to load: exercises the main-thread fallback)
//      &twice=1 (a first host on the same canvas is created and destroyed, as a remount would)
//      &novis=1 (engine only: a main-thread baseline)
import '@fontsource-variable/anybody';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/newsreader/wght-italic.css';
import { createLathe, type LabelState } from '../../../src/client/render/host.ts';
import type { RenderTier } from '../../../src/client/render/protocol.ts';
import type { EtchType } from '../../../src/shared/music.ts';
import { FakeEngine, MOVEMENT, sideSections } from './fake-engine.ts';
import { realRoom, type Room } from './real-engine.ts';

const params = new URLSearchParams(location.search);
const tier = (params.get('tier') ?? 'full') as RenderTier;
const useWorker = params.get('worker') !== '0';
const start = Number(params.get('start') ?? 70);

const room: Room =
  params.get('engine') === 'real'
    ? await realRoom(start)
    : {
        engine: new FakeEngine({ startCycle: start, t0Ms: performance.timeOrigin + performance.now(), cps: 0.5, running: params.get('running') !== '0' }),
        movement: MOVEMENT,
        sections: sideSections(),
        unlock: null,
      };
const engine = room.engine;

const canvas = document.getElementById('lathe') as HTMLCanvasElement;
const label = document.getElementById('label')!;
const title = document.getElementById('title')!;
const wrap = canvas.parentElement!;

const state = {
  ready: false,
  worker: useWorker,
  stats: [] as { p95FrameMs: number; fps: number; at: number }[],
  labels: [] as (LabelState & { cycle: number })[],
  longTasks: 0,
  /** Main-thread animation-frame gaps (ms): jank shows up here. */
  gaps: [] as number[],
  unlocked: false,
  haps: 0,
  schedulerSkips: 0,
};
engine.on('hap', () => state.haps++);
engine.on('health', (h) => (state.schedulerSkips += h.skips));
const unlockButton = document.getElementById('unlock') as HTMLButtonElement;
unlockButton.hidden = !room.unlock;
unlockButton.addEventListener('click', () => {
  unlockButton.hidden = true;
  void room.unlock?.().then(() => (state.unlocked = true));
});
let lastFrame = performance.now();
const frame = (t: number) => {
  state.gaps.push(t - lastFrame);
  lastFrame = t;
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
  new PerformanceObserver((list) => (state.longTasks += list.getEntries().length)).observe({ type: 'longtask' });
}
Object.assign(window, { __lathe: state, __now: () => engine.now(), __originalCanvas: canvas });
if (params.has('breakworker')) {
  // A worker whose script never loads (e.g. a CSP without worker-src): it errors asynchronously.
  (globalThis as { Worker: unknown }).Worker = class {
    onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
    onmessage: unknown = null;
    constructor() {
      setTimeout(() => this.onerror?.({ message: 'blocked by the harness', preventDefault() {} }), 50);
    }
    postMessage(): void {}
    terminate(): void {}
  };
}
if (params.has('novis')) {
  canvas.parentElement!.querySelector('.label')?.remove();
  state.ready = true;
} else {
  startLathe();
}

function startLathe(): void {
  if (params.has('twice')) createLathe(canvas, engine, { tier, useWorker }).destroy();
  const host = createLathe(canvas, engine, { tier, useWorker });
  host.on('stats', (s) => state.stats.push({ ...s, at: engine.now() }));
  let listening = false;
  host.on('label', (s) => {
    state.labels.push({ ...s, cycle: engine.now() });
    label.classList.toggle('inverted', s.inverted);
    listening = s.listening;
    showTitle();
  });

  function showTitle(): void {
    title.textContent = listening ? '— listening —' : (engine.sectionAt(engine.now())?.name ?? '');
  }
  setInterval(showTitle, 250);

  function fit(): void {
    const { width, height } = wrap.getBoundingClientRect();
    host.resize(width, height, devicePixelRatio);
    const labelPx = 0.93 * Math.min(width, height) * 0.3;
    label.style.width = `${labelPx}px`;
    title.style.fontSize = `${Math.max(12, labelPx * 0.12)}px`;
  }
  new ResizeObserver(fit).observe(wrap);
  fit();

  host.setSide(room.movement, room.sections);
  const nextSide = params.get('nextside');
  if (nextSide !== null) {
    const at = Number(nextSide);
    const sections = sideSections().filter((s) => s.startCycle >= at);
    host.setSide({ ...MOVEMENT, id: 'fx01-m2', side: 3, name: 'Night Ferry', bpm: 120, startCycle: at, plannedBars: 96 }, sections);
  }

  // The room: the needle leans bright and intense, the pull a little behind it.
  setInterval(() => {
    const t = engine.now();
    host.setCrowd({ x: 0.45, y: 0.2 }, { x: 0.2 + 0.2 * Math.sin(t / 8), y: 0.4 });
  }, 250);
  host.setCrowd({ x: 0.45, y: 0.2 }, { x: 0.2, y: 0.4 });

  // Reactions arrive in crowd frames: everything of the last 16 bars, every frame (the renderer dedupes).
  const etches: { type: EtchType; cycle: number; hue: number }[] = [];
  const types: EtchType[] = ['fire', 'fire', 'vibe', 'stay', 'move', 'harsh'];
  for (let c = start - 16; c < start; c += 0.7) etches.push({ type: types[Math.floor(c * 7) % types.length]!, cycle: c, hue: Math.floor(c * 30) % 360 });
  setInterval(() => {
    const now = engine.now();
    if (Math.random() < 0.3) etches.push({ type: types[Math.floor(Math.random() * types.length)]!, cycle: now, hue: Math.floor(Math.random() * 12) * 30 });
    host.etch(etches.filter((e) => e.cycle > now - 16));
  }, 250);

  Object.assign(window, {
    __setTier: (t: RenderTier) => host.setTier(t),
    __pause: (p: boolean) => host.pause(p),
  });
  state.ready = true;
}
