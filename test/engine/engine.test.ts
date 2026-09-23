// The engine end to end in Node: the real engine, scheduler, performer, channels and master chain
// on fake Web Audio nodes and fake timers; superdough, sound registration and preloading stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClockSync, EngineSnapshot, PartError, VisualEvent } from '../../src/client/engine/types.ts';
import { EMPTY_MIXER, type MixerState, type SectionProgram } from '../../src/shared/program.ts';
import { createTimeline } from '../../src/shared/timeline.ts';
import { FakeAudioContext, FakeBiquadFilterNode, fakeSuperdoughController, stubAudioGlobals, type FakeGainNode } from './fake-audio.ts';
import { part, section } from './fixtures.ts';

const env = vi.hoisted(() => ({
  ac: null as unknown as { resume(): Promise<void> },
  controller: null as unknown,
  /** Preloads by sound name; resolves true when loaded. */
  load: (_key: string): Promise<boolean> => Promise.resolve(true),
  handed: [] as { value: Record<string, unknown>; t: number }[],
}));

vi.mock('../../src/client/engine/boot.ts', () => ({
  audioContext: () => env.ac,
  initAudioGraph: () => Promise.resolve(),
  resumeInGesture: () => env.ac.resume(),
  bindStrudelTime: () => {},
}));
vi.mock('@strudel/webaudio', () => ({
  getSuperdoughAudioController: () => env.controller,
  // Like superdough 1.3.0 before its first await: it writes the bank into `s` and adds `duration`.
  superdough: (value: Record<string, unknown>, t: number, duration: number) => {
    if (typeof value.bank === 'string' && typeof value.s === 'string') value.s = `${value.bank}_${value.s}`;
    value.duration = duration;
    env.handed.push({ value, t });
    return Promise.resolve();
  },
}));
vi.mock('superdough', () => ({ getSuperdoughAudioController: () => env.controller }));
vi.mock('../../src/client/engine/sounds.ts', () => ({
  loadCatalog: () => Promise.resolve({ soundfontBase: '' }),
  registerSounds: () => Promise.resolve([]),
}));
vi.mock('../../src/client/engine/preload.ts', () => ({
  resolveAsset: (value: Record<string, unknown>) => ({ kind: 'asset', asset: { key: String(value.s), kind: 'sample', label: String(value.s), url: '', value } }),
  Preloader: class {
    load(asset: { key: string }): Promise<boolean> {
      return env.load(asset.key);
    }
    progress() {
      return { loaded: 0, total: 0 };
    }
  },
}));

const { createEngine, engineInternals } = await import('../../src/client/engine/engine.ts');

const OFFSET_MS = 5_000_000;
const BAR_MS = 2000;
const serverNow = () => performance.now() + OFFSET_MS;
const clock: ClockSync = {
  serverNow,
  offsetMs: () => OFFSET_MS,
  rttMs: () => 20,
  jitterMs: () => 1,
  ready: Promise.resolve(),
  onStep: () => () => {},
  resync: () => {},
  stop: () => {},
};
/** 120 BPM, at `cycle` right now. */
const timelineAt = (cycle: number) => createTimeline(serverNow() - cycle * BAR_MS, 0.5, 0);
const snapshot = (epoch: string, cycle: number, sections: SectionProgram[], mixer: MixerState = EMPTY_MIXER, rev = 1): EngineSnapshot => ({
  epoch,
  rev,
  timeline: timelineAt(cycle),
  sections,
  mixer,
});
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const kick = (over: Partial<SectionProgram['parts'][number]> = {}) => part({ id: 'kick', role: 'kick', code: 's("bd*4")', orbit: 1, ...over });
const hats = part({ id: 'hats', role: 'hats', code: 's("hh*8")', orbit: 2 });

function fakeAudio(): FakeAudioContext {
  return env.ac as unknown as FakeAudioContext;
}

