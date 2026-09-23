// Offline audio renderer: the pinned @strudel/* packages bundled by Vite, run in headless Chromium,
// rendering into an OfflineAudioContext. Used by `npm run catalog -- --measure` to measure sound
// levels and by hand to audition sections:
//
//   node --disable-warning=ExperimentalWarning --import ./src/server/node-hooks.ts scripts/render-audio.ts \
//     [--bpm 120] [--bars 4] [--out render.wav] 'note("c3 e3 g3").s("sawtooth")'
//   … scripts/render-audio.ts --list sections.json [--out-dir dir]   (JSON: [{ id, code, bpm?, bars? }] or [code])
// WAVs (32-bit float, unclamped) go to --out / --out-dir (default: $TMPDIR/bside-renders).
//
// Samples come from raw.githubusercontent.com, fetched by Node (the sandboxed browser can't trust
// the egress proxy's CA) and cached in memory. The page registers exactly the catalog's maps in the
// catalog's order, so renders resolve `s("bd:3")` like every listener does. Limitation: superdough
// builds its reverb impulse response asynchronously in a nested OfflineAudioContext, so offline
// renders have no `room` tail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import type { CatalogMap } from '../src/shared/catalog.ts';

const ORIGIN = 'https://render.local';
const RAW_ORIGIN = 'https://raw.githubusercontent.com/';
const ENTRY_ID = 'virtual:bside-render-entry';
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** Stereo PCM as rendered (float, may exceed ±1). */
export interface Audio {
  sampleRate: number;
  channels: [Float32Array, Float32Array];
}

export interface AudioStats {
  seconds: number;
  peakDb: number;
  rmsDb: number;
  /** Share of samples at or above full scale, in percent. */
  clipPct: number;
  centroidHz: number;
  /** RMS per bar when a bpm is given. */
  barRmsDb: number[];
}

/** One superdough event: a hap value played at `t` seconds for `duration` seconds. */
export interface RenderEvent {
  value: Record<string, unknown>;
  t: number;
  duration: number;
}

export interface RenderResult {
  audio: Audio;
  /** Per-event error (sound not found, load failure, timeout), aligned with the input events. */
  eventErrors: (string | null)[];
  logs: string[];
}

