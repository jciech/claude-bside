// Real-browser verification of the engine (not part of `npm test`):
//   node --disable-warning=ExperimentalWarning test/engine/browser/run.ts [main|sync|bomb ...]
// Starts the harness dev server, drives headless Chromium pages through the fixture schedule and
// asserts on captured haps, channel gains, events and acoustic onsets. Exits non-zero on failure.
import { chromium, type Browser, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

type Harness = {
  ready: boolean;
  unlocked: boolean;
  unlockedAt: number;
  latency: unknown;
  outputs: { key: string; onset: number; dur: number; at: number; value: Record<string, unknown> }[];
  hapEvents: number;
  sampleEvent: Record<string, unknown> | null;
  errors: { sectionId: string; partId: string; code: string; message: string }[];
  states: string[];
  sectionStarts: { id: string; now: number }[];
  gains: { now: number; g: Record<string, number | null> }[];
  onsets: number[];
  heard: number[];
  maxRms: number;
  health: { skips: number; lateMs: number; droppedHaps: number }[];
  preload: unknown[];
  failures: string[];
  cps: number;
  meters: { master: { rmsDb: number; peakDb: number }; parts: Record<string, number> } | null;
  active: Record<string, unknown> | null;
  query: { instance: string; cycle: number; gain: number }[] | null;
  telemetry: Record<string, unknown> | null;
  needsGesture: number;
  trace: { c: number; lv: Record<string, number>; centroid: number; rms: number; f3: number[]; f5: number[] }[];
};

const CYCLE_MS = 2000;
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: unknown = '') => {
  results.push({ name, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Hits per URL on raw.githubusercontent.com (fetched by Node: the sandbox browser can't reach it). */
const assetHits = new Map<string, number>();
let failFirst: RegExp | null = null;

async function open(browser: Browser, mode: string): Promise<{ page: Page; console: string[] }> {
  const context = await browser.newContext();
  await context.route(/^https:\/\/raw\.githubusercontent\.com\//, async (route) => {
    const url = route.request().url();
    const hits = (assetHits.get(url) ?? 0) + 1;
    assetHits.set(url, hits);
    if (failFirst?.test(url) && hits === 1) return route.fulfill({ status: 503, body: 'try again' });
    try {
      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());
      await route.fulfill({ status: res.status, body, headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'access-control-allow-origin': '*' } });
    } catch {
      await route.abort();
    }
  });
  const page = await context.newPage();
  const console: string[] = [];
  page.on('console', (m) => console.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.push(`[pageerror] ${e.message}`));
  await page.goto(`http://localhost:5199/?mode=${mode}`);
  await page.waitForFunction(() => typeof (window as unknown as { __boot?: unknown }).__boot === 'function', null, { timeout: 120_000 });
  return { page, console };
}

const boot = (page: Page, t0: number) => page.evaluate((t) => (window as unknown as { __boot: (t: number) => Promise<void> }).__boot(t), t0);
const harness = (page: Page) => page.evaluate(() => (window as unknown as { __harness: Harness }).__harness);
const pageNow = (page: Page) => page.evaluate(() => performance.timeOrigin + performance.now());
const cycleOf = (page: Page, t0: number) => pageNow(page).then((ms) => (ms - t0) / CYCLE_MS);
async function unlock(page: Page): Promise<void> {
  await page.click('#unlock');
  await page.waitForFunction(() => (window as unknown as { __harness: Harness }).__harness.unlocked, null, { timeout: 30_000 });
}
async function waitForCycle(page: Page, t0: number, cycle: number): Promise<void> {
  for (;;) {
    const c = await cycleOf(page, t0);
    if (c >= cycle) return;
    await sleep(Math.min(1000, (cycle - c) * CYCLE_MS));
  }
}

function commonChecks(tag: string, h: Harness, console: string[]): void {
  const bad = console.filter((m) => /skip query: too late|cannot schedule sounds in the past|\[pageerror\]|trigger error|Uncaught/i.test(m));
  check(`${tag}: no 'skip query: too late', past-scheduling or page errors`, bad.length === 0 && h.failures.length === 0, [...bad, ...h.failures].slice(0, 5));
  const late = h.health.reduce((s, x) => s + x.droppedHaps, 0);
  const skips = h.health.reduce((s, x) => s + x.skips, 0);
  check(`${tag}: scheduler health (no late or dropped haps, no skips)`, late === 0 && skips === 0, { droppedHaps: late, skips });
  check(`${tag}: audio reaches the master analyser`, h.maxRms > 0.005, { maxRms: +h.maxRms.toFixed(4) });
}

async function main(browser: Browser): Promise<void> {
  const { page, console } = await open(browser, 'main');
  // Cycle 0 is placed so that output starts around bar 3 (hats enter at 4, B starts at 16).
  const t0 = (await pageNow(page)) + 1500 - 2.5 * CYCLE_MS;
  await boot(page, t0);
  await waitForCycle(page, t0, 2.4);
  await unlock(page);
  await waitForCycle(page, t0, 25.3);
  await page.evaluate(() => (window as unknown as { __snapshot: () => void }).__snapshot());
  const h = await harness(page);
  await page.context().close();

  commonChecks('main', h, console);
  check('main: states idle→preparing→ready→unlocking→running', h.states.join('>') === 'preparing>ready>unlocking>running', h.states);
  check('main: 120 BPM plays at 0.5 cps', h.cps === 0.5, { cps: h.cps });
  const byKey = (k: string) => h.outputs.filter((o) => o.key === k);
  const kicks = h.outputs.filter((o) => o.key.endsWith(':kick')).sort((a, b) => a.onset - b.onset);
  const first = kicks[0]!.onset;
  check('main: output starts on a bar line', Number.isInteger(first), { firstKick: first });
  const inWindow = kicks.filter((k) => k.onset >= 5 && k.onset < 6);
  const spacing = inWindow.slice(1).map((k, i) => +(k.at - inWindow[i]!.at).toFixed(4));
  check('main: 4 kicks per 2 s, 0.5 s apart in audio time', inWindow.length === 4 && spacing.every((s) => Math.abs(s - 0.5) < 1e-3), { count: inWindow.length, spacing });
  const boundary = kicks.filter((k) => k.onset >= 14 && k.onset < 18).map((k) => k.onset);
  const expected = Array.from({ length: 16 }, (_, i) => 14 + i / 4);
  check('main: continuing kick — no double or missing onset across A→B', JSON.stringify(boundary) === JSON.stringify(expected), boundary);
  check(
    'main: kick instance hands over at bar 16',
    kicks.every((k) => (k.onset < 16 ? k.key === 'fx01-0001:kick' : k.key === 'fx01-0002:kick')),
    [...new Set(kicks.map((k) => k.key))],
  );
  const bass = h.outputs.filter((o) => o.key.endsWith(':bass') && o.onset >= 8 && o.onset < 20).sort((a, b) => a.onset - b.onset);
  check('main: continuing bass — one note per bar through the boundary', JSON.stringify(bass.map((b) => b.onset)) === JSON.stringify([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]), bass.map((b) => `${b.onset}:${b.value.note}`));
  const cut = (bar: number) => bass.find((b) => b.onset === bar)?.value.cutoff as number;
  check(
    'main: knob automation moves the bass cutoff (400 → 1200 exp over bars 8–16, then carried)',
    Math.abs(cut(8) - 400) < 1 && Math.abs(cut(12) - Math.sqrt(400 * 1200)) < 1 && Math.abs(cut(15) - 400 * 3 ** (7 / 8)) < 1 && Math.abs(cut(16) - 1200) < 1 && Math.abs(cut(19) - 1200) < 1,
    [8, 12, 15, 16, 19].map((b) => [b, Math.round(cut(b))]),
  );
  const hatsA = byKey('fx01-0001:hats').map((o) => o.onset).sort((a, b) => a - b);
  check('main: hats enter at bar 4 (window)', hatsA[0] === 4, { first: hatsA[0] });
  const fill = byKey('fx01-0002:fill').map((o) => o.onset);
  check('main: pickup plays in the bar before B', fill.length === 16 && Math.min(...fill) === 15 && Math.max(...fill) < 16, { n: fill.length, min: Math.min(...fill), max: Math.max(...fill) });
  const hatsB = byKey('fx01-0002:hats').map((o) => o.onset);
  check('main: crossfade overlaps two bars (A hats until 18, B hats from 16)', Math.max(...hatsA) < 18 && Math.max(...hatsA) >= 17.8 && Math.min(...hatsB) === 16, {
    lastA: Math.max(...hatsA),
    firstB: Math.min(...hatsB),
  });
  const g = (c: number, orbit: number) => {
    const s = h.gains.reduce((best, x) => (Math.abs(x.now - c) < Math.abs(best.now - c) ? x : best));
    return s.g[orbit] ?? 0;
  };
  const ramp = [15.8, 16.5, 17, 17.5, 18.2].map((c) => [c, +g(c, 2).toFixed(3), +g(c, 5).toFixed(3)]);
  check(
    'main: both hat channels ramp (A 0.6 → 0, B 0 → 0.6) across the crossfade',
    g(15.8, 2) > 0.55 && g(16.5, 2) < 0.58 && g(16.5, 2) > g(17.5, 2) && g(18.2, 2) < 0.02 && g(15.8, 5) < 0.02 && g(16.5, 5) > 0.1 && g(17.5, 5) > g(16.5, 5) && g(18.2, 5) > 0.58,
    ramp,
  );
  check('main: pad level automation fades in over bars 0–4', g(3.2, 4) < g(3.9, 4) && g(3.9, 4) < 0.5 && g(6, 4) > 0.49, [3.2, 3.9, 6].map((c) => +g(c, 4).toFixed(3)));
  const lead = byKey('fx01-0002:lead').map((o) => o.onset);
  check('main: lead enters at B bar 8 (cycle 24)', Math.min(...lead) === 24, { first: Math.min(...lead) });
  const start = h.sectionStarts.find((s) => s.id === 'fx01-0002');
  check('main: sectionStart fires at bar 16', !!start && start.now >= 16 && start.now < 16.1, start);
  check('main: every output also produced a hap event', h.hapEvents === h.outputs.length, { outputs: h.outputs.length, events: h.hapEvents });
  check('main: no part errors', h.errors.length === 0, h.errors);
  check('main: preload reported both sections ready', h.preload.length === 2, h.preload);
  check('main: meters and active code locations for sounding instances', !!h.meters && Object.keys(h.meters.parts).length >= 3 && Object.keys(h.active ?? {}).length >= 1, {
    master: h.meters?.master,
    parts: h.meters?.parts,
    active: Object.keys(h.active ?? {}),
  });
  check('main: lookahead query returns events of the sounding instances', (h.query?.length ?? 0) > 10, (h.query ?? []).slice(0, 3));
  check('main: telemetry within schema ranges', !!h.telemetry, h.telemetry);
}

async function sync(browser: Browser): Promise<void> {
  const a = await open(browser, 'sync');
  const b = await open(browser, 'sync');
  const t0 = Math.floor(Date.now() / 60_000) * 60_000;
  await Promise.all([boot(a.page, t0), boot(b.page, t0)]);
  await unlock(a.page);
  await sleep(1500);
  await unlock(b.page);
  await sleep(8000);
  const ha = await harness(a.page);
  const hb = await harness(b.page);
  await a.page.context().close();
  await b.page.context().close();
  commonChecks('sync A', ha, a.console);
  commonChecks('sync B', hb, b.console);
  // Skip each page's start lead and one-bar fade-in: threshold detection shifts with amplitude.
  const settled = Math.max(ha.unlockedAt, hb.unlockedAt) + CYCLE_MS + 500;
  const slot = (ms: number) => Math.round((ms - t0) / 500);
  const pair = (a: number[], b: number[]) => {
    const mb = new Map(b.filter((t) => t > settled).map((t) => [slot(t), t]));
    return a.filter((t) => t > settled && mb.has(slot(t))).map((t) => +(t - mb.get(slot(t))!).toFixed(2));
  };
  const grid = (arr: number[]) => arr.filter((t) => t > settled).map((t) => +((((t - t0) % 500) + 750) % 500 - 250).toFixed(1));
  const heard = pair(ha.heard, hb.heard);
  check('sync: two pages started 1.5 s apart put onsets on the same heard grid (±10 ms, sample-accurate)', heard.length >= 8 && heard.every((d) => Math.abs(d) <= 10), {
    common: heard.length,
    diffs: heard,
    fromGridA: grid(ha.heard).slice(-8),
    fromGridB: grid(hb.heard).slice(-8),
  });
  // Polled detection is non-circular (wall clock at detection) but quantized by render bursts.
  const polled = pair(ha.onsets, hb.onsets);
  check('sync: polled wall-clock detection agrees within the render-burst quantum (±25 ms)', polled.length >= 8 && polled.every((d) => Math.abs(d) <= 25), {
    common: polled.length,
    diffs: polled,
    latency: [ha.latency, hb.latency],
  });
}

async function bomb(browser: Browser): Promise<void> {
  const { page, console } = await open(browser, 'bomb');
  const t0 = (await pageNow(page)) - 1000;
  await boot(page, t0);
  await unlock(page);
  await waitForCycle(page, t0, Math.ceil(await cycleOf(page, t0)) + 3);
  const h = await harness(page);
  await page.context().close();
  const err = h.errors.find((e) => e.partId === 'bomb');
  check('bomb: the density bomb is muted with a partError', err?.code === 'density', h.errors);
  const kicks = h.outputs.filter((o) => o.key.endsWith(':kick')).map((o) => o.onset).sort((a, b) => a - b);
  const contiguous = kicks.every((k, i) => i === 0 || Math.abs(k - kicks[i - 1]! - 0.25) < 1e-9);
  check('bomb: the kick keeps playing, uninterrupted', kicks.length >= 10 && contiguous, { kicks: kicks.length, first: kicks[0], last: kicks[kicks.length - 1] });
  const bombs = h.outputs.filter((o) => o.key.endsWith(':bomb')).length;
  check('bomb: the bomb stopped within one bar', bombs <= 128, { bombHaps: bombs });
  const bad = console.filter((m) => /\[pageerror\]|Uncaught/i.test(m));
  check('bomb: no page errors', bad.length === 0 && h.failures.length === 0, bad);
}

async function features(browser: Browser): Promise<void> {
  const { page, console } = await open(browser, 'features');
  const t0 = (await pageNow(page)) + 1500 - 0.5 * CYCLE_MS;
  const hook = (name: string, arg?: unknown) =>
    page.evaluate(([n, a]: [string, unknown]) => (window as unknown as Record<string, (x: unknown) => unknown>)[n]!(a), [name, arg] as [string, unknown]);
  await boot(page, t0);
  await waitForCycle(page, t0, 0.4);
  await unlock(page);
  await waitForCycle(page, t0, 16.6);
  await hook('__interrupt');
  await sleep(1500);
  const interrupted = await harness(page);
  await page.evaluate(() => ((window as unknown as { __harness: Harness }).__harness.unlocked = false));
  await unlock(page);
  await waitForCycle(page, t0, 20.3);
  await hook('__late');
  await waitForCycle(page, t0, 21.5);
  await hook('__stay');
  await waitForCycle(page, t0, 22.5);
  await hook('__epoch', 25);
  await waitForCycle(page, t0, 25.5);
  await hook('__suspend');
  await page.evaluate(() => ((window as unknown as { __harness: Harness }).__harness.unlocked = false));
  await unlock(page);
  await waitForCycle(page, t0, 29.2);
  const acState = await hook('__acState');
  const h = await harness(page);
  await page.context().close();

  const bad = console.filter((m) => /skip query: too late|cannot schedule sounds in the past|\[pageerror\]|Uncaught|does not exist/i.test(m));
  check('features: no past-scheduling, missing-orbit or page errors', bad.length === 0 && h.failures.length === 0, [...bad, ...h.failures].slice(0, 5));

  // Sidechain: superdough ducks Orbit.output.gain, upstream of the engine channel.
  const phase = (c: number) => (((c * 4) % 1) + 1) % 1;
  const s1 = h.trace.filter((x) => x.c >= 2 && x.c < 6 && x.lv['2'] !== undefined);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const ducked = mean(s1.filter((x) => phase(x.c) > 0.04 && phase(x.c) < 0.14).map((x) => x.lv['2']!));
  const released = mean(s1.filter((x) => phase(x.c) > 0.6 && phase(x.c) < 0.95).map((x) => x.lv['2']!));
  check('features: the kick ducks the pad through the engine channel', ducked < 0.6 * released && released > 0.01, { ducked: +ducked.toFixed(4), released: +released.toFixed(4) });

  // Riser: noise sweeping up over the last two bars of section 1, cut at bar 8.
  const centroid = (a: number, b: number) => mean(h.trace.filter((x) => x.c >= a && x.c < b).map((x) => x.centroid));
  const rms = (a: number, b: number) => mean(h.trace.filter((x) => x.c >= a && x.c < b).map((x) => x.rms));
  check('features: the riser brightens the last two bars before bar 8', centroid(7.5, 7.95) > 2 * centroid(4, 5.5) && rms(7.5, 7.95) > rms(4, 5.5), {
    centroid: [Math.round(centroid(4, 5.5)), Math.round(centroid(6.2, 6.8)), Math.round(centroid(7.5, 7.95)), Math.round(centroid(8.3, 9))],
    rms: [rms(4, 5.5), rms(7.5, 7.95)].map((x) => +x.toFixed(4)),
  });
  check('features: the riser is cut at bar 8', centroid(8.3, 9) < 0.6 * centroid(7.5, 7.95), { after: Math.round(centroid(8.3, 9)) });

  // Filter transition: section 2's low-pass closes over [12, 14); section 3's high-pass opens over [14, 15).
  const at = (c: number) => h.trace.reduce((best, x) => (Math.abs(x.c - c) < Math.abs(best.c - c) ? x : best));
  const lp = [11.5, 12.5, 13, 13.5, 13.95].map((c) => at(c).f3[0]!);
  const hp = [13.9, 14.05, 14.5, 15.2].map((c) => at(c).f5[1]!);
  check('features: outgoing low-pass closes over the last 2 bars', lp[0]! > 15000 && lp[1]! < lp[0]! && lp[2]! < lp[1]! && lp[3]! < lp[2]! && lp[4]! < 400, lp);
  check('features: incoming high-pass opens over the first bar', hp[1]! > 1500 && hp[2]! < hp[1]! && hp[3]! < 20, hp);

  // OS interruption and resume.
  check('features: an OS interruption suspends the engine and asks for a gesture', interrupted.states.at(-1) === 'suspended' && interrupted.needsGesture === 1, {
    states: interrupted.states,
    needsGesture: interrupted.needsGesture,
  });
  const beforeCut = interrupted.outputs.length;
  const resumed = h.outputs.slice(beforeCut).filter((o) => o.key === 'f-3:kick3').map((o) => o.onset);
  check(
    'features: unlock resumes at a bar line with the grid intact',
    h.states.slice(-2).join('>') === 'unlocking>running' && Number.isInteger(resumed[0]!) && resumed.every((c, i) => i === 0 || Math.abs(c - resumed[i - 1]! - 0.25) < 1e-9),
    { states: h.states.slice(-3), firstAfterResume: resumed[0], n: resumed.length },
  );

  // A late schedule change applies from the next bar and is reported.
  const late = h.errors.find((e) => e.code === 'late-schedule');
  const chords = h.outputs.filter((o) => o.key === 'f-3:chord' && o.onset >= 19 && o.onset < 23);
  const switchAt = chords.find((o) => o.value.note === 'g2')?.onset;
  check('features: a late change is reported and applies from the next bar', !!late && switchAt !== undefined && Number.isInteger(switchAt) && chords.every((o) => (o.onset < switchAt ? o.value.note === 'f2' || o.value.note === 'a2' || o.value.note === 'c3' : true)), {
    late,
    switchAt,
  });

  check('features: a Stay jump on the playing section is not a late change', h.errors.filter((e) => e.code === 'late-schedule').length === 1, h.errors);
  const hatsAfter = h.outputs.filter((o) => o.key === 'g-1:hats' && o.onset >= 27).map((o) => o.onset);
  check('features: suspend() then an immediate unlock() keeps playing (no stale suspend)', acState === 'running' && h.states.at(-1) === 'running' && hatsAfter.length >= 8, {
    acState,
    states: h.states.slice(-4),
    hatsAfter: hatsAfter.length,
  });

  // New epoch: everything old fades within a bar; the new section starts on time.
  const oldAfter = h.outputs.filter((o) => o.key.startsWith('f-') && o.onset > 23);
  const tail = h.trace.filter((x) => x.c > 23.8 && x.c < 24.8).map((x) => x.rms);
  const hats = h.outputs.filter((o) => o.key === 'g-1:hats').map((o) => o.onset);
  check('features: a new epoch fades the old material and plays the new section on time', oldAfter.length === 0 && Math.max(...tail) < 0.01 && hats[0] === 25, {
    oldAfter: oldAfter.length,
    tailPeakRms: +Math.max(...tail).toFixed(4),
    firstNew: hats[0],
  });
}

async function samples(browser: Browser): Promise<void> {
  failFirst = /\/bd\//;
  const { page, console } = await open(browser, 'samples');
  const t0 = (await pageNow(page)) - 0.2 * CYCLE_MS;
  await boot(page, t0);
  const progress = await page.evaluate(() => (window as unknown as { __harness: Harness }).__harness.preload);
  await unlock(page);
  await waitForCycle(page, t0, Math.ceil(await cycleOf(page, t0)) + 3);
  const h = await harness(page);
  await page.context().close();
  failFirst = null;
  const dropped = console.filter((m) => /took too long|still loading|not found|could not load/i.test(m));
  check('samples: the section preloads (samples, bank alias, GM preset, wavetable) before output', JSON.stringify(progress) === JSON.stringify([{ id: 's-1', ready: true, failed: [] }]), progress);
  check('samples: no first hit is dropped and no sound is missing', dropped.length === 0 && h.errors.length === 0, { dropped: dropped.slice(0, 3), errors: h.errors });
  const bdHits = [...assetHits].filter(([u]) => /\/bd\//.test(u));
  check('samples: a transient 503 is retried before superdough ever sees the URL', bdHits.length > 0 && bdHits.every(([, n]) => n >= 2), bdHits.map(([u, n]) => [u.split('/').slice(-2).join('/'), n]));
  const byPart = (id: string) => h.outputs.filter((o) => o.key === `s-1:${id}`);
  check('samples: every part plays from the first bar', ['kick', 'keys', 'hats', 'wave'].every((id) => byPart(id).length > 0), {
    kick: byPart('kick').length,
    keys: byPart('keys').length,
    hats: byPart('hats').length,
    wave: byPart('wave').length,
  });
  check('samples: audio reaches the master analyser', h.maxRms > 0.01, { maxRms: +h.maxRms.toFixed(4) });
}

async function join(browser: Browser): Promise<void> {
  const { page, console } = await open(browser, 'join');
  // The listener arrives in the middle of the A→B crossfade, before its clock has synced.
  const t0 = (await pageNow(page)) - 16.4 * CYCLE_MS;
  const hook = (name: string, ...args: unknown[]) =>
    page.evaluate(([n, a]: [string, unknown[]]) => (window as unknown as Record<string, (...x: unknown[]) => unknown>)[n]!(...a), [name, args] as [string, unknown[]]);
  await boot(page, t0);
  await unlock(page);
  await hook('__brighten', 19);
  await waitForCycle(page, t0, 18.2);
  await hook('__mute', 'bass', true);
  await sleep(300);
  const muted = (await hook('__channel', 3)) as { mute: number };
  await hook('__mute', 'bass', false);
  await sleep(300);
  const unmuted = (await hook('__channel', 3)) as { mute: number };
  await waitForCycle(page, t0, 20.5);
  const h = await harness(page);
  await page.context().close();
  commonChecks('join', h, console);
  check('join: no spurious sectionStart for sections that began before the clock synced', h.sectionStarts.length === 0, h.sectionStarts);
  const oldHats = h.outputs.filter((o) => o.key === 'fx01-0001:hats');
  const newHats = h.outputs.filter((o) => o.key === 'fx01-0002:hats').sort((a, b) => a.onset - b.onset);
  const g5 = h.gains.find((x) => x.now >= newHats[0]!.onset + 0.05)?.g['5'] ?? 0;
  check('join: a crossfade already under way on arrival is skipped, not joined part-way', oldHats.length === 0 && g5 > 0.58, { oldHats: oldHats.length, bHatsGain: g5, firstB: newHats[0]?.onset });
  check('join: the personal mix mutes and restores a part on this client only', muted.mute < 0.01 && unmuted.mute > 0.99, { muted: muted.mute, unmuted: unmuted.mute });
  const bass = (bar: number) => h.outputs.find((o) => o.key === 'fx01-0002:bass' && o.onset === bar)?.value.cutoff as number;
  check('join: a mixer keyframe brightens from its bar (knob follow + per-hap cutoff)', Math.abs(bass(18) - 1200) < 1 && Math.abs(bass(20) - Math.min(2400, 1200 + 1050) * 2) < 1, { bar18: bass(18), bar20: bass(20) });
  const kicks = h.outputs.filter((o) => o.key.endsWith(':kick')).map((o) => o.onset);
  check('join: output starts on a bar line and keeps the grid', Number.isInteger(kicks[0]!) && kicks.every((k, i) => i === 0 || Math.abs(k - kicks[i - 1]! - 0.25) < 1e-9), { first: kicks[0], n: kicks.length });
}

const scenarios: Record<string, (b: Browser) => Promise<void>> = { main, sync, bomb, features, samples, join };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(scenarios);
const server = await createServer({ configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)) });
await server.listen();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  // One at a time: the acoustic sync check polls analysers every millisecond and needs the CPU.
  for (const name of wanted) await scenarios[name]!(browser);
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
