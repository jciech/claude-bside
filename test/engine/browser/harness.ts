// Browser harness for the engine (driven by run.ts). Boots the real engine with the fixture catalog
// and a snapshot whose cycle 0 sits at server time `t0` (passed to __boot); the "server clock" is
// this machine's performance.timeOrigin + performance.now(), shared by every page, standing in for
// ClockSync.
import { createEngine, engineInternals } from '../../../src/client/engine/engine.ts';
import type { ClockSync, EngineSnapshot, PartError } from '../../../src/client/engine/types.ts';
import type { RoomSnapshot } from '../../../src/shared/protocol.ts';
import type { SectionProgram } from '../../../src/shared/program.ts';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'main';
const serverNow = () => performance.timeOrigin + performance.now();

// join mode: the clock syncs 800 ms after boot; before that it only knows performance.now().
let synced = mode !== 'join';
const ready = synced ? Promise.resolve() : new Promise<void>((r) => setTimeout(() => ((synced = true), r()), 800));
const clock: ClockSync = {
  serverNow: () => (synced ? serverNow() : performance.now()),
  offsetMs: () => (synced ? performance.timeOrigin : 0),
  rttMs: () => 0,
  jitterMs: () => 0,
  ready,
  onStep: () => () => {},
  resync() {},
  stop() {},
};

interface Output {
  key: string;
  onset: number;
  dur: number;
  at: number;
  value: Record<string, unknown>;
}

const R = {
  mode,
  ready: false,
  unlocked: false,
  unlockedAt: 0,
  latency: null as unknown,
  outputs: [] as Output[],
  hapEvents: 0,
  sampleEvent: null as unknown,
  errors: [] as PartError[],
  states: [] as string[],
  sectionStarts: [] as { id: string; now: number }[],
  gains: [] as { now: number; g: Record<number, number | null> }[],
  /** sync mode: onsets as polled wall-clock times (quantized by the device's render bursts)… */
  onsets: [] as number[],
  /** …and sample-accurate: position in the analyser buffer, mapped through getOutputTimestamp(). */
  heard: [] as number[],
  maxRms: 0,
  health: [] as unknown[],
  preload: [] as unknown[],
  failures: [] as string[],
  cps: 0,
  meters: null as unknown,
  active: null as unknown,
  query: null as unknown,
  telemetry: null as unknown,
  needsGesture: 0,
  /** features mode: per-sample channel levels, master centroid and filter params by rendered cycle. */
  trace: [] as { c: number; lv: Record<number, number>; centroid: number; rms: number; f3: number[]; f5: number[] }[],
};
(window as unknown as { __harness: typeof R }).__harness = R;
window.addEventListener('error', (e) => R.failures.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => R.failures.push(`unhandled: ${String((e.reason as Error)?.message ?? e.reason)}`));

function section(id: string, parts: SectionProgram['parts'], overrides: Partial<SectionProgram> = {}): SectionProgram {
  return {
    id,
    rev: 1,
    index: 1,
    track: 1,
    movementId: 'm',
    name: id,
    role: 'groove',
    startCycle: 0,
    bars: 64,
    jumps: [],
    vamp: { allowed: true, loopBars: 8 },
    provisional: false,
    tempo: { fromBpm: 120, toBpm: 120, rampBars: 0, rampAt: 'start' },
    scale: 'C:major',
    chords: null,
    transitionIn: { type: 'cut', bars: 0 },
    targets: { intensity: { start: 0.5, end: 0.5 }, brightness: { start: 0.5, end: 0.5 }, density: { start: 0.5, end: 0.5 }, tension: { start: 0.5, end: 0.5 } },
    measured: { intensity: { start: 0.5, end: 0.5 }, brightness: { start: 0.5, end: 0.5 }, density: { start: 0.5, end: 0.5 }, tension: { start: 0.5, end: 0.5 } },
    parts,
    publicNote: '',
    author: 'scripted',
    ...overrides,
  };
}

function part(id: string, orbit: number, code: string, role: SectionProgram['parts'][number]['role']): SectionProgram['parts'][number] {
  return { id, role, code, orbit, level: 0.8, trimDb: 0, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null, originCycle: 0, continues: false, carried: false, chromatic: false, instrument: id, digest: null };
}

