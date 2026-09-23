// The HTTP surface end to end: security headers, the admin guard, the composer API, SSE, the palette.
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { PlanSchema, type Plan } from '../../src/shared/plan.ts';
import { PRODUCTION_CSP } from '../../src/server/http/security.ts';
import { bootRoom, fixture, type Room } from './harness.ts';

let room: Room | null = null;
afterEach(async () => {
  await room?.close();
  room = null;
});

async function boot(...args: Parameters<typeof bootRoom>) {
  room = await bootRoom(...args);
  return room;
}

const TOKEN = 'a-long-enough-admin-token';
const auth = { authorization: `Bearer ${TOKEN}` };
const json = { 'content-type': 'application/json' };

const PLAN: Plan = PlanSchema.parse({
  sections: [
    {
      name: 'Test Pulse',
      role: 'groove',
      bars: 16,
      bpm: 120,
      tempoRampBars: 0,
      tempoRampAt: 'start',
      scale: 'C:minor',
      chords: null,
      targets: {
        intensity: { start: 0.5, end: 0.5 },
        brightness: { start: 0.5, end: 0.5 },
        density: { start: 0.5, end: 0.5 },
        tension: { start: 0.3, end: 0.4 },
      },
      transitionIn: { type: 'cut', bars: 0 },
      parts: [
        { id: 'kick', role: 'kick', code: 's("bd*4")', restart: false, chromatic: false, level: 0.8, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null },
      ],
      reprise: null,
      publicNote: 'A steady pulse.',
    },
  ],
  movement: null,
  fork: null,
  requestDecisions: [],
  motifs: [],
  announcement: null,
  rationale: 'integration test',
});

describe('security headers', () => {
  it('serves the exact production CSP and hardening headers in production', async () => {
    const r = await boot({ dev: false });
    const res = await fetch(`${r.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(PRODUCTION_CSP);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age=\d+/);
    expect(res.headers.get('x-powered-by')).toBeNull();
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, listeners: 0, bpm: 120 });
  });

  it('relaxes the CSP for Vite in development, without HSTS', async () => {
    const r = await boot({ dev: true });
    const res = await fetch(`${r.url}/api/health`);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("'unsafe-inline'");
    expect(csp).toContain('ws:');
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('strict-transport-security')).toBeNull();
  });
});

describe('admin guard', () => {
  it('development without a token: direct loopback only', async () => {
    const r = await boot({ dev: true, adminToken: null });
    expect((await fetch(`${r.url}/api/composer/status`)).status).toBe(200);
    const proxied = await fetch(`${r.url}/api/composer/status`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.status).toBe(403);
  });

  it('production without a token: the routes do not exist', async () => {
    const r = await boot({ dev: false, adminToken: null });
    for (const path of ['status', 'context', 'reference', 'events']) expect((await fetch(`${r.url}/api/composer/${path}`)).status).toBe(404);
    const commit = await fetch(`${r.url}/api/composer/commit`, { method: 'POST', headers: json, body: JSON.stringify({ plan: PLAN }) });
    expect(commit.status).toBe(404);
    expect(r.conductor.commits).toEqual([]);
  });

  it('with a token: Bearer required (even from loopback), bad tokens 401, repeated failures 429', async () => {
    const r = await boot({ dev: true, adminToken: TOKEN });
    const missing = await fetch(`${r.url}/api/composer/status`);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);
    expect((await fetch(`${r.url}/api/composer/status`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const ok = await fetch(`${r.url}/api/composer/status`, { headers: auth });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ epoch: fixture.epoch, driver: 'scripted' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${r.url}/api/composer/status`, { headers: { authorization: `Bearer guess-${i}` } })).status);
    expect(statuses).toContain(429);
    expect((await fetch(`${r.url}/api/composer/status`, { headers: auth })).status).toBe(200);
  });
});

