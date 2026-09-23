// The bside CLI: argument parsing, every command against a fake composer API over real HTTP (auth
// header, request bodies, human and JSON output, exit codes, SSE), and Ctrl-C on the real process.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseArgs, UsageError } from '../../src/cli/args.ts';
import { main, type Io } from '../../src/cli/bside.ts';
import { formatIssue, PLAIN } from '../../src/cli/format.ts';
import type { AuditionResult, CommitResult, ComposerApiStatus, PlanRequest } from '../../src/shared/composer-api.ts';
import type { Plan } from '../../src/shared/plan.ts';
import { turnContext } from './fixtures.ts';

const TOKEN = 'test-admin-token-123';

const pending: PlanRequest = { id: 'ep1-r7', kind: 'section', createdAt: 0, softDeadlineMs: 1_034_000, hardDeadlineMs: 1_050_000, targetCycle: 256, scheduleRev: 4, context: turnContext({ id: 'ep1-r7' }) };
pending.context.request.reasons = ['horizon', 'crowd-pressure'];

const status = (over: Partial<ComposerApiStatus> = {}): ComposerApiStatus => ({
  serverTime: 1_000_000,
  epoch: 'ep1',
  driver: 'external',
  pending,
  cycle: 245.26,
  bpm: 120,
  horizonSec: 96.4,
  now: { id: 'ep1-0041', name: 'Harbour Lights', role: 'groove', barsLeft: 12 },
  committed: [{ id: 'ep1-0042', name: 'Glass Harbour', startCycle: 256, provisional: true }],
  ...over,
});

const plan: Plan = {
  sections: [
    {
      name: 'Tide Line',
      role: 'groove',
      bars: 16,
      bpm: 120,
      tempoRampBars: 0,
      tempoRampAt: 'start',
      scale: 'D:dorian',
      chords: null,
      targets: { intensity: { start: 0.5, end: 0.5 }, brightness: { start: 0.5, end: 0.5 }, density: { start: 0.5, end: 0.5 }, tension: { start: 0.3, end: 0.3 } },
      transitionIn: { type: 'cut', bars: 0 },
      parts: [
        { id: 'kick', role: 'kick', code: null, restart: false, chromatic: false, level: 0.8, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null },
        { id: 'bass', role: 'bass', code: 'n("<0 3>").scale("D2:dorian").s("sawtooth")', restart: false, chromatic: false, level: 0.7, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null },
      ],
      reprise: null,
      publicNote: 'A steady tide.',
    },
  ],
  movement: null,
  fork: null,
  requestDecisions: [],
  motifs: [],
  announcement: null,
  rationale: 'test',
};

const auditionOk: AuditionResult = {
  ok: true,
  errors: [],
  warnings: [],
  parts: [{ id: 'bass', role: 'bass', ok: true, errors: [], warnings: [], analysis: null, digest: { id: 'bass', role: 'bass', instrument: 'Sawtooth', evPerBar: 1, register: 'bass', sync: 0, bright: 0.3, loud: 0.4, period: 2, keyFit: 1 } }],
  mix: { descriptors: { intensity: 0.4, brightness: 0.3, density: 0.2, tension: 0.1 }, spans: null as never, onsetsPerBar: 1, maxOnsetsPerBar: 1, peakOverlapGain: 0.5, audibleParts: 1, period: 2 },
  descriptors: { intensity: 0.4, brightness: 0.3, density: 0.2, tension: 0.1 },
};
const reverbIssue = { severity: 'error' as const, rule: 'unknown-method', message: 'Unknown Strudel method .reverb().', path: 'kick', line: 1, column: 10, excerpt: 's("sbd").reverb(1)\n         ^', hint: 'Did you mean .room()?' };
const auditionBad: AuditionResult = { ok: false, errors: [], warnings: [], parts: [{ id: 'kick', role: 'kick', ok: false, errors: [reverbIssue], warnings: [], analysis: null, digest: null }], mix: null, descriptors: null };
const mixIssue = { severity: 'error' as const, rule: 'density', message: 'All parts together play 256 events in bar 0; a section may play at most 192 per bar.', path: 'mix' };
const auditionMixBad: AuditionResult = { ...auditionOk, ok: false, errors: [mixIssue] };

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}

let server: Server;
let base = '';
let seen: Seen[] = [];