export interface RendererOptions {
  maps: Pick<CatalogMap, 'id' | 'kind' | 'path' | 'order'>[];
  soundfontBase: string;
  /** Directory that `/palette/...` map paths resolve against (the repo's palette/ by default). */
  paletteDir?: string;
  sampleRate?: number;
  /** Per-event load timeout inside the page; a soundfont zone that fails to decode never settles. */
  eventTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface Renderer {
  renderEvents(events: RenderEvent[], seconds: number): Promise<RenderResult>;
  renderCode(code: string, opts: { bpm: number; bars: number }): Promise<RenderResult & { error: string | null }>;
  /** Decodes base64 audio files (soundfont zones); returns duration in seconds, 'error' or 'timeout'. */
  decode(files: string[], timeoutMs?: number): Promise<(number | 'error' | 'timeout')[]>;
  close(): Promise<void>;
}

// ─── Page ─────────────────────────────────────────────────────────────────────────────────────────

const ENTRY_SOURCE = `
import * as core from '@strudel/core';
import * as mini from '@strudel/mini';
import * as tonal from '@strudel/tonal';
import * as webaudio from '@strudel/webaudio';
import * as soundfonts from '@strudel/soundfonts';
import { transpiler } from '@strudel/transpiler';

const logs = [];
webaudio.setLogger((message, type) => logs.push((type ? '[' + type + '] ' : '') + String(message)));

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

async function setup({ maps, soundfontBase }) {
  await core.evalScope(core, mini, tonal, webaudio, soundfonts);
  webaudio.registerSynthSounds();
  webaudio.registerZZFXSounds();
  soundfonts.registerSoundfonts();
  soundfonts.setSoundfontUrl(soundfontBase);
  // Fixed order, sequentially: registration order decides who owns a name.
  for (const map of maps) {
    if (map.kind === 'bank-aliases') await webaudio.aliasBank(map.url);
    else await webaudio.samples(map.url);
  }
}

async function play(events, seconds, { cps, sampleRate, eventTimeoutMs, sequential, token }) {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate);
  webaudio.setAudioContext(ctx);
  webaudio.setSuperdoughAudioController(null);
  await webaudio.initAudio({ maxPolyphony: 1024 });
  const trigger = (ev) => withTimeout(webaudio.superdough({ ...ev.value }, ev.t, ev.duration, cps, ev.t), eventTimeoutMs)
    .then(() => null, (err) => String(err?.message ?? err));
  // In onset order when choke groups (cut) matter; otherwise concurrently so loads overlap.
  const eventErrors = [];
  if (sequential) for (const ev of events) eventErrors.push(await trigger(ev));
  else eventErrors.push(...(await Promise.all(events.map(trigger))));
  const rendered = await ctx.startRendering();
  // Raw float channels (left, then right) as a binary POST: no base64 through the DevTools protocol.
  const body = new Blob([rendered.getChannelData(0), rendered.getChannelData(rendered.numberOfChannels > 1 ? 1 : 0)]);
  await fetch('${ORIGIN}/__result/' + token + '?sr=' + rendered.sampleRate, { method: 'POST', body });
  return { eventErrors, logs: logs.splice(0) };
}

async function renderCode({ code, cps, cycles, sampleRate, eventTimeoutMs, token }) {
  let pattern;
  try {
    ({ pattern } = await core.evaluate(code, transpiler));
    if (!pattern || typeof pattern.queryArc !== 'function') throw new Error('code did not evaluate to a pattern');
  } catch (err) {
    return { error: String(err?.message ?? err), eventErrors: [], logs: logs.splice(0) };
  }
  const events = pattern.queryArc(0, cycles, { _cps: cps })
    .filter((hap) => hap.hasOnset())
    .sort((a, b) => a.whole.begin.valueOf() - b.whole.begin.valueOf())
    .map((hap) => { hap.ensureObjectValue(); return { value: hap.value, t: hap.whole.begin.valueOf() / cps, duration: hap.duration / cps }; });
  const result = await play(events, cycles / cps, { cps, sampleRate, eventTimeoutMs, sequential: true, token });
  return { error: null, ...result };
}

async function decode({ files, timeoutMs }) {
  const ctx = new OfflineAudioContext(1, 44100, 44100);
  return Promise.all(files.map(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      const buffer = await withTimeout(ctx.decodeAudioData(bytes.buffer), timeoutMs);
      return buffer.duration;
    } catch (err) {
      return String(err?.message) === 'timeout' ? 'timeout' : 'error';
    }
  }));
}

window.__render = { setup, play, renderCode, decode };
`;

const INDEX_HTML = `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/entry.js"></script></head><body></body></html>`;

interface BundleFile {
  body: Buffer;
  contentType: string;
}

async function bundlePage(): Promise<Map<string, BundleFile>> {
  const { build } = await import('vite');
  const output = await build({
    configFile: false,
    root: REPO_ROOT,
    logLevel: 'error',
    plugins: [
      {
        name: 'bside-render-entry',
        resolveId: (id: string) => (id === ENTRY_ID ? `\0${ENTRY_ID}` : null),
        load: (id: string) => (id === `\0${ENTRY_ID}` ? ENTRY_SOURCE : null),
      },
    ],
    build: {
      write: false,
      target: 'es2022',
      minify: false,
      modulePreload: false,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 100_000,
      rollupOptions: { input: { entry: ENTRY_ID }, output: { entryFileNames: 'entry.js', chunkFileNames: 'chunks/[name]-[hash].js' } },
    },
  });
  const files = new Map<string, BundleFile>();
  files.set('/', { body: Buffer.from(INDEX_HTML), contentType: 'text/html' });
  for (const result of Array.isArray(output) ? output : [output]) {
    if (!('output' in result)) throw new Error('unexpected Vite watcher output');
    for (const item of result.output) {
      const body = item.type === 'chunk' ? Buffer.from(item.code) : Buffer.from(item.source);
      files.set(`/${item.fileName}`, { body, contentType: item.fileName.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
    }
  }
  return files;
}

// ─── Renderer ─────────────────────────────────────────────────────────────────────────────────────

interface Fetched {
  status: number;
  contentType: string;
  body: Buffer;
}

export async function openRenderer(options: RendererOptions): Promise<Renderer> {
  const paletteDir = options.paletteDir ?? path.join(REPO_ROOT, 'palette');
  const sampleRate = options.sampleRate ?? 44100;
  const eventTimeoutMs = options.eventTimeoutMs ?? 45_000;
  const log = options.log ?? (() => {});
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';

  const started = Date.now();
  const files = await bundlePage();
  log(`bundled render page (${files.size} files) in ${Date.now() - started} ms`);

  const { chromium } = await import('@playwright/test');
  const browser: Browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context: BrowserContext = await browser.newContext();
  const remote = new Map<string, Promise<Fetched>>();
  const results = new Map<string, (audio: Audio) => void>();

  const fetchRemote = (url: string): Promise<Fetched> => {
    let pending = remote.get(url);
    if (!pending) {
      pending = fetchWithRetry(url).then(async (res) => ({
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
        body: Buffer.from(await res.arrayBuffer()),
      }));
      pending.catch(() => remote.delete(url));
      remote.set(url, pending);
    }
    return pending;
  };

  await context.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(`${ORIGIN}/__result/`)) {
      const { pathname, searchParams } = new URL(url);
      const token = pathname.slice('/__result/'.length);
      results.get(token)?.(toAudio(request.postDataBuffer() ?? Buffer.alloc(0), Number(searchParams.get('sr'))));
      results.delete(token);
      return route.fulfill({ status: 204 });
    }
    if (url.startsWith(`${ORIGIN}/`)) {
      const pathname = decodeURIComponent(new URL(url).pathname);
      const file = files.get(pathname) ?? readPaletteFile(paletteDir, pathname);
      if (!file) return route.fulfill({ status: 404, body: 'not found' });
      return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
    }
    if (url.startsWith(RAW_ORIGIN)) {
      try {
        const res = await fetchRemote(url);
        return route.fulfill({ status: res.status, contentType: res.contentType, headers: { 'access-control-allow-origin': '*' }, body: res.body });
      } catch (err) {
        log(`fetch failed: ${url}: ${String(err)}`);
        return route.abort('failed');
      }
    }
    return route.abort('blockedbyclient');
  });

