// Web Audio stand-ins for engine tests in Node: AudioParams that record their automation (and can
// evaluate it at a time), nodes that remember their connections, and a context whose clock follows
// performance.now() (fake timers drive both).
import { vi } from 'vitest';

export type ParamEvent =
  | { kind: 'set' | 'lin' | 'exp'; v: number; t: number }
  | { kind: 'target'; v: number; t: number; tau: number }
  | { kind: 'cancel' | 'hold'; t: number };

type Scheduled = Exclude<ParamEvent, { kind: 'cancel' | 'hold' }>;

export class FakeParam {
  /** Every call in order, cancels included. */
  readonly log: ParamEvent[] = [];
  /** What is still scheduled, by time. */
  private timeline: Scheduled[] = [];
  private readonly initial: number;
  private readonly now: () => number;

  constructor(initial: number, now: () => number) {
    this.initial = initial;
    this.now = now;
  }

  get value(): number {
    return this.valueAt(this.now());
  }

  set value(v: number) {
    this.timeline = [];
    this.insert({ kind: 'set', v, t: this.now() });
  }

  setValueAtTime(v: number, t: number): this {
    return this.add({ kind: 'set', v, t });
  }

  linearRampToValueAtTime(v: number, t: number): this {
    return this.add({ kind: 'lin', v, t });
  }

  exponentialRampToValueAtTime(v: number, t: number): this {
    return this.add({ kind: 'exp', v, t });
  }

  setTargetAtTime(v: number, t: number, tau: number): this {
    return this.add({ kind: 'target', v, t, tau });
  }

  cancelScheduledValues(t: number): this {
    this.log.push({ kind: 'cancel', t });
    this.timeline = this.timeline.filter((e) => e.t < t);
    return this;
  }

  cancelAndHoldAtTime(t: number): this {
    const held = this.valueAt(t);
    this.log.push({ kind: 'hold', t });
    const cut = this.timeline.find((e) => e.t > t);
    this.timeline = this.timeline.filter((e) => e.t <= t);
    // A ramp in progress ends at `t` on the value it had reached.
    this.insert(cut && (cut.kind === 'lin' || cut.kind === 'exp') ? { kind: cut.kind, v: held, t } : { kind: 'set', v: held, t });
    return this;
  }

  /** The scheduled curve at audio time `t` (Web Audio semantics, close enough for assertions). */
  valueAt(t: number): number {
    let v = this.initial;
    let at = 0;
    let target: { from: number; v: number; t: number; tau: number } | null = null;
    const current = (x: number) => (target ? target.v + (target.from - target.v) * Math.exp(-(x - target.t) / target.tau) : v);
    for (const e of this.timeline) {
      if (e.kind === 'lin' || e.kind === 'exp') {
        const from = current(at);
        if (t < e.t) {
          const k = Math.max(0, (t - at) / Math.max(1e-12, e.t - at));
          return e.kind === 'lin' ? from + (e.v - from) * k : from * (e.v / from) ** k;
        }
        v = e.v;
        at = e.t;
        target = null;
        continue;
      }
      if (e.t > t) break;
      if (e.kind === 'target') {
        target = { from: current(e.t), v: e.v, t: e.t, tau: e.tau };
      } else {
        v = e.v;
        target = null;
      }
      at = e.t;
    }
    return current(t);
  }

  private add(e: Scheduled): this {
    this.log.push(e);
    this.insert(e);
    return this;
  }

  private insert(e: Scheduled): void {
    let i = this.timeline.length;
    while (i > 0 && this.timeline[i - 1]!.t > e.t) i--;
    this.timeline.splice(i, 0, e);
  }
}

export class FakeNode {
  readonly context: FakeAudioContext;
  outputs: FakeNode[] = [];

  constructor(context: FakeAudioContext) {
    this.context = context;
    context.nodes.push(this);
  }

  connect<T extends FakeNode>(node: T): T {
    this.outputs.push(node);
    return node;
  }

  disconnect(): void {
    this.outputs = [];
  }
}

const param = (ac: FakeAudioContext, v: number) => new FakeParam(v, () => ac.currentTime);