async function snapshotFor(t0: number): Promise<EngineSnapshot> {
  const timeline = { segments: [{ startMs: t0, startCycle: 0, cps: 0.5 }] };
  const mixer = { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 0, intensity: 0 } }, safety: null };
  if (mode === 'sync') {
    return { epoch: 'sync', rev: 1, timeline, mixer, sections: [section('sync-1', [part('blip', 1, 'note("c5*4").s("square").decay(0.04).sustain(0).gain(0.8)', 'lead')])] };
  }
  if (mode === 'features') {
    const kick = { ...part('kick', 1, 's("sbd*4").decay(0.2)', 'kick'), duck: { orbits: [2], depth: 0.9, releaseSec: 0.2 } };
    const pad = part('pad', 2, 'note("[c3,e3,g3]").s("sawtooth").lpf(1500).release(0.05).gain(0.5)', 'pad');
    const s1 = section('f-1', [kick, pad], { startCycle: 0, bars: 8, vamp: { allowed: false, loopBars: 4 } });
    const s2 = section('f-2', [part('pad2', 3, 'note("[a2,c3,e3]").s("sawtooth").lpf(2000).release(0.05).gain(0.5)', 'pad'), part('kick2', 4, 's("sbd*2").decay(0.2)', 'kick')], {
      startCycle: 8,
      bars: 8,
      vamp: { allowed: false, loopBars: 4 },
      transitionIn: { type: 'riser', bars: 2 },
    });
    const s3 = section('f-3', [part('chord', 5, 'note("[f2,a2,c3]").s("square").release(0.05).gain(0.3)', 'chords'), part('kick3', 6, 's("sbd*4").decay(0.2)', 'kick')], {
      startCycle: 14,
      bars: 16,
      transitionIn: { type: 'filter', bars: 2 },
    });
    return { epoch: 'features', rev: 1, timeline, mixer, sections: [s1, s2, s3] };
  }
  if (mode === 'samples') {
    const parts = [
      part('kick', 1, 's("bd*2").n("<0 3>")', 'kick'),
      part('keys', 2, 'note("<c4 e4 g4>").s("gm_epiano1").gain(0.6)', 'chords'),
      part('hats', 3, 's("hh*4").bank("tr909").gain(0.4)', 'hats'),
      part('wave', 4, 'note("<c3 g2>").s("wt_digital").gain(0.3)', 'pad'),
    ];
    return { epoch: 'samples', rev: 1, timeline, mixer, sections: [section('s-1', parts)] };
  }
  if (mode === 'bomb') {
    const bomb = 's("white*16").fast(16).superimpose(x => x.late(0.001)).superimpose(x => x.late(0.002)).gain(0.05)';
    return { epoch: 'bomb', rev: 1, timeline, mixer, sections: [section('bomb-1', [part('kick', 1, 's("sbd*4").decay(0.3)', 'kick'), part('bomb', 2, bomb, 'texture')])] };
  }
  const room = (await (await fetch('/fixtures/snapshot.json')).json()) as RoomSnapshot;
  return { epoch: room.epoch, rev: room.rev, timeline, mixer: room.mixer, sections: room.sections };
}

const engine = createEngine({ catalogUrl: '/fixtures/catalog.small.json', clock });
const internals = engineInternals(engine)!;
engine.on('state', (s) => R.states.push(s));
engine.on('partError', (e) => R.errors.push(e));
engine.on('sectionStart', (id) => R.sectionStarts.push({ id, now: engine.now() }));
engine.on('health', (h) => R.health.push(h));
engine.on('preload', (id, status) => R.preload.push({ id, ...status }));
engine.on('needsGesture', () => R.needsGesture++);
engine.on('hap', (e) => {
  R.hapEvents++;
  R.sampleEvent ??= e;
});
internals.onOutput((hap, at, dur) => {
  const { value } = hap;
  R.outputs.push({ key: hap.inst.key, onset: hap.onset, dur, at, value: { s: value.s, note: value.note, cutoff: value.cutoff, orbit: value.orbit, gain: value.gain, release: value.release } });
});

let currentTimeline: EngineSnapshot['timeline'] | null = null;

(window as unknown as { __boot: (t0: number) => Promise<void> }).__boot = async (t0: number) => {
  const snapshot = await snapshotFor(t0);
  currentTimeline = snapshot.timeline;
  engine.applySnapshot(snapshot);
  await engine.prepare();
  R.ready = true;
};

document.getElementById('unlock')!.addEventListener('click', () => {
  void engine.unlock().then(() => {
    R.unlocked = true;
    R.unlockedAt = serverNow();
    R.cps = engine.cps();
    const ac = engine.analyser()!.context as AudioContext;
    R.latency = { base: ac.baseLatency, output: ac.outputLatency, sampleRate: ac.sampleRate };
    void monitor();
  });
});

let monitoring = false;
let lastHeardCtx = 0;
let full: Float32Array<ArrayBuffer> | null = null;

/** Finds rising edges inside the whole analyser window and maps their context time to heard server ms. */
function detectHeard(analyser: AnalyserNode): void {
  const ac = analyser.context as AudioContext;
  full ??= new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
  analyser.getFloatTimeDomainData(full);
  const end = ac.currentTime;
  const ts = ac.getOutputTimestamp();
  const perf = performance.now();
  if (!ts.contextTime || !ts.performanceTime || Math.abs(perf - ts.performanceTime) > 100) return;
  // An onset is the first non-silent sample after ≥ 64 silent ones, confirmed loud soon after.
  let quiet = 0;
  let candidate = -1;
  for (let i = 0; i < full.length; i++) {
    const x = Math.abs(full[i]!);
    if (x < 0.002) {
      quiet++;
      continue;
    }
    if (quiet >= 64) candidate = i;
    quiet = 0;
    if (candidate >= 0 && x > 0.05 && i - candidate < 256) {
      const ctx = end - (full.length - candidate) / ac.sampleRate;
      candidate = -1;
      if (ctx > lastHeardCtx + 0.2) {
        lastHeardCtx = ctx;
        R.heard.push(ctx * 1000 + (ts.performanceTime - ts.contextTime * 1000) + (serverNow() - perf));
      }
    }
  }
}

