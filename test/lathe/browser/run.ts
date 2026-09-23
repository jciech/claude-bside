// Real-browser verification of the Lathe (not part of `npm test`):
//   node --disable-warning=ExperimentalWarning test/lathe/browser/run.ts <shots|perf|all> <outDir> [nameFilter]
// Serves the harness page, drives createLathe with a fake engine in headless Chromium, takes
// screenshots per viewport × tier and for the musical moments, and measures main-thread busy time
// and the worker's frame times. Prints PASS/FAIL lines; exits non-zero on failure.
import { chromium, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] ?? 'all';
const outArg = process.argv[3];
if (!outArg) throw new Error('usage: run.ts <shots|perf|all> <outDir>');
const out: string = outArg;
const only = new RegExp(process.argv[4] ?? '.');
mkdirSync(out, { recursive: true });

const BASE = 'http://localhost:5198/';
const DESKTOP: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const DESKTOP_HIDPI: BrowserContextOptions = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

type Harness = {
  ready: boolean;
  unlocked: boolean;
  haps: number;
  schedulerSkips: number;
  stats: { p95FrameMs: number; fps: number; at: number }[];
  labels: { inverted: boolean; listening: boolean; cycle: number }[];
  longTasks: number;
  gaps: number[];
};

let failures = 0;
const check = (name: string, ok: boolean, detail: unknown = '') => {
  if (!ok) failures++;
  const d = detail === '' ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${d}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(2);
};