  const maps = [...options.maps].sort((a, b) => a.order - b.order).map((map) => ({ kind: map.kind, url: `${ORIGIN}${map.path}` }));
  let tokens = 0;

  async function withPage<T>(fn: (page: Page, logs: string[]) => Promise<T>): Promise<T> {
    // A fresh page per render: superdough's node pools and caches are module state bound to one context.
    const page = await context.newPage();
    const logs: string[] = [];
    page.on('console', (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => logs.push(`[pageerror] ${err.message}`));
    try {
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(() => '__render' in window, null, { timeout: 60_000 });
      await page.evaluate((args) => (window as any).__render.setup(args), { maps, soundfontBase: options.soundfontBase });
      return await fn(page, logs);
    } finally {
      await page.close();
    }
  }

  function awaitResult(): { token: string; audio: Promise<Audio> } {
    const token = `r${++tokens}`;
    const audio = new Promise<Audio>((resolve) => results.set(token, resolve));
    return { token, audio };
  }

  return {
    async renderEvents(events, seconds) {
      return withPage(async (page, logs) => {
        const { token, audio } = awaitResult();
        const out = await page.evaluate((args) => (window as any).__render.play(args.events, args.seconds, args.opts), {
          events,
          seconds,
          opts: { cps: 0.5, sampleRate, eventTimeoutMs, sequential: false, token },
        });
        // Probe batches never replay a file; don't hold every sample of a full measurement in memory.
        remote.clear();
        return { audio: await audio, eventErrors: out.eventErrors, logs: [...out.logs, ...logs] };
      });
    },
    async renderCode(code, { bpm, bars }) {
      return withPage(async (page, logs) => {
        const { token, audio } = awaitResult();
        const out = await page.evaluate((args) => (window as any).__render.renderCode(args), {
          code,
          cps: bpm / 240,
          cycles: bars,
          sampleRate,
          eventTimeoutMs,
          token,
        });
        const empty: Audio = { sampleRate, channels: [new Float32Array(0), new Float32Array(0)] };
        if (out.error) {
          results.delete(token);
          return { audio: empty, error: out.error, eventErrors: [], logs: [...out.logs, ...logs] };
        }
        return { audio: await audio, error: null, eventErrors: out.eventErrors, logs: [...out.logs, ...logs] };
      });
    },
    async decode(list, timeoutMs = 10_000) {
      const page = await context.newPage();
      try {
        await page.goto(`${ORIGIN}/`);
        await page.waitForFunction(() => '__render' in window, null, { timeout: 60_000 });
        return await page.evaluate((args) => (window as any).__render.decode(args), { files: list, timeoutMs });
      } finally {
        await page.close();
      }
    },
    async close() {
      await context.close();
      await browser.close();
    },
  };
}

function readPaletteFile(paletteDir: string, pathname: string): BundleFile | null {
  if (!pathname.startsWith('/palette/')) return null;
  const file = path.resolve(paletteDir, pathname.slice('/palette/'.length));
  if (!file.startsWith(paletteDir + path.sep) || !fs.existsSync(file)) return null;
  return { body: fs.readFileSync(file), contentType: file.endsWith('.json') ? 'application/json' : 'application/octet-stream' };
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.status < 500 || attempt >= attempts) return res;
    } catch (err) {
      if (attempt >= attempts) throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

// ─── WAV and analysis (pure) ──────────────────────────────────────────────────────────────────────

export function encodeWav(audio: Audio): Buffer {
  const [left, right] = audio.channels;
  const frames = left.length;
  const out = Buffer.alloc(44 + frames * 8);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + frames * 8, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(3, 20);
  out.writeUInt16LE(2, 22);
  out.writeUInt32LE(audio.sampleRate, 24);
  out.writeUInt32LE(audio.sampleRate * 8, 28);
  out.writeUInt16LE(8, 32);
  out.writeUInt16LE(32, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(frames * 8, 40);
  for (let i = 0, o = 44; i < frames; i++, o += 8) {
    out.writeFloatLE(left[i]!, o);
    out.writeFloatLE(right[i]!, o + 4);
  }
  return out;
}

/** Left then right float32 channels, as the render page posts them. */
function toAudio(body: Buffer, sampleRate: number): Audio {
  const samples = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
  const frames = samples.length / 2;
  return { sampleRate, channels: [samples.slice(0, frames), samples.slice(frames)] };
}

const toDb = (x: number): number => (x > 0 ? Math.round(20 * Math.log10(x) * 10) / 10 : -Infinity);

/** Peak/RMS/clipping/centroid of `audio` between `from` and `to` seconds. */
export function analyzeAudio(audio: Audio, opts: { from?: number; to?: number; bpm?: number } = {}): AudioStats {
  const { sampleRate } = audio;
  const [left, right] = audio.channels;
  const start = Math.max(0, Math.floor((opts.from ?? 0) * sampleRate));
  const end = Math.min(left.length, Math.ceil((opts.to ?? left.length / sampleRate) * sampleRate));
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  const barFrames = opts.bpm ? Math.round((240 / opts.bpm) * sampleRate) : 0;
  const bars: number[] = [];
  let barSum = 0;
  let barCount = 0;
  for (let i = start; i < end; i++) {
    const l = left[i]!;
    const r = right[i]!;
    const al = Math.abs(l);
    const ar = Math.abs(r);
    peak = Math.max(peak, al, ar);
    if (al >= 1) clipped++;
    if (ar >= 1) clipped++;
    const energy = (l * l + r * r) / 2;
    sum += energy;
    if (barFrames) {
      barSum += energy;
      if (++barCount === barFrames) {
        bars.push(barSum / barCount);
        barSum = 0;
        barCount = 0;
      }
    }
  }
  const frames = Math.max(1, end - start);
  return {
    seconds: Math.round((frames / sampleRate) * 1000) / 1000,
    peakDb: toDb(peak),
    rmsDb: toDb(Math.sqrt(sum / frames)),
    clipPct: Math.round((clipped / (frames * 2)) * 100 * 1e4) / 1e4,
    centroidHz: spectralCentroid(audio, start, end),
    barRmsDb: bars.map((x) => toDb(Math.sqrt(x))),
  };
}

const FFT_SIZE = 2048;
const HANN = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));

