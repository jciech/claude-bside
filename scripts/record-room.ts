// Records a live room for listening back: headless Chromium joins a running B-Side server, drops the
// needle and captures everything the engine sends to the speakers (Opus in WebM), logging each track
// change with its time in the recording.
//
//   node --disable-warning=ExperimentalWarning scripts/record-room.ts [--url http://localhost:3000] [--minutes 5] [--out room.webm]
//
// Real time: a 5-minute recording takes 5 minutes. Samples are fetched by Node (the sandboxed browser
// can't reach raw.githubusercontent.com), as in the e2e suite.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    minutes: { type: 'string', default: '5' },
    out: { type: 'string', default: 'room.webm' },
    bitrate: { type: 'string', default: '160000' },
  },
});
const minutes = Number(values.minutes);
if (!(minutes > 0)) throw new Error('--minutes must be a positive number');

// Every connection into a realtime context's destination is also connected to a MediaStream tap,
// which MediaRecorder encodes. Installed before any page script runs.
const TAP = `(() => {
  const connect = AudioNode.prototype.connect;
  const taps = new WeakMap();
  window.__rec = { recorder: null, chunks: [] };
  AudioNode.prototype.connect = function (dest, ...rest) {
    const out = connect.call(this, dest, ...rest);
    const ctx = this.context;
    if (dest instanceof AudioDestinationNode && typeof ctx.createMediaStreamDestination === 'function') {
      let tap = taps.get(ctx);
      if (!tap) {
        tap = ctx.createMediaStreamDestination();
        taps.set(ctx, tap);
        if (!window.__rec.recorder) {
          const recorder = new MediaRecorder(tap.stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: ${Number(values.bitrate)} });
          recorder.ondataavailable = (e) => { if (e.data.size) window.__rec.chunks.push(e.data); };
          recorder.start(1000);
          window.__rec.recorder = recorder;
        }
      }
      connect.call(this, tap);
    }
    return out;
  };
})()`;

const cache = new Map<string, { status: number; type: string; body: Buffer }>();
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
try {
  const context = await browser.newContext();
  await context.route(/^https:\/\/raw\.githubusercontent\.com\//, async (route) => {
    const url = route.request().url();
    try {
      let hit = cache.get(url);
      if (!hit) {
        const res = await fetch(url);
        hit = { status: res.status, type: res.headers.get('content-type') ?? 'application/octet-stream', body: Buffer.from(await res.arrayBuffer()) };
        if (res.ok) cache.set(url, hit);
      }
      await route.fulfill({ status: hit.status, body: hit.body, headers: { 'content-type': hit.type, 'access-control-allow-origin': '*' } });
    } catch {
      await route.abort();
    }
  });
  await context.addInitScript(TAP);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
  const seen = new Set<string>();
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (!seen.has(text)) console.error(`[${m.type()}] ${text}`);
    seen.add(text);
  });
  await page.goto(values.url);
  await page.getByRole('button', { name: 'Drop the needle' }).click();
  await page.locator('.app[data-engine-state="running"]').waitFor({ timeout: 60_000 });

  const started = Date.now();
  const stamp = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  let last = '';
  while (Date.now() - started < minutes * 60_000) {
    const title = await page.locator('.record .label-title').first().textContent().catch(() => null);
    const by = await page.locator('.record .label-by').first().textContent().catch(() => null);
    const now = `${title ?? '?'} (${by ?? '?'})`;
    if (now !== last) console.log(`${stamp()}  ${now}`);
    last = now;
    // Parts the engine muted (density, query errors…) show in the code view.
    for (const error of await page.locator('.status.err').allTextContents().catch(() => [])) {
      if (!seen.has(error)) console.log(`${stamp()}  [part] ${error.trim()}`);
      seen.add(error);
    }
    await page.waitForTimeout(1000);
  }

  const base64 = await page.evaluate(async () => {
    const rec = (window as unknown as { __rec: { recorder: MediaRecorder | null; chunks: Blob[] } }).__rec;
    if (!rec.recorder) return null;
    const recorder = rec.recorder;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });
    const bytes = new Uint8Array(await new Blob(rec.chunks, { type: 'audio/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  if (!base64) throw new Error('nothing was recorded: the engine never connected to the speakers');
  writeFileSync(values.out, Buffer.from(base64, 'base64'));
  console.log(`wrote ${values.out} (${stamp()})`);
} finally {
  await browser.close();
}