/** The mute gain of an orbit's engine channel: orbit output → low-pass → high-pass → gain → mute. */
function muteOf(orbit: number) {
  const controller = env.controller as ReturnType<typeof fakeSuperdoughController>;
  const gain = controller.getOrbit(orbit).output.outputs[0]!.outputs[0]!.outputs[0] as FakeGainNode;
  return (gain.outputs[0] as FakeGainNode).gain;
}

function settled(p: Promise<void>): () => boolean {
  let done = false;
  void p.then(() => (done = true));
  return () => done;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  stubAudioGlobals();
  const ac = new FakeAudioContext();
  env.ac = ac;
  env.controller = fakeSuperdoughController(() => ac);
  env.load = () => Promise.resolve(true);
  env.handed = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('unlock', () => {
  // A plays now (bar 4); B takes over at bar 5 and its sounds never finish loading, so the start
  // waits up to two bars for them.
  function waitingRoom() {
    env.load = (key) => (key === 'hh' ? new Promise(() => {}) : Promise.resolve(true));
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    engine.applySnapshot(snapshot('e', 4, [section({ id: 'e-1', startCycle: 0, parts: [kick()] }), section({ id: 'e-2', startCycle: 5, parts: [hats] })]));
    return engine;
  }
  const running = (engine: ReturnType<typeof createEngine>) => engine.state === 'running' && engineInternals(engine)!.renderedCycle() !== null;

  it('starts after a pause during the start wait (Media Session pause, then play)', async () => {
    const engine = waitingRoom();
    const first = settled(engine.unlock());
    await advance(300);
    expect(engine.state).toBe('unlocking');
    engine.suspend();
    await advance(400);
    expect(engine.state).toBe('suspended');
    expect(first()).toBe(true);
    const second = settled(engine.unlock());
    await advance(10_000);
    expect(second()).toBe(true);
    expect(running(engine)).toBe(true);
  });

  it('starts after an interruption during the start wait (iOS call, lock screen)', async () => {
    const engine = waitingRoom();
    let gestures = 0;
    engine.on('needsGesture', () => gestures++);
    const first = settled(engine.unlock());
    await advance(300);
    fakeAudio().interrupt();
    expect(engine.state).toBe('suspended');
    expect(gestures).toBe(1);
    await advance(400);
    expect(first()).toBe(true);
    const second = settled(engine.unlock());
    await advance(10_000);
    expect(second()).toBe(true);
    expect(running(engine)).toBe(true);
  });

  it('stays suspended (and keeps asking for a gesture) when interrupted while still preparing', async () => {
    env.load = (key) => new Promise((resolve) => setTimeout(() => resolve(true), key === 'bd' ? 1000 : 0));
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    engine.applySnapshot(snapshot('e', 4, [section({ id: 'e-1', startCycle: 0, parts: [kick()] })]));
    let gestures = 0;
    engine.on('needsGesture', () => gestures++);
    const first = settled(engine.unlock());
    await advance(100);
    fakeAudio().interrupt();
    await advance(5000);
    expect(first()).toBe(true);
    expect(engine.state).toBe('suspended');
    expect(engineInternals(engine)!.renderedCycle()).toBeNull();
    expect(gestures).toBe(1);
    const second = settled(engine.unlock());
    await advance(5000);
    expect(second()).toBe(true);
    expect(running(engine)).toBe(true);
  });

  it('shares one attempt between taps while it is in flight', async () => {
    const engine = waitingRoom();
    const a = engine.unlock();
    await advance(300);
    const b = engine.unlock();
    expect(b).toBe(a);
    expect(engine.state).toBe('unlocking');
    const done = settled(b);
    await advance(10_000);
    expect(done()).toBe(true);
    expect(running(engine)).toBe(true);
  });
});

describe('a new epoch', () => {
  it('re-anchors the master tilt and safety trim when the new timeline restarts at lower cycles', async () => {
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    engine.applySnapshot(snapshot('old', 5000, [section({ id: 'old-1', startCycle: 4992, parts: [kick()] })]));
    void engine.unlock();
    await advance(3000);
    expect(engine.state).toBe('running');
    const nodes = fakeAudio().nodes;
    const highShelf = nodes.find((n): n is FakeBiquadFilterNode => n instanceof FakeBiquadFilterNode && n.type === 'highshelf')!;
    expect(highShelf.gain.value).toBeCloseTo(0);
    const bright: MixerState = { rev: 1, prev: null, next: { atCycle: 0, rampBars: 1, macros: { brightness: 1, intensity: 0 }, trimsDb: {} }, safety: null };
    engine.applySnapshot(snapshot('new', 2, [section({ id: 'new-1', startCycle: 0, parts: [kick()] })], bright));
    await advance(4000);
    expect(engine.now()).toBeLessThan(10);
    // tiltDb(1): +4 dB on the high shelf.
    expect(highShelf.gain.value).toBeCloseTo(4);
  });
});

describe('the personal mix', () => {
  it("mutes a muted part's entry on a fresh orbit from its first note, and lets an unmuted part in on time", async () => {
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    const a = section({ id: 'm-1', startCycle: 0, parts: [part({ id: 'lead', code: 'note("c4*4")', orbit: 1 })] });
    // The lead is rewritten onto orbit 2; the keys come in on the orbit the (muted) lead left.
    const b = section({ id: 'm-2', startCycle: 6, parts: [part({ id: 'lead', code: 'note("e4*4")', orbit: 2 }), part({ id: 'keys', role: 'chords', code: 'note("g3*2")', orbit: 1 })] });
    engine.applySnapshot(snapshot('m', 4, [a, b]));
    engine.setLocalMute('lead', true);
    void engine.unlock();
    await advance(8000);
    const lead = env.handed.find((h) => h.value.orbit === 2)!;
    const keys = env.handed.find((h) => h.value.orbit === 1 && h.value.note === 'g3')!;
    expect(lead && keys).toBeTruthy();
    expect(muteOf(2).valueAt(lead.t)).toBeLessThan(0.001);
    expect(muteOf(1).valueAt(keys.t)).toBeGreaterThan(0.999);
  });
});

describe('visual events', () => {
  it('name the sound of a bank hap the same way whether it was triggered or queried', async () => {
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    engine.applySnapshot(snapshot('v', 4, [section({ id: 'v-1', startCycle: 0, parts: [kick({ code: 's("bd*4").bank("RolandTR909")' })] })]));
    const triggered: VisualEvent[] = [];
    engine.on('hap', (e) => triggered.push(e));
    void engine.unlock();
    await advance(3000);
    expect(triggered.length).toBeGreaterThan(0);
    expect(new Set(triggered.map((e) => e.sound))).toEqual(new Set(['rolandtr909_bd']));
    const at = triggered[0]!.cycle;
    expect(engine.query(at, at + 0.01).map((e) => e.sound)).toEqual(['rolandtr909_bd']);
  });
});

describe('a reconnect snapshot', () => {
  it('does not treat history the server pruned as a schedule change', async () => {
    const engine = createEngine({ catalogUrl: '/catalog.json', clock });
    const s0 = section({ id: 'r-1', startCycle: 0, parts: [kick()] });
    const s1 = section({ id: 'r-2', startCycle: 16, parts: [kick({ carried: true, continues: true })] });
    const s2 = section({ id: 'r-3', startCycle: 32, bars: 32, parts: [kick({ carried: true, continues: true })] });
    const welcome = snapshot('r', 36, [s0, s1, s2]);
    engine.applySnapshot(welcome);
    void engine.unlock();
    await advance(3000);
    expect(engine.state).toBe('running');
    const errors: PartError[] = [];
    engine.on('partError', (e) => errors.push(e));
    // The server keeps only the section before the current one.
    engine.applySnapshot({ ...welcome, rev: 2, sections: [s1, s2] });
    await advance(1000);
    expect(errors.filter((e) => e.code === 'late-schedule')).toEqual([]);
    expect(engine.sections().map((s) => s.id)).toEqual(['r-1', 'r-2', 'r-3']);
  });
});
