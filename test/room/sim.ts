// A deterministic room for crowd tests: fake time, a recording broadcaster, an in-memory store,
// listeners that heartbeat every 10 s, and a bar clock (120 BPM: 1 bar = 2 s).
import type { Hello } from '../../src/shared/protocol.ts';
import type { Broadcaster, CrowdSignal, Logger, ServerConfig, Store } from '../../src/server/types.ts';
import { createCrowd, type CrowdRuntime } from '../../src/server/room/crowd.ts';
import { FakeTime } from './fake-time.ts';

export const SEC_PER_BAR = 2;

export const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    dev: true,
    dataDir: '/nonexistent',
    catalogPath: '/nonexistent/catalog.json',
    driver: 'scripted',
    model: 'claude-test',
    effort: { section: 'medium', movement: 'high' },
    maxPlansPerHour: 90,
    maxApiCallsPerPlan: 8,
    adminToken: null,
    secret: 'test-secret-for-listener-tokens',
    trustProxy: 0,
    ipv6Prefix: 48,
    maxSocketsPerNetwork: 64,
    sourceUrl: 'https://example.org/source',
    ...overrides,
  };
}

export function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    readJson: <T>(key: string) => data.get(key) as T | undefined,
    writeJson: (key, value) => void data.set(key, structuredClone(value)),
    append() {},
    readJsonl: () => [],
    flush: async () => {},
  };
}

export interface Emitted {
  to: string;
  event: string;
  args: unknown[];
}

export function recordingBroadcaster(): Broadcaster & { log: Emitted[]; last(event: string, to?: string): unknown } {
  const log: Emitted[] = [];
  return {
    log,
    emit: (event, ...args) => void log.push({ to: '*', event, args }),
    toListener: (to, event, ...args) => void log.push({ to, event, args }),
    last(event, to) {
      for (let i = log.length - 1; i >= 0; i--) if (log[i]!.event === event && (to === undefined || log[i]!.to === to)) return log[i]!.args[0];
      return undefined;
    },
  };
}

export interface SimListener {
  socketId: string;
  listenerId: string;
  token: string;
  address: string;
  audible: boolean;
  visible: boolean;
}

export class Sim {
  readonly time = new FakeTime();
  readonly broadcaster = recordingBroadcaster();
  readonly store = memoryStore();
  readonly crowd: CrowdRuntime;
  readonly listeners: SimListener[] = [];
  readonly signals: (CrowdSignal & { t: number; bar: number })[] = [];
  /** Movement baseline in descriptor space (0..1). */
  baseline = { intensity: 0.5, brightness: 0.5 };
  /** Seconds since the start of the scenario (after warm-up). */
  t = 0;
  #origin = 0;
  #seq = 0;
  #lastBar = -1;

  constructor(config: Partial<ServerConfig> = {}) {
    this.crowd = createCrowd({
      broadcaster: this.broadcaster,
      config: testConfig(config),
      store: this.store,
      log: silentLog,
      now: this.time.clock,
      timers: this.time.timers,
    });
    this.#origin = this.time.now;
  }

  get now(): number {
    return this.time.now;
  }

  get cycle(): number {
    return (this.time.now - this.#origin) / 1000 / SEC_PER_BAR;
  }

  get bar(): number {
    return Math.floor(this.cycle);
  }

  hello(anonId: string, token: string | null = null): Hello {
    return { anonId, token, clientVersion: '0.2.0' };
  }

  /** Joins `count` audible, visible listeners; by default each on its own /24. */
  join(count: number, opts: { address?: (i: number) => string; visible?: boolean } = {}): SimListener[] {
    const out: SimListener[] = [];
    for (let i = 0; i < count; i++) {
      const n = this.#seq++;
      const address = opts.address?.(n) ?? `10.${(n >> 8) & 255}.${n & 255}.7`;
      const socketId = `sock-${n}`;
      const res = this.crowd.join(socketId, this.hello(`anon-${n.toString().padStart(8, '0')}`), address, this.now);
      if (!('listenerId' in res)) throw new Error(`join failed: ${res.reason}`);
      const l: SimListener = { socketId, listenerId: res.listenerId, token: res.token, address, audible: true, visible: opts.visible ?? true };
      this.listeners.push(l);
      this.beat(l);
      out.push(l);
    }
    return out;
  }

  beat(l: SimListener): void {
    this.crowd.heartbeat(l.socketId, { audible: l.audible, visible: l.visible, heardCycle: this.cycle, syncRttMs: 20, offsetJitterMs: 1 }, this.now);
  }

  /** Lets everyone listen (heartbeating) for `ms` without doing anything else; the scenario clock restarts at 0. */
  warmUp(ms = 130_000): void {
    for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
      this.time.advance(Math.min(10_000, ms - elapsed));
      for (const l of this.listeners) this.beat(l);
    }
    this.#origin = this.time.now;
    this.#lastBar = -1;
    this.t = 0;
    this.crowd.pull();
  }

  /**
   * Runs the scenario second by second: `each(t)` first, then heartbeats (every 10 s), then time
   * moves one second, smoothing advances and each new bar is ticked.
   */
  run(seconds: number, each: (t: number) => void = () => {}, onSignal: (s: CrowdSignal) => void = () => {}): void {
    const end = this.t + seconds;
    for (; this.t <= end; this.t++) {
      each(this.t);
      if (this.t % 10 === 0) for (const l of this.listeners) this.beat(l);
      this.time.advance(250);
      this.crowd.pull();
      this.time.advance(250);
      this.crowd.pull();
      this.time.advance(250);
      this.crowd.pull();
      this.time.advance(250);
      this.crowd.pull();
      const bar = this.bar;
      if (bar !== this.#lastBar) {
        this.#lastBar = bar;
        for (const s of this.crowd.tick(bar, this.now, this.baseline)) {
          this.signals.push({ ...s, t: this.t, bar });
          onSignal(s);
        }
      }
    }
  }

  pad(l: SimListener, x: number, y: number, active = false) {
    return this.crowd.pad(l.socketId, { x, y, active }, this.now);
  }

  pull() {
    return this.crowd.pull().point;
  }

  count(type: CrowdSignal['type']): number {
    return this.signals.filter((s) => s.type === type).length;
  }
}