async function monitor(): Promise<void> {
  if (monitoring) return;
  monitoring = true;
  const analyser = engine.analyser()!;
  const buf = new Float32Array(256);
  const freq = new Float32Array(analyser.frequencyBinCount);
  const binHz = analyser.context.sampleRate / analyser.fftSize;
  let loud = false;
  let lastGain = 0;
  let lastTrace = 0;
  for (;;) {
    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    let sum = 0;
    for (const x of buf) {
      peak = Math.max(peak, Math.abs(x));
      sum += x * x;
    }
    R.maxRms = Math.max(R.maxRms, Math.sqrt(sum / buf.length));
    if (mode === 'sync') {
      if (!loud && peak > 0.05) R.onsets.push(serverNow());
      loud = peak > 0.02;
      detectHeard(analyser);
    }
    const t = performance.now();
    const c = internals.renderedCycle();
    if (mode === 'features' && c !== null && t - lastTrace >= 4) {
      lastTrace = t;
      analyser.getFloatFrequencyData(freq);
      let num = 0;
      let den = 0;
      for (let i = 1; i < freq.length; i++) {
        const m = 10 ** (freq[i]! / 20);
        num += m * i * binHz;
        den += m;
      }
      const f = (o: number) => {
        const ch = internals.channel(o);
        return ch ? [Math.round(ch.lowpass), Math.round(ch.highpass)] : [];
      };
      R.trace.push({ c, lv: Object.fromEntries(internals.levels()), centroid: den > 0 ? num / den : 0, rms: Math.sqrt(sum / buf.length), f3: f(3), f5: f(5) });
    }
    if (t - lastGain >= 50) {
      lastGain = t;
      R.gains.push({ now: engine.now(), g: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((o) => [o, internals.channel(o)?.gain ?? null])) });
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

const hooks = window as unknown as Record<string, (...a: unknown[]) => unknown>;
/** An OS interruption (iOS call, lock): the context suspends behind the engine's back. */
hooks.__interrupt = () => (engine.analyser()!.context as AudioContext).suspend();
/** A schedule change reaching cycles already handed to superdough. */
hooks.__late = () => {
  const s3 = engine.sections().find((s) => s.id === 'f-3')!;
  const chord = { ...s3.parts[0]!, code: 'note("[g2,b2,d3]").s("square").release(0.05).gain(0.3)' };
  engine.applySchedule({ epoch: 'features', rev: 2, timeline: currentTimeline!, upserts: [{ ...s3, rev: 2, parts: [chord, s3.parts[1]!] }], revokes: [] });
};
/** Stay: the playing section is re-issued with a jump well ahead — not a late change. */
hooks.__stay = () => {
  const s3 = engine.sections().find((s) => s.id === 'f-3')!;
  engine.applySchedule({ epoch: 'features', rev: 3, timeline: currentTimeline!, upserts: [{ ...s3, rev: 3, jumps: [{ atBar: 12, toBar: 8 }] }], revokes: [] });
};
/** The listener pauses and immediately resumes. */
hooks.__suspend = () => engine.suspend();
hooks.__mute = (partId: unknown, muted: unknown) => engine.setLocalMute(partId as string, muted as boolean);
hooks.__channel = (orbit: unknown) => internals.channel(orbit as number);
hooks.__brighten = (atCycle: unknown) =>
  engine.setMixer({
    rev: 2,
    prev: { atCycle: 0, rampBars: 1, macros: { brightness: 0, intensity: 0 } },
    next: { atCycle: atCycle as number, rampBars: 1, macros: { brightness: 1, intensity: 0 } },
    safety: null,
  });
hooks.__acState = () => (engine.analyser()?.context as AudioContext | undefined)?.state ?? 'none';
/** A server restart: a new epoch replaces everything; old material fades over a bar. */
hooks.__epoch = (startCycle: unknown) => {
  const hats = part('hats', 1, 's("white*8").decay(0.03).gain(0.3)', 'hats');
  engine.applySnapshot({
    epoch: 'features-2',
    rev: 1,
    timeline: currentTimeline!,
    mixer: { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 0, intensity: 0 } }, safety: null },
    sections: [section('g-1', [hats], { startCycle: startCycle as number })],
  });
};

/** Snapshot of what the UI would read, taken on demand by the runner. */
(window as unknown as { __snapshot: () => void }).__snapshot = () => {
  R.meters = engine.meters();
  R.active = Object.fromEntries(engine.activeLocations());
  const now = engine.now();
  R.query = engine.query(now, now + 1).map((e) => ({ instance: e.instance, cycle: e.cycle, gain: e.gain }));
  R.telemetry = engine.telemetry();
};
