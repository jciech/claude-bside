// `npm run bside -- <command>`: the external composer's command line. It talks to /api/composer/*
// (BSIDE_URL, BSIDE_ADMIN_TOKEN) and never imports Strudel, so it runs with plain node.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { AuditionInput, AuditionResult, CommitBody, CommitMode, CommitResult, ComposerApiStatus, DriverName } from '../shared/composer-api.ts';
import { PART_ID_PATTERN, PART_ROLES, type PartRole } from '../shared/music.ts';
import { AuditionInputSchema, KnobSchema, PlanSchema, type Knob, type Plan } from '../shared/plan.ts';
import { numberValue, parseArgs, UsageError, USAGE, value, type Args } from './args.ts';
import { ApiError, createApiClient, type ApiClient } from './client.ts';
import { COLOR, formatAudition, formatCommit, formatEvent, formatIssues, formatStatus, PLAIN, type Style } from './format.ts';

export interface Io {
  env: Record<string, string | undefined>;
  out(text: string): void;
  err(text: string): void;
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
  fetch?: typeof fetch;
  /** Colour when the terminal supports it. */
  tty: boolean;
  /** Ends `watch` (Ctrl-C in the real CLI). */
  signal?: AbortSignal;
}

const DEFAULT_URL = 'http://localhost:3000';
const DRIVERS: readonly DriverName[] = ['claude', 'external', 'scripted'];

class Failure extends Error {}