export class FakeGainNode extends FakeNode {
  readonly gain: FakeParam;
  constructor(ac: FakeAudioContext, opts: { gain?: number } = {}) {
    super(ac);
    this.gain = param(ac, opts.gain ?? 1);
  }
}

export class FakeBiquadFilterNode extends FakeNode {
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  readonly gain: FakeParam;
  readonly type: string;
  constructor(ac: FakeAudioContext, opts: { type?: string; frequency?: number; Q?: number; gain?: number } = {}) {
    super(ac);
    this.type = opts.type ?? 'lowpass';
    this.frequency = param(ac, opts.frequency ?? 350);
    this.Q = param(ac, opts.Q ?? 1);
    this.gain = param(ac, opts.gain ?? 0);
  }
}

export class FakeAnalyserNode extends FakeNode {
  readonly fftSize: number;
  constructor(ac: FakeAudioContext, opts: { fftSize?: number } = {}) {
    super(ac);
    this.fftSize = opts.fftSize ?? 2048;
  }
  get frequencyBinCount(): number {
    return this.fftSize / 2;
  }
  getFloatTimeDomainData(buf: Float32Array): void {
    buf.fill(0);
  }
  getFloatFrequencyData(buf: Float32Array): void {
    buf.fill(-120);
  }
}

export class FakeDynamicsCompressorNode extends FakeNode {}
export class FakeWaveShaperNode extends FakeNode {}

export class FakeAudioBufferSourceNode extends FakeNode {
  onended: (() => void) | null = null;
  start(): void {}
  stop(): void {}
}

export class FakeAudioContext {
  state: AudioContextState | 'interrupted' = 'suspended';
  onstatechange: (() => void) | null = null;
  readonly sampleRate = 48000;
  readonly baseLatency = 0.01;
  outputLatency = 0.03;
  /** Every node created on this context, in order. */
  readonly nodes: FakeNode[] = [];
  readonly destination: FakeNode;
  private readonly clock: () => number;

  /** `clock`: context time in seconds (default: performance.now() since construction). */
  constructor(clock?: () => number) {
    const origin = performance.now();
    this.clock = clock ?? (() => (performance.now() - origin) / 1000);
    this.destination = new FakeNode(this);
  }

  get currentTime(): number {
    return this.clock();
  }

  async resume(): Promise<void> {
    this.setState('running');
  }

  async suspend(): Promise<void> {
    this.setState('suspended');
  }

  /** The OS takes the audio away (iOS call, lock screen). */
  interrupt(state: 'interrupted' | 'suspended' = 'interrupted'): void {
    this.setState(state);
  }

  createBuffer(channels: number, length: number): { getChannelData(): Float32Array } {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: () => data[0]! };
  }

  private setState(state: FakeAudioContext['state']): void {
    if (this.state === state) return;
    this.state = state;
    this.onstatechange?.();
  }
}

/** Installs the node constructors the engine uses as globals (undo with vi.unstubAllGlobals). */
export function stubAudioGlobals(): void {
  vi.stubGlobal('GainNode', FakeGainNode);
  vi.stubGlobal('BiquadFilterNode', FakeBiquadFilterNode);
  vi.stubGlobal('AnalyserNode', FakeAnalyserNode);
  vi.stubGlobal('DynamicsCompressorNode', FakeDynamicsCompressorNode);
  vi.stubGlobal('WaveShaperNode', FakeWaveShaperNode);
  vi.stubGlobal('AudioBufferSourceNode', FakeAudioBufferSourceNode);
}

/** superdough's audio controller as far as the engine touches it: orbits with an output node. */
export function fakeSuperdoughController(ac: () => FakeAudioContext) {
  const orbits = new Map<number, { output: FakeGainNode }>();
  let destinationGain: FakeGainNode | null = null;
  return {
    orbits,
    get output() {
      destinationGain ??= new FakeGainNode(ac());
      return { destinationGain };
    },
    getOrbit(orbit: number) {
      let bus = orbits.get(orbit);
      if (!bus) {
        bus = { output: new FakeGainNode(ac()) };
        orbits.set(orbit, bus);
      }
      return bus;
    },
  };
}
