// The checker pool (contract: src/server/types.ts). Evaluation executes composer code and a
// pathological pattern can hang, so every job runs in a worker thread with a heap cap and a
// wall-clock timeout; a timed-out or crashed worker is replaced. Commit jobs overtake auditions.
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Issue, PartCheck, SectionCheck } from '../../shared/analysis.ts';
import type { Catalog, CheckOptions, CheckSectionInput, Checker } from '../types.ts';
import { auditionToSection, sectionToAudition } from './audition.ts';
import type { WorkerRequest, WorkerResponse } from './worker.ts';

const WORKER_URL = new URL('./worker.ts', import.meta.url);
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_QUEUE = 64;
const DEFAULT_RECYCLE_AFTER = 500;
const HEAP_LIMIT_MB = 256;
const STARTUP_FAILURES_BEFORE_GIVING_UP = 3;

export interface CheckerOptions {
  catalog: Catalog;
  poolSize?: number;
  timeoutMs?: number;
  maxQueue?: number;
  /** Replace a worker after this many jobs (default 500). */
  recycleAfter?: number;
}

type Priority = NonNullable<CheckOptions['priority']>;

interface Job {
  id: number;
  input: CheckSectionInput;
  priority: Priority;
  timeoutMs: number;
  /** Part the worker reported working on (for timeout attribution). */
  part: string | null;
  settled: boolean;
  resolve(result: SectionCheck): void;
  reject(reason: unknown): void;
  detach(): void;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  jobs: number;
  retired: boolean;
  crash: Error | null;
}

const emptyPart = (id: string): PartCheck => ({
  id,
  ok: false,
  errors: [],
  warnings: [],
  analysis: null,
  timings: { validateMs: 0, evaluateMs: 0, analyzeMs: 0 },
  digest: null,
  instrument: '',
});

/** A whole-job failure: the section issue, repeated on the part it concerns when known. */
function failed(input: CheckSectionInput, issue: Issue, partId: string | null = null): SectionCheck {
  return {
    ok: false,
    errors: [issue],
    warnings: [],
    parts: input.parts.map((p) => (p.id === partId ? { ...emptyPart(p.id), errors: [{ ...issue, path: p.id }] } : emptyPart(p.id))),
    mix: null,
    fingerprint: null,
  };
}

const abortReason = (signal: AbortSignal) => signal.reason ?? new DOMException('The check was aborted', 'AbortError');