async function readInput(io: Io, path: string | undefined): Promise<unknown> {
  if (!path) throw new UsageError('give a JSON file (or - for stdin)');
  let text: string;
  try {
    text = path === '-' ? await io.readStdin() : await io.readFile(path);
  } catch (e) {
    throw new Failure(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Failure(`${path === '-' ? 'stdin' : path} is not valid JSON: ${(e as Error).message}`);
  }
}

function parseKnob(spec: string): Knob {
  const m = /^([a-z][a-z0-9_]{0,15})=(-?[\d.]+):(-?[\d.]+):(-?[\d.]+)(?::(-?[a-z]+))?$/.exec(spec);
  if (!m) throw new UsageError(`--knob "${spec}" should look like cut=800:300:2400 or cut=800:300:2400:brightness`);
  const knob = KnobSchema.safeParse({ name: m[1], default: Number(m[2]), min: Number(m[3]), max: Number(m[4]), follows: m[5] ?? 'none' });
  if (!knob.success) throw new UsageError(`--knob "${spec}": ${knob.error.issues[0]?.message}`);
  return knob.data;
}

/** One or more audition inputs from a file (AuditionInput, a parts array, or a Plan) or from --code. */
function auditionInputs(args: Args, raw: unknown | null): { title?: string; input: AuditionInput }[] {
  const bpm = numberValue(args, 'bpm') ?? null;
  const bars = numberValue(args, 'bars') ?? null;
  const scale = value(args, 'scale') ?? null;
  const check = (input: unknown, title?: string) => {
    const parsed = AuditionInputSchema.safeParse(input);
    if (!parsed.success) throw new Failure(`not a valid audition input${title ? ` (${title})` : ''}:\n${parsed.error.issues.slice(0, 8).map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
    return { title, input: parsed.data };
  };
  if (raw === null) {
    const code = value(args, 'code');
    if (!code) throw new UsageError('audition needs a file, - for stdin, or --code');
    const role = (value(args, 'role') ?? 'lead') as PartRole;
    if (!PART_ROLES.includes(role)) throw new UsageError(`--role must be one of ${PART_ROLES.join(', ')}`);
    const id = value(args, 'id') ?? role;
    if (!PART_ID_PATTERN.test(id)) throw new UsageError('--id must be lowercase letters, digits or _ (starting with a letter)');
    const knobs = (args.values.get('knob') ?? []).map(parseKnob);
    return [check({ parts: [{ id, role, code, knobs, chromatic: args.booleans.has('chromatic') }], bpm, scale, bars })];
  }
  const plan = PlanSchema.safeParse(raw);
  if (plan.success) {
    return plan.data.sections.flatMap((s, i) => {
      const parts = s.parts.filter((p) => p.code !== null).map((p) => ({ id: p.id, role: p.role, code: p.code!, knobs: p.knobs, chromatic: p.chromatic }));
      return parts.length ? [check({ parts, bpm: s.bpm, scale: s.scale, bars: s.bars }, `sections[${i}] "${s.name}"`)] : [];
    });
  }
  if (Array.isArray(raw)) return [check({ parts: raw, bpm, scale, bars })];
  return [check({ bpm: null, scale: null, bars: null, ...(raw as object) })];
}

async function commitBody(args: Args, raw: unknown, api: ApiClient): Promise<CommitBody> {
  const wrapped: { plan: unknown; mode?: CommitMode; requestId?: string } = raw && typeof raw === 'object' && 'plan' in raw ? (raw as CommitBody) : { plan: raw };
  const plan = PlanSchema.safeParse(wrapped.plan);
  if (!plan.success) {
    throw new Failure(`not a valid plan:\n${plan.error.issues.slice(0, 12).map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')}`);
  }
  if (args.booleans.has('now') && args.booleans.has('next')) throw new UsageError('use --now or --next, not both');
  const mode: CommitMode | undefined = args.booleans.has('now') ? 'now' : args.booleans.has('next') ? 'next' : wrapped.mode;
  let requestId = value(args, 'request') ?? wrapped.requestId;
  if (requestId === 'pending') {
    const status = await api.get<ComposerApiStatus>('/status');
    if (!status.pending) throw new Failure('no planning request is pending (set the driver to external, or commit without --request)');
    requestId = status.pending.id;
  }
  return { plan: plan.data as Plan, ...(mode ? { mode } : {}), ...(requestId ? { requestId } : {}) };
}

async function run(args: Args, io: Io, st: Style): Promise<number> {
  const json = args.booleans.has('json');
  const api = createApiClient({
    baseUrl: value(args, 'url') ?? io.env.BSIDE_URL ?? DEFAULT_URL,
    token: value(args, 'token') ?? io.env.BSIDE_ADMIN_TOKEN ?? null,
    fetch: io.fetch,
  });
  const print = (data: unknown, human: () => string) => io.out(json ? JSON.stringify(data, null, 2) : human());

  switch (args.command) {
    case 'help':
      io.out(USAGE);
      return 0;
    case 'status': {
      const s = await api.get<ComposerApiStatus>('/status');
      print(s, () => formatStatus(s, st));
      return 0;
    }
    case 'context':
      io.out(JSON.stringify(await api.get('/context'), null, 2));
      return 0;
    case 'reference': {
      const r = await api.get<{ system: string }>('/reference');
      print(r, () => r.system);
      return 0;
    }
    case 'audition': {
      const file = args.positionals[0];
      const inputs = auditionInputs(args, file ? await readInput(io, file) : null);
      if (!inputs.length) throw new Failure('nothing to audition: every part in the plan is carried (code null)');
      let ok = true;
      const results: AuditionResult[] = [];
      for (const { title, input } of inputs) {
        const r = await api.post<AuditionResult>('/audition', input);
        results.push(r);
        ok &&= r.ok;
        if (!json) io.out(formatAudition(r, st, inputs.length > 1 ? title : undefined));
      }
      if (json) io.out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
      return ok ? 0 : 1;
    }
    case 'commit': {
      const body = await commitBody(args, await readInput(io, args.positionals[0]), api);
      const r = await api.post<CommitResult>('/commit', body);
      print(r, () => formatCommit(r, st));
      return r.accepted ? 0 : 1;
    }
    case 'driver': {
      const driver = args.positionals[0] as DriverName | undefined;
      if (!driver || !DRIVERS.includes(driver)) throw new UsageError(`driver must be one of ${DRIVERS.join(', ')}`);
      const s = await api.post<ComposerApiStatus>('/driver', { driver });
      print(s, () => formatStatus(s, st));
      return 0;
    }
    case 'plan': {
      const s = await api.post<ComposerApiStatus>('/plan', { reason: 'manual' });
      print(s, () => formatStatus(s, st));
      return 0;
    }
    case 'watch': {
      const signal = io.signal ?? new AbortController().signal;
      await api.events(signal, (event, data) => io.out(json ? JSON.stringify({ event, data }) : formatEvent(event, data, st)));
      return 0;
    }
  }
}

/** Runs one command; returns the exit code (0 ok, 1 failed or rejected, 2 usage). */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    io.err(`bside: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.booleans.has('help')) {
    io.out(USAGE);
    return 0;
  }
  const st = io.tty && !args.booleans.has('no-color') && !io.env.NO_COLOR ? COLOR : PLAIN;
  try {
    return await run(args, io, st);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`bside ${args.command}: ${e.message}`);
      return 2;
    }
    if (e instanceof ApiError) {
      io.err(`bside ${args.command}: ${e.message}${e.issues.length ? `\n${formatIssues(e.issues, st)}` : ''}`);
      return 1;
    }
    if (e instanceof Failure) {
      io.err(`bside ${args.command}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.exitCode = await main(process.argv.slice(2), {
    env: process.env,
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
    readFile: (path) => readFile(path, 'utf8'),
    readStdin: () => readAll(process.stdin),
    tty: process.stdout.isTTY === true,
    signal: stop.signal,
  });
}