/**
 * Magnitude-weighted spectral centroid of the mid channel, averaged over frames weighted by frame
 * energy (frames more than 60 dB below the loudest are ignored). 0 for silence.
 */
export function spectralCentroid(audio: Audio, start = 0, end = audio.channels[0].length): number {
  const [left, right] = audio.channels;
  const hop = FFT_SIZE / 2;
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const frames: { centroid: number; energy: number }[] = [];
  for (let offset = start; offset < end; offset += hop) {
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) {
      const j = offset + i;
      const x = j < end ? (left[j]! + right[j]!) / 2 : 0;
      re[i] = x * HANN[i]!;
      im[i] = 0;
      energy += x * x;
    }
    if (energy === 0) continue;
    fft(re, im);
    let weighted = 0;
    let total = 0;
    for (let k = 1; k <= FFT_SIZE / 2; k++) {
      const magnitude = Math.hypot(re[k]!, im[k]!);
      weighted += magnitude * ((k * audio.sampleRate) / FFT_SIZE);
      total += magnitude;
    }
    if (total > 0) frames.push({ centroid: weighted / total, energy });
  }
  const loudest = Math.max(0, ...frames.map((f) => f.energy));
  let weighted = 0;
  let total = 0;
  for (const frame of frames) {
    if (frame.energy < loudest * 1e-6) continue;
    weighted += frame.centroid * frame.energy;
    total += frame.energy;
  }
  return total > 0 ? Math.round(weighted / total) : 0;
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += size) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = i + k;
        const b = a + size / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  code: string;
  bpm: number;
  bars: number;
}