async function body(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

function route(req: IncomingMessage, res: ServerResponse, payload: unknown) {
  const send = (code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });
  const p = req.url!.replace('/api/composer', '');
  if (req.method === 'GET' && p === '/status') return send(200, status());
  if (req.method === 'GET' && p === '/context') return send(200, pending.context);
  if (req.method === 'GET' && p === '/reference') return send(200, { system: '# B-Side\nYou are the composer.' });
  if (req.method === 'POST' && p === '/audition') {
    const text = JSON.stringify(payload);
    return send(200, text.includes('reverb') ? auditionBad : text.includes('hh*64') ? auditionMixBad : auditionOk);
  }
  if (req.method === 'POST' && p === '/commit') {
    const name = (payload as { plan: Plan }).plan.sections[0]!.name;
    const result: CommitResult =
      name === 'Tide Line'
        ? { accepted: true, errors: [], warnings: [{ severity: 'warning', rule: 'targets', message: 'Measured tension 0 is far from 0.3.', path: 'sections[0].targets.tension' }], sections: [{ id: 'ep1-0043', name, startCycle: 272, bars: 16 }] }
        : { accepted: false, errors: [reverbIssue], warnings: [], sections: [] };
    return send(200, result);
  }
  if (req.method === 'POST' && p === '/driver') return send(200, status({ driver: (payload as { driver: 'claude' }).driver, pending: null }));
  if (req.method === 'POST' && p === '/plan') return send(200, status());
  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`: ping\n\nevent: status\ndata: ${JSON.stringify(status())}\n\n`);
    res.write(`event: request\ndata: ${JSON.stringify(pending)}\n\n`);
    res.write(`event: started\r\ndata: {"sectionId":"ep1-0042"}\r\n\r\n`);
    res.end(`event: revoke\ndata: {"sectionId":"ep1-0044"}\n\n`);
    return;
  }
  send(404, { error: 'not found' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void body(req).then((payload) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: payload });
      route(req, res, payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

function io(files: Record<string, string> = {}, env: Record<string, string> = { BSIDE_URL: base, BSIDE_ADMIN_TOKEN: TOKEN }) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    env,
    out: (t) => void out.push(t),
    err: (t) => void err.push(t),
    readFile: async (path) => {
      if (!(path in files)) throw new Error('ENOENT: no such file');
      return files[path]!;
    },
    readStdin: async () => files['-'] ?? '',
    tty: false,
  };
  return { io: value, out, err, text: () => out.join('\n'), errors: () => err.join('\n') };
}

describe('parseArgs', () => {
  it('reads a command, positionals, value flags (both spellings, repeatable) and booleans', () => {
    const a = parseArgs(['audition', '--code=s("bd")', '--knob', 'cut=800:300:2400', '--knob', 'wet=0.5:0:1', '--json', 'extra']);
    expect(a.command).toBe('audition');
    expect(a.positionals).toEqual(['extra']);
    expect(a.values.get('code')).toEqual(['s("bd")']);
    expect(a.values.get('knob')).toEqual(['cut=800:300:2400', 'wet=0.5:0:1']);
    expect(a.booleans.has('json')).toBe(true);
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['status', '-h']).booleans.has('help')).toBe(true);
  });

  it('rejects unknown commands, unknown flags and missing values', () => {
    expect(() => parseArgs(['dance'])).toThrow(UsageError);
    expect(() => parseArgs(['status', '--verbose'])).toThrow(/unknown option --verbose/);
    expect(() => parseArgs(['commit', 'plan.json', '--request'])).toThrow(/needs a value/);
    expect(() => parseArgs(['commit', '--now=yes'])).toThrow(/takes no value/);
  });
});

describe('formatIssue', () => {
  it('shows rule, message, position with the excerpt and caret aligned, and the hint', () => {
    expect(formatIssue(reverbIssue, PLAIN).split('\n')).toEqual([
      '✗ kick  unknown-method',
      '  Unknown Strudel method .reverb().',
      '  1:10  s("sbd").reverb(1)',
      '                 ^',
      '  hint: Did you mean .room()?',
    ]);
  });
});

