// The HTTP API: /api/health, and /api/composer/* for the external driver and the `bside` CLI
// (routes and shapes in src/shared/composer-api.ts).
import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Issue } from '../../shared/analysis.ts';
import { AuditionInputSchema, PlanSchema } from '../../shared/plan.ts';
import type { Conductor, ConductorEvents, Crowd, Logger, RoomClock, ServerConfig } from '../types.ts';
import { adminGuard, rateLimit } from './security.ts';

export interface ApiDeps {
  conductor: Conductor;
  crowd: Crowd;
  clock: RoomClock;
  config: ServerConfig;
  log: Logger;
  /** The composer system prompt + reference card (composerSystemPrompt(catalog)). */
  reference?: () => string;
  /** SSE comment heartbeat interval (default 15 s). */
  sseHeartbeatMs?: number;
}

const BODY_LIMIT = '512kb';
const MAX_SSE_CLIENTS = 8;
/** A stream this far behind is dropped rather than buffered without bound. */
const MAX_SSE_BUFFER_BYTES = 1 << 20;

const CommitEnvelopeSchema = z
  .object({
    plan: z.unknown(),
    mode: z.enum(['horizon', 'next', 'now']).optional(),
    requestId: z.string().max(64).optional(),
  })
  .strict();
const DriverBodySchema = z.object({ driver: z.enum(['claude', 'external', 'scripted']) }).strict();
const PlanBodySchema = z.object({ reason: z.literal('manual').optional() }).strict();

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, key) => (typeof key === 'number' ? `${out}[${key}]` : out ? `${out}.${String(key)}` : String(key)), '');
}

function schemaIssues(error: z.ZodError, prefix: readonly PropertyKey[] = []): Issue[] {
  return error.issues.slice(0, 50).map((issue) => ({
    severity: 'error',
    rule: 'schema',
    message: issue.message,
    path: formatPath([...prefix, ...issue.path]) || undefined,
  }));
}

function badRequest(res: Response, error: string, issues?: Issue[]): void {
  res.status(400).json(issues ? { error, issues } : { error });
}

/** Parses req.body with `schema`, answering 400 { error, issues } itself on failure. */
function parseBody<T>(req: Request, res: Response, schema: z.ZodType<T>, what: string): T | undefined {
  if (req.body === undefined) {
    badRequest(res, 'expected a JSON body (Content-Type: application/json)');
    return undefined;
  }
  const parsed = schema.safeParse(req.body);
  if (parsed.success) return parsed.data;
  badRequest(res, `invalid ${what}`, schemaIssues(parsed.error));
  return undefined;
}

export function createApiRouter(deps: ApiDeps): Router {
  const { conductor, crowd, clock, config, log } = deps;
  const heartbeatMs = deps.sseHeartbeatMs ?? 15_000;
  const bootedAt = clock.now();
  let reference: string | null = null;
  let sseClients = 0;

  const router = Router();

  router.get('/health', (_req, res) => {
    const t = clock.now();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      serverTime: t,
      uptimeSec: Math.round((t - bootedAt) / 1000),
      cycle: clock.cycle(),
      bpm: clock.bpm(),
      listeners: crowd.audibleListeners(t),
    });
  });

  const composer = Router();
  composer.use(adminGuard(config));
  composer.use(express.json({ limit: BODY_LIMIT }));
  composer.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  composer.get('/status', (_req, res) => {
    res.json(conductor.apiStatus());
  });

  composer.get('/context', (_req, res) => {
    res.json(conductor.previewContext());
  });

  composer.get('/reference', (_req, res) => {
    if (!deps.reference) return void res.status(503).json({ error: 'the composer reference is not available' });
    reference ??= deps.reference();
    res.json({ system: reference });
  });

  composer.post('/audition', rateLimit({ perSec: 2, burst: 20 }, 'audition'), async (req, res) => {
    const input = parseBody(req, res, AuditionInputSchema, 'audition input');
    if (input) res.json(await conductor.audition(input));
  });

  composer.post('/commit', rateLimit({ perSec: 0.5, burst: 10 }, 'commit'), async (req, res) => {
    const envelope = parseBody(req, res, CommitEnvelopeSchema, 'commit body');
    if (!envelope) return;
    const plan = PlanSchema.safeParse(envelope.plan);
    if (!plan.success) return badRequest(res, 'invalid plan', schemaIssues(plan.error));
    const result = await conductor.commit({ plan: plan.data, mode: envelope.mode, requestId: envelope.requestId }, 'external');
    log.info('external commit', { accepted: result.accepted, errors: result.errors.length, sections: result.sections.map((s) => s.id) });
    res.json(result);
  });

  composer.post('/driver', rateLimit({ perSec: 0.2, burst: 5 }, 'driver'), async (req, res) => {
    const body = parseBody(req, res, DriverBodySchema, 'driver body');
    if (body) res.json(await conductor.setDriver(body.driver));
  });

  composer.post('/plan', rateLimit({ perSec: 0.2, burst: 5 }, 'plan'), (req, res) => {
    const body = parseBody(req, res, PlanBodySchema, 'plan body');
    if (!body) return;
    conductor.requestPlan('manual');
    res.json(conductor.apiStatus());
  });

  composer.get('/events', (req, res) => {
    if (sseClients >= MAX_SSE_CLIENTS) return void res.status(429).json({ error: 'too many event streams' });
    sseClients++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let open = true;
    const unsubscribers: (() => void)[] = [];
    const close = () => {
      if (!open) return;
      open = false;
      sseClients--;
      clearInterval(heartbeat);
      for (const off of unsubscribers) off();
      res.end();
    };
    const send = (event: string, data: unknown) => {
      if (!open) return;
      if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
        log.warn('dropping a stalled composer event stream');
        return close();
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => open && res.write(': ping\n\n'), heartbeatMs);
    heartbeat.unref();
    const listen = <E extends keyof ConductorEvents>(event: E, toData: (...args: Parameters<ConductorEvents[E]>) => unknown) =>
      unsubscribers.push(conductor.on(event, ((...args: Parameters<ConductorEvents[E]>) => send(event, toData(...args))) as ConductorEvents[E]));
    listen('request', (r) => r);
    listen('status', (s) => s);
    listen('section', (s) => s);
    listen('revoke', (sectionId) => ({ sectionId }));
    listen('started', (sectionId) => ({ sectionId }));
    req.on('close', close);
    res.on('error', close);
    send('status', conductor.apiStatus());
  });

  const errors: ErrorRequestHandler = (err: { type?: string; status?: number; message?: string }, _req, res, _next) => {
    if (res.headersSent) return void res.end();
    if (err.type === 'entity.parse.failed') return badRequest(res, 'malformed JSON');
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: `body larger than ${BODY_LIMIT}` });
    if (err.status && err.status >= 400 && err.status < 500) return void res.status(err.status).json({ error: err.message ?? 'bad request' });
    log.error('composer API failed', { err });
    res.status(500).json({ error: err.message ?? 'internal error' });
  };
  composer.use(errors);

  router.use('/composer', composer);
  router.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  return router;
}