async function open(browser: Browser, context: BrowserContextOptions, query: string, unlock = false) {
  const ctx = await browser.newContext(context);
  const page = await ctx.newPage();
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}?${query}`);
  await page.waitForFunction(() => (window as unknown as { __lathe?: Harness }).__lathe?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
  if (unlock) {
    await page.click('#unlock');
    await page.waitForFunction(() => (window as unknown as { __lathe: Harness }).__lathe.unlocked, null, { timeout: 30_000 });
  }
  return { page, logs, close: () => ctx.close() };
}

const harness = (page: Page) => page.evaluate(() => (window as unknown as { __lathe: Harness }).__lathe);
const cycleOf = (page: Page) => page.evaluate(() => (window as unknown as { __now: () => number }).__now());
async function waitCycle(page: Page, cycle: number): Promise<void> {
  for (;;) {
    const c = await cycleOf(page);
    if (c >= cycle) return;
    await sleep(Math.max(5, Math.min(500, (cycle - c) * 2000 - 30)));
  }
}

function noErrors(tag: string, logs: string[]): void {
  const bad = logs.filter((l) => /\[pageerror\]|\[error\]|\[warning\].*lathe/i.test(l));
  check(`${tag}: no page errors or renderer warnings`, bad.length === 0, bad.slice(0, 3));
}

interface Shot {
  name: string;
  context: BrowserContextOptions;
  query: string;
  /** Screenshot when the fake clock reaches this cycle. */
  at: number;
  /** A console warning this scenario provokes on purpose. */
  expectWarning?: RegExp;
  /** Click "Drop the needle" (real engine: start audio). */
  unlock?: boolean;
  verify?: (h: Harness, logs: string[], page: Page) => void | Promise<void>;
}

const shots: Shot[] = [
  ...(['full', 'lite', 'calm'] as const).flatMap((tier) => [
    { name: `desktop-${tier}`, context: DESKTOP, query: `tier=${tier}&start=70`, at: 72.4 },
    { name: `phone-${tier}`, context: PHONE, query: `tier=${tier}&start=70`, at: 72.4 },
  ]),
  { name: 'desktop-hidpi-full', context: DESKTOP_HIDPI, query: 'tier=full&start=70', at: 72.4 },
  {
    name: 'desktop-drop',
    context: DESKTOP,
    query: 'tier=full&start=39.2',
    at: 40.07,
    verify: (h) => check('drop: DOM label inverts for the bar after the downbeat', h.labels.some((l) => l.inverted && l.cycle >= 40 && l.cycle < 40.2), h.labels),
  },
  { name: 'phone-drop', context: PHONE, query: 'tier=full&start=39.2', at: 40.07 },
  { name: 'desktop-drop-calm', context: DESKTOP, query: 'tier=calm&start=39.2', at: 40.1 },
  { name: 'desktop-build', context: DESKTOP, query: 'tier=full&start=36', at: 38.2 },
  { name: 'desktop-breakdown', context: DESKTOP, query: 'tier=full&start=58.5', at: 60.6 },
  {
    name: 'desktop-landing',
    context: DESKTOP,
    query: 'tier=full&start=70&running=0',
    at: 72.4,
  },
  {
    name: 'desktop-silence',
    context: DESKTOP,
    query: 'tier=full&start=120.5',
    at: 122.5,
    verify: (h) => check('silence: DOM label shows "listening"', h.labels.at(-1)?.listening === true, h.labels.at(-1)),
  },
  {
    name: 'desktop-main-thread',
    context: DESKTOP,
    query: 'tier=full&start=70&worker=0',
    at: 72.4,
    verify: async (_h, _logs, page) =>
      check('main thread: the label rim font loaded', await page.evaluate(() => document.fonts.check('12px "Lathe Mono"'))),
  },
  {
    name: 'desktop-worker-fallback',
    context: DESKTOP,
    query: 'tier=full&start=70&breakworker=1',
    at: 72.4,
    expectWarning: /render worker failed/,
    verify: async (h, logs, page) => {
      const replaced = await page.evaluate(() => {
        const w = window as unknown as { __originalCanvas: HTMLCanvasElement };
        const now = document.querySelector('.record canvas');
        return now !== null && now !== w.__originalCanvas && !w.__originalCanvas.isConnected;
      });
      check('worker failure: a fresh canvas replaced the transferred one', replaced);
      check('worker failure: the main thread renders and reports stats', h.stats.length > 0, h.stats.slice(-1));
      check('worker failure: the failure was reported once', logs.filter((l) => /render worker failed/.test(l)).length === 1);
    },
  },
  {
    name: 'desktop-created-twice',
    context: DESKTOP,
    query: 'tier=full&start=70&twice=1',
    at: 72.4,
    verify: (h) => check('remount: a second host on an already-transferred canvas still renders', h.stats.length > 0, h.stats.slice(-1)),
  },
  { name: 'desktop-side-change-fade', context: DESKTOP, query: 'tier=full&start=86&nextside=88', at: 88.35 },
  { name: 'desktop-side-change-new', context: DESKTOP, query: 'tier=full&start=86&nextside=88', at: 91.5 },
  { name: 'phone-late-join', context: PHONE, query: 'tier=full&start=101', at: 102.4 },
  {
    name: 'desktop-real-landing',
    context: DESKTOP,
    query: 'engine=real&tier=full&start=12',
    at: 14.4,
    verify: (h) => check('real engine, before the unlock: no haps, the record plays from queries', h.haps === 0 && h.stats.length > 0, { haps: h.haps }),
  },
  {
    name: 'desktop-real-playing',
    context: DESKTOP,
    query: 'engine=real&tier=full&start=12',
    unlock: true,
    at: 17.2,
    verify: (h) => {
      check('real engine: haps flow to the renderer after the unlock', h.unlocked && h.haps > 20, { haps: h.haps });
      check('real engine: no scheduler skips while the Lathe runs', h.schedulerSkips === 0, { skips: h.schedulerSkips });
    },
  },
];

/** Tier switches, pausing and a viewport change while running, as the UI would do them. */
async function dynamics(browser: Browser): Promise<void> {
  const { page, logs, close } = await open(browser, DESKTOP, 'tier=full&start=70');
  const call = (fn: string, arg: unknown) => page.evaluate(([f, a]) => (window as unknown as Record<string, (x: unknown) => void>)[f as string]!(a), [fn, arg]);
  await waitCycle(page, 71);
  await call('__setTier', 'calm');
  await waitCycle(page, 71.8);
  await call('__setTier', 'lite');
  await waitCycle(page, 72.4);
  await call('__pause', true);
  await sleep(1500);
  const before = (await harness(page)).stats.length;
  await sleep(1200);
  const whilePaused = (await harness(page)).stats.length - before;
  await call('__pause', false);
  const resumedAt = await cycleOf(page);
  await page.setViewportSize({ width: 1100, height: 760 });
  await call('__setTier', 'full');
  await waitCycle(page, resumedAt + 1.4);
  await page.screenshot({ path: join(out, 'desktop-after-dynamics.png') });
  const h = await harness(page);
  noErrors('dynamics', logs);
  check('dynamics: no frames while paused', whilePaused === 0, { whilePaused });
  check('dynamics: frames resume after unpausing', h.stats.some((s) => s.at > resumedAt), h.stats.slice(-2));
  console.log('      shot desktop-after-dynamics.png');
  await close();
}

async function takeShots(browser: Browser): Promise<void> {
  for (const s of shots.filter((x) => only.test(x.name))) {
    const { page, logs, close } = await open(browser, s.context, s.query, s.unlock);
    await waitCycle(page, s.at);
    await page.screenshot({ path: join(out, `${s.name}.png`) });
    const h = await harness(page);
    noErrors(s.name, s.expectWarning ? logs.filter((l) => !s.expectWarning!.test(l)) : logs);
    const q = new URLSearchParams(s.query);
    const ranBars = s.at - Number(q.get('start'));
    if (q.get('worker') !== '0' && ranBars >= 2) check(`${s.name}: the worker reports frame stats`, h.stats.length > 0, h.stats.slice(-1));
    await s.verify?.(h, logs, page);
    console.log(`      shot ${s.name}.png at cycle ${(await cycleOf(page)).toFixed(2)}`);
    await close();
  }
}

interface PerfRun {
  name: string;
  context: BrowserContextOptions;
  query: string;
  throttle: number;
  unlock?: boolean;
}

async function measure(browser: Browser, run: PerfRun): Promise<Record<string, unknown>> {
  const { page, logs, close } = await open(browser, run.context, run.query, run.unlock);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  if (run.throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: run.throttle });
  await sleep(3000);
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.evaluate(() => {
    const h = (window as unknown as { __lathe: Harness }).__lathe;
    h.stats.length = 0;
    h.gaps.length = 0;
    h.longTasks = 0;
  });
  const m0 = await metrics();
  await sleep(10_000);
  const m1 = await metrics();
  const h = await harness(page);
  const perSec = (k: string) => +(((m1[k]! - m0[k]!) / (m1.Timestamp! - m0.Timestamp!)) * 1000).toFixed(1);
  const result = {
    run: run.name,
    mainThread: { taskMsPerSec: perSec('TaskDuration'), scriptMsPerSec: perSec('ScriptDuration'), longTasks: h.longTasks },
    schedulerSkips: h.schedulerSkips,
    mainFrameGapMs: { p50: quantile(h.gaps, 0.5), p95: quantile(h.gaps, 0.95) },
    renderer: {
      windows: h.stats.length,
      p95FrameMs: { median: quantile(h.stats.map((s) => s.p95FrameMs), 0.5), max: quantile(h.stats.map((s) => s.p95FrameMs), 1) },
      fps: { median: quantile(h.stats.map((s) => s.fps), 0.5), min: quantile(h.stats.map((s) => s.fps), 0) },
    },
  };
  noErrors(run.name, logs);
  await close();
  return result;
}

async function perf(browser: Browser): Promise<void> {
  const runs: PerfRun[] = [
    { name: 'phone-baseline-novis-1x', context: PHONE, query: 'novis=1&start=70', throttle: 1 },
    { name: 'phone-worker-full-1x', context: PHONE, query: 'tier=full&start=70', throttle: 1 },
    { name: 'phone-main-full-1x', context: PHONE, query: 'tier=full&start=70&worker=0', throttle: 1 },
    { name: 'phone-worker-calm-1x', context: PHONE, query: 'tier=calm&start=70', throttle: 1 },
    { name: 'phone-baseline-novis-4x', context: PHONE, query: 'novis=1&start=70', throttle: 4 },
    { name: 'phone-worker-full-4x', context: PHONE, query: 'tier=full&start=70', throttle: 4 },
    { name: 'phone-main-full-4x', context: PHONE, query: 'tier=full&start=70&worker=0', throttle: 4 },
    { name: 'desktop-hidpi-worker-full-1x', context: DESKTOP_HIDPI, query: 'tier=full&start=70', throttle: 1 },
    { name: 'phone-real-landing-novis-1x', context: PHONE, query: 'engine=real&novis=1&start=4', throttle: 1 },
    { name: 'phone-real-landing-worker-1x', context: PHONE, query: 'engine=real&start=4', throttle: 1 },
    { name: 'phone-real-playing-novis-1x', context: PHONE, query: 'engine=real&novis=1&start=4', throttle: 1, unlock: true },
    { name: 'phone-real-playing-worker-1x', context: PHONE, query: 'engine=real&start=4', throttle: 1, unlock: true },
    { name: 'phone-real-playing-novis-4x', context: PHONE, query: 'engine=real&novis=1&start=4', throttle: 4, unlock: true },
    { name: 'phone-real-playing-worker-4x', context: PHONE, query: 'engine=real&start=4', throttle: 4, unlock: true },
    { name: 'phone-real-playing-main-4x', context: PHONE, query: 'engine=real&start=4&worker=0', throttle: 4, unlock: true },
  ];
  const results: Record<string, unknown>[] = [];
  for (const run of runs.filter((r) => only.test(r.name))) {
    const r = await measure(browser, run);
    results.push(r);
    console.log(`      ${JSON.stringify(r)}`);
  }
  writeFileSync(join(out, 'perf.json'), JSON.stringify(results, null, 2));
  if (!results.some((r) => r.run === 'phone-worker-full-1x') || !results.some((r) => r.run === 'phone-baseline-novis-1x')) return;
  const byName = (n: string) => results.find((r) => r.run === n) as { mainThread: { taskMsPerSec: number }; renderer: { windows: number; p95FrameMs: { median: number } } };
  const worker = byName('phone-worker-full-1x');
  const baseline = byName('phone-baseline-novis-1x');
  check(
    'perf: the worker path adds ≤ 60 ms/s of main-thread work over the engine-only baseline (phone, 1×)',
    worker.mainThread.taskMsPerSec - baseline.mainThread.taskMsPerSec <= 60,
    { worker: worker.mainThread.taskMsPerSec, baseline: baseline.mainThread.taskMsPerSec },
  );
  check('perf: worker frame p95 within the Full budget (≤ 12 ms)', worker.renderer.windows > 0 && worker.renderer.p95FrameMs.median <= 12, worker.renderer);
}

const server = await createServer({ configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) });
await server.listen();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  if (mode === 'shots' || mode === 'all') {
    await takeShots(browser);
    if (only.test('dynamics')) await dynamics(browser);
  }
  if (mode === 'perf' || mode === 'all') await perf(browser);
} finally {
  await browser.close();
  await server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
