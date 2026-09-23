// NTP-style server clock over the websocket (ARCHITECTURE §4 "Client sync", ClockSync in types.ts):
// probes keep the best third (lowest RTT) of up to 16 recent samples with RTT ≤ 500 ms; ready after
// ≥ 5 good samples. Corrections ≤ 50 ms are slewed at ≤ 5 ms/s; larger ones are steps reported to
// listeners (the scheduler skips forward or holds backward). Re-bursts on resync(), page lifecycle
// events and detected sleep (Date.now() − performance.now() jumping).
import type { ClockSync } from './types.ts';
import { backgroundTimers, type Timers } from './timers.ts';

export const MIN_GOOD_SAMPLES = 5;
export const MAX_SAMPLES = 16;
export const MAX_RTT_MS = 500;
export const SLEW_LIMIT_MS = 50;
export const SLEW_RATE = 5 / 1000;
const SAMPLE_MAX_AGE_MS = 180_000;
const PROBE_TIMEOUT_MS = 2500;
const PROBE_GAP_MS = 60;
const INITIAL_BURST = 10;
const RESYNC_BURST = 8;
const MAINTENANCE_BURST = 4;
const MAINTENANCE_MS = 30_000;
const SLEEP_CHECK_MS = 2000;
const SLEEP_JUMP_MS = 1000;

export interface ClockSyncEnv {
  perfNow(): number;
  wallNow(): number;
  timers: Timers;
  /** Calls `listener` on page events that warrant a re-burst; returns an unsubscribe function. */
  lifecycle?(listener: () => void): () => void;
}

interface Sample {
  offset: number;
  rtt: number;
  at: number;
}

/** Best-third estimate over the good samples (newer first on equal RTT); null until there are enough. */
export function estimateOffset(samples: readonly Sample[]): { offset: number; rtt: number; jitter: number } | null {
  if (samples.length < MIN_GOOD_SAMPLES) return null;
  const byRtt = [...samples].sort((a, b) => a.rtt - b.rtt || b.at - a.at);
  const best = byRtt.slice(0, Math.max(2, Math.ceil(samples.length / 3)));
  const offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
  const rtt = best.reduce((s, x) => s + x.rtt, 0) / best.length;
  const mean = samples.reduce((s, x) => s + x.offset, 0) / samples.length;
  const jitter = Math.sqrt(samples.reduce((s, x) => s + (x.offset - mean) ** 2, 0) / samples.length);
  return { offset, rtt, jitter };
}