export function createChecker(opts: CheckerOptions): Checker {
  const poolSize = Math.max(1, opts.poolSize ?? Math.max(2, availableParallelism() - 1));
  const defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const recycleAfter = opts.recycleAfter ?? DEFAULT_RECYCLE_AFTER;
  const slots: Slot[] = [];
  const queues: Record<Priority, Job[]> = { commit: [], audition: [] };
  let closed = false;
  let seq = 0;
  let startupFailures = 0;
  let respawnTimer: ReturnType<typeof setTimeout> | null = null;

  function spawn(): void {
    const worker = new Worker(WORKER_URL, {
      workerData: { catalog: opts.catalog },
      resourceLimits: { maxOldGenerationSizeMb: HEAP_LIMIT_MB },
      env: {}, // no secrets (API keys, admin token) inside the sandbox
    });
    const slot: Slot = { worker, ready: false, job: null, timer: null, jobs: 0, retired: false, crash: null };
    worker.unref(); // an idle pool never keeps the process alive; busy workers are ref'd
    worker.on('message', (m: WorkerResponse) => onMessage(slot, m));
    worker.on('error', (e) => {
      slot.crash = e;
    });
    worker.on('exit', () => onExit(slot));
    slots.push(slot);
  }

  function fill(): void {
    while (!closed && slots.length < poolSize) spawn();
  }

  function onMessage(slot: Slot, m: WorkerResponse): void {
    switch (m.type) {
      case 'ready':
        slot.ready = true;
        startupFailures = 0;
        return dispatch();
      case 'progress':
        if (slot.job?.id === m.id) slot.job.part = m.part;
        return;
      case 'result':
        return finish(slot, m.id, m.result);
      case 'failure': {
        const job = slot.job;
        if (job?.id === m.id) finish(slot, m.id, failed(job.input, { severity: 'error', rule: 'internal', message: `The checker failed: ${m.message.split('\n')[0]}` }));
        return;
      }
    }
  }

  function finish(slot: Slot, id: number, result: SectionCheck): void {
    const job = slot.job;
    if (!job || job.id !== id) return;
    release(slot);
    slot.jobs++;
    settle(job, result);
    if (slot.jobs >= recycleAfter) {
      retire(slot);
      fill();
    }
    dispatch();
  }

  function release(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
  }

  function retire(slot: Slot): void {
    slot.retired = true;
    if (slot.timer) clearTimeout(slot.timer);
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    void slot.worker.terminate();
  }

  function onExit(slot: Slot): void {
    if (slot.retired) return;
    const job = slot.job;
    retire(slot);
    if (job) {
      const oom = /memory/i.test(String(slot.crash?.message)) || (slot.crash as NodeJS.ErrnoException | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      settle(job, failed(job.input, oom
        ? { severity: 'error', rule: 'resource', message: `Checking ran out of memory${job.part ? ` in part "${job.part}"` : ''}.`, hint: 'The pattern is too dense or too deeply layered; simplify it.' }
        : { severity: 'error', rule: 'internal', message: `The checker crashed: ${slot.crash?.message ?? 'worker exited'}` }, job.part));
    }
    if (!slot.ready) startupFailures++;
    if (closed) return;
    if (startupFailures >= STARTUP_FAILURES_BEFORE_GIVING_UP) {
      // The toolkit can't even load: fail queued work instead of letting callers hang.
      const why = slot.crash?.message ?? 'worker exited during startup';
      for (const p of ['commit', 'audition'] as const) {
        for (const j of queues[p].splice(0)) settle(j, failed(j.input, { severity: 'error', rule: 'internal', message: `The checker cannot start: ${why}` }));
      }
      respawnTimer ??= setTimeout(() => {
        respawnTimer = null;
        fill();
      }, Math.min(10_000, 250 * 2 ** startupFailures)).unref();
      return;
    }
    fill();
    dispatch();
  }

  function next(): Job | undefined {
    for (const p of ['commit', 'audition'] as const) {
      const job = queues[p].shift();
      if (job) return job;
    }
    return undefined;
  }

  function dispatch(): void {
    if (closed) return;
    for (const slot of slots) {
      if (!slot.ready || slot.job || slot.retired) continue;
      const job = next();
      if (!job) return;
      run(slot, job);
    }
  }

  function run(slot: Slot, job: Job): void {
    slot.job = job;
    slot.worker.ref();
    slot.timer = setTimeout(() => {
      if (slot.job !== job) return;
      slot.job = null;
      retire(slot);
      settle(job, failed(job.input, {
        severity: 'error',
        rule: 'timeout',
        message: `Checking took longer than ${job.timeoutMs} ms${job.part ? ` (while working on part "${job.part}")` : ''}.`,
        hint: 'The pattern is too heavy to evaluate: reduce density, layering (jux/off/superimpose) or nesting.',
      }, job.part));
      fill();
      dispatch();
    }, job.timeoutMs);
    const request: WorkerRequest = { type: 'check', id: job.id, input: job.input };
    slot.worker.postMessage(request);
  }

  function settle(job: Job, result: SectionCheck): void {
    if (job.settled) return;
    job.settled = true;
    job.detach();
    job.resolve(result);
  }

  function checkSection(input: CheckSectionInput, options: CheckOptions = {}): Promise<SectionCheck> {
    if (closed) return Promise.reject(new Error('The checker is closed.'));
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    const priority: Priority = options.priority ?? 'commit';
    const queued = queues.commit.length + queues.audition.length;
    if (queued >= maxQueue) {
      const victim = priority === 'commit' ? queues.audition.pop() : undefined;
      if (!victim) {
        return Promise.resolve(failed(input, { severity: 'error', rule: 'busy', message: `The checker is busy (${queued} checks waiting); try again shortly.` }));
      }
      settle(victim, failed(victim.input, { severity: 'error', rule: 'busy', message: 'This audition was dropped to make room for a commit; try again shortly.' }));
    }
    return new Promise<SectionCheck>((resolve, reject) => {
      const onAbort = () => {
        if (job.settled) return;
        job.settled = true;
        for (const q of Object.values(queues)) {
          const i = q.indexOf(job);
          if (i >= 0) q.splice(i, 1);
        }
        job.detach();
        reject(abortReason(signal!));
      };
      const job: Job = {
        id: ++seq,
        input,
        priority,
        timeoutMs: options.timeoutMs ?? defaultTimeout,
        part: null,
        settled: false,
        resolve,
        reject,
        detach: () => signal?.removeEventListener('abort', onAbort),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      queues[priority].push(job);
      dispatch();
    });
  }

  fill();

  return {
    checkSection,
    async audition(input, options = {}) {
      const check = await checkSection(auditionToSection(input), { ...options, priority: options.priority ?? 'audition' });
      return sectionToAudition(input, check);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      const error = new Error('The checker is closed.');
      for (const p of ['commit', 'audition'] as const) {
        for (const job of queues[p].splice(0)) {
          job.settled = true;
          job.detach();
          job.reject(error);
        }
      }
      await Promise.all(
        [...slots].map((slot) => {
          const job = slot.job;
          if (job && !job.settled) {
            job.settled = true;
            job.detach();
            job.reject(error);
          }
          slot.retired = true;
          if (slot.timer) clearTimeout(slot.timer);
          return slot.worker.terminate();
        }),
      );
      slots.length = 0;
    },
  };
}