describe('composer API', () => {
  const post = (r: Room, path: string, body: unknown, raw = false) =>
    fetch(`${r.url}/api/composer/${path}`, { method: 'POST', headers: { ...auth, ...json }, body: raw ? (body as string) : JSON.stringify(body) });

  it('commit: 400 on malformed JSON or schema, 200 with the CommitResult otherwise', async () => {
    const r = await boot({ adminToken: TOKEN });
    const malformed = await post(r, 'commit', '{"plan": ', true);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'malformed JSON' });
    const noBody = await fetch(`${r.url}/api/composer/commit`, { method: 'POST', headers: auth });
    expect(noBody.status).toBe(400);
    const badPlan = await post(r, 'commit', { plan: { sections: [] } });
    expect(badPlan.status).toBe(400);
    const bad = (await badPlan.json()) as { error: string; issues: { rule: string; path?: string }[] };
    expect(bad.error).toBe('invalid plan');
    expect(bad.issues.map((i) => i.path)).toEqual(expect.arrayContaining(['sections', 'movement']));
    expect(bad.issues.every((i) => i.rule === 'schema')).toBe(true);
    const extra = await post(r, 'commit', { plan: PLAN, sneaky: true });
    expect(extra.status).toBe(400);
    const ok = await post(r, 'commit', { plan: PLAN, mode: 'next', requestId: 'req-1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ accepted: true, sections: [{ name: 'Test Pulse', bars: 16 }] });
    expect(r.conductor.commits).toEqual([{ body: { plan: PLAN, mode: 'next', requestId: 'req-1' }, author: 'external' }]);
  });

  it('commit is rate limited', async () => {
    const r = await boot({ adminToken: TOKEN });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post(r, 'commit', { plan: PLAN })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('audition, driver, plan, context and reference', async () => {
    const r = await boot({ adminToken: TOKEN });
    const audition = await post(r, 'audition', { parts: [{ id: 'hat', role: 'hats', code: 's("hh*8")', knobs: [], chromatic: false }], bpm: null, scale: null, bars: null });
    expect(audition.status).toBe(200);
    expect(await audition.json()).toMatchObject({ parts: [{ id: 'hat', ok: true }] });
    expect((await post(r, 'audition', { parts: [] })).status).toBe(400);
    const driver = await post(r, 'driver', { driver: 'external' });
    expect(await driver.json()).toMatchObject({ driver: 'external' });
    expect((await post(r, 'driver', { driver: 'gpt' })).status).toBe(400);
    expect((await post(r, 'plan', {})).status).toBe(200);
    expect(r.conductor.plans).toEqual(['manual']);
    expect(await (await fetch(`${r.url}/api/composer/context`, { headers: auth })).json()).toEqual({ request: { id: 'preview' } });
    expect(await (await fetch(`${r.url}/api/composer/reference`, { headers: auth })).json()).toEqual({ system: 'SYSTEM PROMPT' });
    const unknown = await fetch(`${r.url}/api/composer/nope`, { headers: auth });
    expect(unknown.status).toBe(404);
  });

  it('streams conductor events over SSE with heartbeats, and unsubscribes on close', async () => {
    const r = await boot({ adminToken: TOKEN });
    const baseline = r.conductor.listenerCount();
    const { chunks, close } = await openStream(`${r.url}/api/composer/events`, auth);
    await waitFor(() => chunks.join('').includes('event: status'));
    expect(r.conductor.listenerCount()).toBe(baseline + 5);
    r.conductor.fire('section', fixture.sections[0]!);
    r.conductor.fire('revoke', 'fx01-0009');
    r.conductor.fire('started', 'fx01-0001');
    await waitFor(() => chunks.join('').includes('event: started'));
    const text = chunks.join('');
    expect(text).toContain(`event: section\ndata: ${JSON.stringify(fixture.sections[0])}\n\n`);
    expect(text).toContain('event: revoke\ndata: {"sectionId":"fx01-0009"}\n\n');
    await waitFor(() => chunks.join('').includes(': ping'));
    close();
    await waitFor(() => r.conductor.listenerCount() === baseline);
  });
});

describe('palette', () => {
  it('serves the catalog (short cache) and maps (immutable only when versioned), nothing else', async () => {
    const r = await boot();
    const catalog = await fetch(`${r.url}/palette/catalog.json`);
    expect(catalog.status).toBe(200);
    expect(catalog.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(await catalog.json()).toMatchObject({ version: 'test' });
    const versioned = await fetch(`${r.url}/palette/maps/drums.json?v=test`);
    expect(versioned.headers.get('cache-control')).toContain('immutable');
    const plain = await fetch(`${r.url}/palette/maps/drums.json`);
    expect(plain.headers.get('cache-control')).toBe('public, max-age=3600');
    expect((await fetch(`${r.url}/palette/levels.json`)).status).toBe(404);
    expect((await fetch(`${r.url}/palette/maps/missing.json`)).status).toBe(404);
    expect((await rawGet(r.url, '/palette/maps/..%2f..%2fcatalog.json')).status).toBe(404);
    expect((await rawGet(r.url, '/palette/../package.json')).status).toBe(404);
  });
});

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function openStream(url: string, headers: Record<string, string>): Promise<{ chunks: string[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const req = httpRequest(url, { headers }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`status ${res.statusCode}`));
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      res.setEncoding('utf8');
      res.on('data', (c: string) => chunks.push(c));
      res.on('error', () => {});
      resolve({ chunks, close: () => req.destroy() });
    });
    req.on('error', () => {});
    req.end();
  });
}

/** A GET with the path sent verbatim (fetch would normalise dot segments). */
function rawGet(base: string, path: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(base);
    const req = httpRequest({ hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on('error', reject);
    req.end();
  });
}