describe('bside against the composer API', () => {
  it('status: a readable table, sent with the admin token', async () => {
    const t = io();
    expect(await main(['status'], t.io)).toBe(0);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/api/composer/status', auth: `Bearer ${TOKEN}` });
    expect(t.text()).toBe(
      [
        'B-Side  epoch ep1 · driver external · cycle 245.3 · 120 BPM · horizon 96 s',
        'now      ep1-0041  "Harbour Lights"  groove  12 bars left',
        'next     ep1-0042  "Glass Harbour"   @256    provisional',
        'pending  ep1-r7    section           horizon, crowd-pressure · starts @256 · soft in 34 s · hard in 50 s',
      ].join('\n'),
    );
    const j = io();
    expect(await main(['status', '--json'], j.io)).toBe(0);
    expect(JSON.parse(j.text())).toMatchObject({ driver: 'external', pending: { id: 'ep1-r7' } });
  });

  it('context and reference print what the server returns', async () => {
    const c = io();
    expect(await main(['context'], c.io)).toBe(0);
    expect(JSON.parse(c.text()).request.id).toBe('ep1-r7');
    const r = io();
    expect(await main(['reference'], r.io)).toBe(0);
    expect(r.text()).toBe('# B-Side\nYou are the composer.');
  });

  it('explains auth failures and unreachable servers, exiting 1', async () => {
    const bad = io({}, { BSIDE_URL: base, BSIDE_ADMIN_TOKEN: 'wrong' });
    expect(await main(['status'], bad.io)).toBe(1);
    expect(bad.errors()).toMatch(/401 unauthorized \(set BSIDE_ADMIN_TOKEN/);
    const down = io({}, { BSIDE_URL: 'http://127.0.0.1:1' });
    expect(await main(['status'], down.io)).toBe(1);
    expect(down.errors()).toMatch(/cannot reach http:\/\/127\.0\.0\.1:1/);
    const flag = io({}, { BSIDE_URL: 'http://127.0.0.1:1', BSIDE_ADMIN_TOKEN: 'wrong' });
    expect(await main(['status', '--url', base, '--token', TOKEN], flag.io)).toBe(0);
  });

  it('audition --code builds one part with knobs, and exits 1 with readable issues on errors', async () => {
    const t = io();
    expect(await main(['audition', '--code', 's("sbd").reverb(1)', '--role', 'kick', '--knob', 'cut=800:300:2400:brightness', '--scale', 'D:dorian', '--bpm', '124'], t.io)).toBe(1);
    expect(seen[0]!.body).toEqual({
      parts: [{ id: 'kick', role: 'kick', code: 's("sbd").reverb(1)', knobs: [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' }], chromatic: false }],
      bpm: 124,
      scale: 'D:dorian',
      bars: null,
    });
    expect(t.text()).toContain('✗ kick  no analysis');
    expect(t.text()).toContain('hint: Did you mean .room()?');
    const bad = io();
    expect(await main(['audition', '--code', 's("bd")', '--role', 'drums'], bad.io)).toBe(2);
    expect(await main(['audition', '--code', 's("bd")', '--knob', 'cut'], io().io)).toBe(2);
  });

  it('audition exits 1 and prints section-level issues when only the mix fails', async () => {
    const t = io();
    expect(await main(['audition', '--code', 's("hh*64")', '--role', 'hats'], t.io)).toBe(1);
    expect(t.text()).toContain('✓ bass');
    expect(t.text()).toContain('✗ section\n  ✗ mix  density\n    All parts together play 256 events');
  });

  it('audition <plan.json> auditions each section\'s new code at its tempo and scale, skipping carried parts', async () => {
    const t = io({ 'plan.json': JSON.stringify(plan) });
    expect(await main(['audition', 'plan.json'], t.io)).toBe(0);
    expect(seen[0]!.body).toEqual({ parts: [{ id: 'bass', role: 'bass', code: plan.sections[0]!.parts[1]!.code, knobs: [], chromatic: false }], bpm: 120, scale: 'D:dorian', bars: 16 });
    expect(t.text()).toContain('✓ bass  Sawtooth · 1 ev/bar · bass · key fit 100%');
  });

  it('commit fulfils the pending request with --request pending and a mode flag', async () => {
    const t = io({ 'plan.json': JSON.stringify(plan) });
    expect(await main(['commit', 'plan.json', '--next', '--request', 'pending'], t.io)).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(['/api/composer/status', '/api/composer/commit']);
    expect(seen[1]!.body).toEqual({ plan, mode: 'next', requestId: 'ep1-r7' });
    expect(t.text()).toBe(['✓ accepted', '  ep1-0043  "Tide Line"  @272  16 bars', '1 warning:', '! sections[0].targets.tension  targets\n  Measured tension 0 is far from 0.3.'].join('\n'));
  });

  it('commit accepts a {plan, mode, requestId} body from stdin and exits 1 when rejected', async () => {
    const rejectedPlan = { ...plan, sections: [{ ...plan.sections[0]!, name: 'Broken' }] };
    const t = io({ '-': JSON.stringify({ plan: rejectedPlan, mode: 'now', requestId: 'ep1-r7' }) });
    expect(await main(['commit', '-'], t.io)).toBe(1);
    expect(seen[0]!.body).toEqual({ plan: rejectedPlan, mode: 'now', requestId: 'ep1-r7' });
    expect(t.text()).toContain('✗ rejected (1 error)');
  });

  it('commit checks the plan locally before sending it, and rejects conflicting flags', async () => {
    const t = io({ 'bad.json': JSON.stringify({ ...plan, sections: [] }), 'broken.json': '{ nope' });
    expect(await main(['commit', 'bad.json'], t.io)).toBe(1);
    expect(t.errors()).toMatch(/not a valid plan:\n {2}sections:/);
    expect(await main(['commit', 'broken.json'], t.io)).toBe(1);
    expect(t.errors()).toMatch(/not valid JSON/);
    expect(await main(['commit', 'missing.json'], t.io)).toBe(1);
    expect(await main(['commit', 'bad.json', '--now', '--next'], io({ 'bad.json': JSON.stringify(plan) }).io)).toBe(2);
    expect(seen).toEqual([]);
  });

  it('driver and plan post their bodies; a bad driver is a usage error', async () => {
    const t = io();
    expect(await main(['driver', 'claude'], t.io)).toBe(0);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/composer/driver', body: { driver: 'claude' } });
    expect(t.text()).toContain('driver claude');
    expect(await main(['plan'], io().io)).toBe(0);
    expect(seen[1]).toMatchObject({ method: 'POST', url: '/api/composer/plan', body: { reason: 'manual' } });
    expect(await main(['driver', 'robot'], io().io)).toBe(2);
  });

  it('watch prints one line per event (CRLF tolerant) or NDJSON with --json', async () => {
    const t = io();
    expect(await main(['watch'], t.io)).toBe(0);
    const lines = t.text().split('\n').map((l) => l.slice(10));
    expect(lines).toEqual([
      'status  driver external  cycle 245.3  horizon 96 s  pending ep1-r7',
      'request  ep1-r7  section  horizon, crowd-pressure  starts @256  soft in 40 s  hard in 60 s',
      'started  ep1-0042',
      'revoked  ep1-0044',
    ]);
    const j = io();
    expect(await main(['watch', '--json'], j.io)).toBe(0);
    expect(j.out.map((l) => JSON.parse(l).event)).toEqual(['status', 'request', 'started', 'revoke']);
  });

  it('help and usage errors', async () => {
    const h = io();
    expect(await main(['--help'], h.io)).toBe(0);
    expect(h.text()).toContain('Usage: npm run bside -- <command>');
    const u = io();
    expect(await main(['frobnicate'], u.io)).toBe(2);
    expect(u.errors()).toMatch(/unknown command "frobnicate"/);
  });
});

describe('Ctrl-C on the bside process', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));

  /** Runs `bside <args>` against a server that answers with `handle`, and sends SIGINT once `ready`. */
  async function interrupt(args: string[], handle: (res: ServerResponse) => void, ready: (stdout: string, requested: boolean) => boolean) {
    let requested = false;
    const hung = createServer((_req, res) => {
      requested = true;
      handle(res);
    });
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', r));
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/cli/bside.ts', ...args], {
      cwd: root,
      env: { ...process.env, BSIDE_URL: `http://127.0.0.1:${(hung.address() as AddressInfo).port}`, BSIDE_ADMIN_TOKEN: TOKEN, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      while (!ready(stdout, requested) && child.exitCode === null) await new Promise((r) => setTimeout(r, 20));
      child.kill('SIGINT');
      const outcome = await Promise.race([exited.then(([code, signal]) => ({ code, signal })), new Promise((r) => setTimeout(() => r('still running'), 3000))]);
      return { outcome, stdout, stderr };
    } finally {
      child.kill('SIGKILL');
      hung.closeAllConnections();
      hung.close();
    }
  }

  it('stops a command that is waiting on the server at the first Ctrl-C', async () => {
    const { outcome } = await interrupt(['status'], () => {}, (_out, requested) => requested);
    expect(outcome).toEqual({ code: null, signal: 'SIGINT' });
  });

  it('ends watch cleanly', async () => {
    const stream = (res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: started\ndata: {"sectionId":"ep1-0042"}\n\n');
    };
    const { outcome, stdout } = await interrupt(['watch'], stream, (out) => out.includes('started'));
    expect(outcome).toEqual({ code: 0, signal: null });
    expect(stdout).toContain('started  ep1-0042');
  });
});