function readJobs(file: string, bpm: number, bars: number): Job[] {
  const list: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(list)) throw new Error(`${file}: expected a JSON array`);
  return list.map((item, i) => {
    if (typeof item === 'string') return { id: `render-${i + 1}`, code: item, bpm, bars };
    const job = item as Partial<Job>;
    if (typeof job.code !== 'string') throw new Error(`${file}[${i}]: missing "code"`);
    return { id: String(job.id ?? `render-${i + 1}`), code: job.code, bpm: Number(job.bpm ?? bpm), bars: Number(job.bars ?? bars) };
  });
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: 'string' },
      list: { type: 'string' },
      bpm: { type: 'string', default: '120' },
      bars: { type: 'string', default: '4' },
      out: { type: 'string' },
      'out-dir': { type: 'string', default: path.join(os.tmpdir(), 'bside-renders') },
      catalog: { type: 'string', default: path.join(REPO_ROOT, 'palette', 'catalog.json') },
      json: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
    },
  });
  const bpm = Number(values.bpm);
  const bars = Number(values.bars);
  const code = values.code ?? positionals.join(' ');
  if (!values.list && !code) {
    console.error('usage: render-audio.ts [--bpm 120] [--bars 4] [--out file.wav] [--json] <code> | --list jobs.json [--out-dir dir]');
    process.exit(2);
  }
  const jobs = values.list ? readJobs(values.list, bpm, bars) : [{ id: 'render', code, bpm, bars }];
  const catalog = JSON.parse(fs.readFileSync(values.catalog, 'utf8')) as { maps: CatalogMap[]; soundfontBase: string };
  const renderer = await openRenderer({
    maps: catalog.maps,
    soundfontBase: catalog.soundfontBase,
    paletteDir: path.dirname(path.resolve(values.catalog)),
    log: values.verbose ? (line) => console.error(line) : undefined,
  });
  const report: (AudioStats & { id: string; file: string | null; error: string | null; problems: string[]; renderMs: number })[] = [];
  let failed = false;
  try {
    for (const job of jobs) {
      const started = Date.now();
      const result = await renderer.renderCode(job.code, job);
      const problems = [
        ...new Set([...result.eventErrors.filter((e): e is string => !!e), ...result.logs.filter((l) => /error|not found|could not|failed|timeout/i.test(l))]),
      ];
      if (result.error || result.eventErrors.some(Boolean)) failed = true;
      let file: string | null = null;
      if (!result.error) {
        file = values.list || !values.out ? path.join(values['out-dir'], `${job.id}.wav`) : values.out;
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, encodeWav(result.audio));
      }
      const stats = analyzeAudio(result.audio, { bpm: job.bpm });
      const entry = { id: job.id, file, error: result.error, problems, renderMs: Date.now() - started, ...stats };
      report.push(entry);
      if (!values.json) {
        const head = `${job.id.padEnd(24)} ${result.error ? `ERROR ${result.error}` : `peak ${stats.peakDb} dBFS  rms ${stats.rmsDb} dBFS  clip ${stats.clipPct}%  centroid ${stats.centroidHz} Hz  ${stats.seconds}s  (${entry.renderMs} ms) → ${file}`}`;
        console.log(head + (problems.length ? `\n  ${problems.slice(0, 6).join('\n  ')}` : ''));
      }
    }
    if (values.list) fs.writeFileSync(path.join(values['out-dir'], 'stats.json'), JSON.stringify(report, null, 1));
    if (values.json) console.log(JSON.stringify(report, null, 1));
  } finally {
    await renderer.close();
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) await main();