export function createClockSync(probe: () => Promise<number>, env: ClockSyncEnv): ClockSync {
  const { timers } = env;
  let samples: Sample[] = [];
  let stopped = false;
  let bursting = false;
  let pending = 0;
  let resolveReady!: () => void;
  const ready = new Promise<void>((r) => (resolveReady = r));
  let isReady = false;
  let rtt = 0;
  let jitter = 0;
  // Offset slews from `base` (at perf time `baseAt`) toward `target` at SLEW_RATE.
  let base: number | null = null;
  let baseAt = 0;
  let target = 0;
  const stepListeners = new Set<(deltaMs: number) => void>();

  const offsetAt = (t: number): number => {
    if (base === null) return 0;
    const gap = target - base;
    const moved = Math.min(Math.abs(gap), Math.max(0, t - baseAt) * SLEW_RATE);
    return base + Math.sign(gap) * moved;
  };

  const apply = (next: number) => {
    const now = env.perfNow();
    if (base === null) {
      base = target = next;
      baseAt = now;
      return;
    }
    const current = offsetAt(now);
    const delta = next - current;
    if (Math.abs(delta) <= SLEW_LIMIT_MS) {
      base = current;
      baseAt = now;
      target = next;
      return;
    }
    base = target = next;
    baseAt = now;
    for (const l of stepListeners) l(delta);
  };

  const once = async (): Promise<void> => {
    const t0 = env.perfNow();
    let serverMs: number;
    try {
      serverMs = await withTimeout(probe(), PROBE_TIMEOUT_MS, timers);
    } catch {
      return;
    }
    const t1 = env.perfNow();
    const sampleRtt = t1 - t0;
    if (!Number.isFinite(serverMs) || sampleRtt < 0 || sampleRtt > MAX_RTT_MS) return;
    const sample = { offset: serverMs - (t0 + t1) / 2, rtt: sampleRtt, at: t1 };
    // The true offset lies within ±rtt/2 of every sample; older samples that can't agree with this
    // one predate a real clock change (server restart, stepped clock) and would drag the estimate back.
    samples = samples.filter((s) => t1 - s.at <= SAMPLE_MAX_AGE_MS && Math.abs(s.offset - sample.offset) <= (s.rtt + sample.rtt) / 2 + 1);
    samples.push(sample);
    samples = samples.slice(-MAX_SAMPLES);
    const est = estimateOffset(samples);
    if (!est) return;
    rtt = est.rtt;
    jitter = est.jitter;
    apply(est.offset);
    if (!isReady) {
      isReady = true;
      resolveReady();
    }
  };

  const burst = (count: number) => {
    pending = Math.max(pending, count);
    if (bursting || stopped) return;
    bursting = true;
    void (async () => {
      while (pending > 0 && !stopped) {
        pending--;
        await once();
        // Keep probing past the burst until the clock is usable.
        if (pending === 0 && !isReady && !stopped) pending = 1;
        if (pending > 0) await delay(PROBE_GAP_MS, timers);
      }
      bursting = false;
    })();
  };

  let lastDrift = env.wallNow() - env.perfNow();
  const sleepCheck = timers.setInterval(() => {
    const drift = env.wallNow() - env.perfNow();
    if (Math.abs(drift - lastDrift) > SLEEP_JUMP_MS) {
      // The monotonic clock paused (sleep) or the wall clock stepped: old samples are meaningless.
      samples = [];
      burst(RESYNC_BURST);
    }
    lastDrift = drift;
  }, SLEEP_CHECK_MS);
  const maintenance = timers.setInterval(() => burst(MAINTENANCE_BURST), MAINTENANCE_MS);
  const unsubscribe = env.lifecycle?.(() => burst(RESYNC_BURST)) ?? (() => {});
  burst(INITIAL_BURST);

  return {
    serverNow: () => {
      const t = env.perfNow();
      return t + offsetAt(t);
    },
    offsetMs: () => offsetAt(env.perfNow()),
    rttMs: () => rtt,
    jitterMs: () => jitter,
    ready,
    onStep(listener) {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },
    resync: () => burst(RESYNC_BURST),
    stop() {
      stopped = true;
      timers.clearInterval(sleepCheck);
      timers.clearInterval(maintenance);
      unsubscribe();
      stepListeners.clear();
    },
  };
}

function delay(ms: number, timers: Timers): Promise<void> {
  return new Promise((resolve) => timers.setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, timers: Timers): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = timers.setTimeout(() => reject(new Error('clock probe timed out')), ms);
    promise.then(
      (v) => {
        timers.clearTimeout(id);
        resolve(v);
      },
      (e) => {
        timers.clearTimeout(id);
        reject(e);
      },
    );
  });
}

function browserLifecycle(listener: () => void): () => void {
  const onVisible = () => {
    if (document.visibilityState === 'visible') listener();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pageshow', listener);
  window.addEventListener('online', listener);
  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', listener);
    window.removeEventListener('online', listener);
  };
}

/** The room connection passes `() => socket.timeout(2000).emitWithAck('clock')`. */
export function startClockSync(probe: () => Promise<number>): ClockSync {
  return createClockSync(probe, {
    perfNow: () => performance.now(),
    wallNow: () => Date.now(),
    timers: backgroundTimers(),
    lifecycle: typeof document !== 'undefined' ? browserLifecycle : undefined,
  });
}
