// The master chain (ARCHITECTURE §6): superdough has no limiter, so every channel sums into
//   input → low shelf 150 Hz / high shelf 3 kHz (brightness tilt + safety) → master trim (safety)
//         → DynamicsCompressor (limiter settings) → soft clip (WaveShaper) → [analyser tap]
//         → fade (unlock fade-in, suspend) → user volume → destination
// with a second analyser before the limiter to measure how often the mix would clip.
import type { MixerState } from '../../shared/program.ts';
import { dbToGain, macrosAt, safetyAt, tiltDb } from './knobs.ts';
import { GRID_BARS, ParamPlanner } from './channels.ts';

const SOFT_KNEE = 0.8;
const METER_FLOOR_DB = -120;
/**
 * The chain's own delay: DynamicsCompressorNode's fixed 6 ms look-ahead (same in Blink, WebKit and
 * Gecko; measured 6.0 ms). The clipper runs without oversampling, whose latency differs per engine
 * (Chromium: 128 frames). The scheduler hands audio over this much earlier.
 */
export const MASTER_DELAY_SEC = 0.006;

/** Linear below ±0.8, then a tanh knee that never exceeds ±1 (input is pre-scaled by 1/2). */
export function softClipCurve(size = 2048): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(size * 4));
  for (let i = 0; i < size; i++) {
    const u = ((i / (size - 1)) * 2 - 1) * 2;
    const a = Math.abs(u);
    const y = a <= SOFT_KNEE ? a : SOFT_KNEE + (1 - SOFT_KNEE) * Math.tanh((a - SOFT_KNEE) / (1 - SOFT_KNEE));
    curve[i] = Math.sign(u) * y;
  }
  return curve;
}

const toDb = (x: number): number => (x > 0 ? Math.max(METER_FLOOR_DB, 20 * Math.log10(x)) : METER_FLOOR_DB);

export interface MasterStats {
  rmsDb: number;
  peakDb: number;
  centroidHz: number;
  clipPct: number;
}

export class MasterChain {
  readonly input: GainNode;
  readonly analyser: AnalyserNode;
  private readonly ac: AudioContext;
  private readonly fade: GainNode;
  private readonly volume: GainNode;
  private readonly pre: AnalyserNode;
  private readonly lowShelfPlan: ParamPlanner;
  private readonly highShelfPlan: ParamPlanner;
  private readonly trimPlan: ParamPlanner;
  private nextGrid: number | null = null;
  private readonly time: Float32Array<ArrayBuffer>;
  private readonly freq: Float32Array<ArrayBuffer>;
  private stats = { sum: 0, n: 0, peak: 0, clipped: 0, preN: 0, centroid: 0, centroidN: 0 };

  constructor(ac: AudioContext) {
    this.ac = ac;
    this.input = new GainNode(ac, { gain: 1 });
    const lowShelf = new BiquadFilterNode(ac, { type: 'lowshelf', frequency: 150, gain: 0 });
    const highShelf = new BiquadFilterNode(ac, { type: 'highshelf', frequency: 3000, gain: 0 });
    const trim = new GainNode(ac, { gain: 1 });
    const limiter = new DynamicsCompressorNode(ac, { threshold: -6, knee: 3, ratio: 20, attack: 0.003, release: 0.25 });
    const clipIn = new GainNode(ac, { gain: 0.5 });
    const clip = new WaveShaperNode(ac, { curve: softClipCurve(), oversample: 'none' });
    this.fade = new GainNode(ac, { gain: 0 });
    this.volume = new GainNode(ac, { gain: 1 });
    this.analyser = new AnalyserNode(ac, { fftSize: 2048, smoothingTimeConstant: 0.8 });
    this.pre = new AnalyserNode(ac, { fftSize: 2048, smoothingTimeConstant: 0 });
    this.input.connect(lowShelf).connect(highShelf).connect(trim);
    trim.connect(this.pre);
    trim.connect(limiter).connect(clipIn).connect(clip);
    clip.connect(this.analyser);
    clip.connect(this.fade).connect(this.volume).connect(ac.destination);
    this.lowShelfPlan = new ParamPlanner(lowShelf.gain, false);
    this.highShelfPlan = new ParamPlanner(highShelf.gain, false);
    this.trimPlan = new ParamPlanner(trim.gain, false);
    this.time = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.freq = new Float32Array(new ArrayBuffer(this.analyser.frequencyBinCount * 4));
  }

  setVolume(volume: number): void {
    this.volume.gain.setTargetAtTime(Math.min(1, Math.max(0, volume)), this.ac.currentTime, 0.05);
  }

  /** Silent until `t0`, then up to full over [t0, t1]. */
  fadeIn(t0: number, t1: number): void {
    const g = this.fade.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0, this.ac.currentTime);
    g.setValueAtTime(0, t0);
    g.linearRampToValueAtTime(1, t1);
  }

  /** Mutes at once (applies when a suspended context resumes, before anything stale is heard). */
  silence(): void {
    const g = this.fade.gain;
    g.cancelScheduledValues(0);
    g.setValueAtTime(0, this.ac.currentTime);
  }

  fadeOut(seconds: number): void {
    const g = this.fade.gain;
    const now = this.ac.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + seconds);
  }

  restart(): void {
    this.nextGrid = null;
  }

  /** Tilt and safety trim from the mixer, planned on the channel grid. */
  plan(nowCycle: number, untilCycle: number, mixer: MixerState, audioTimeAt: (cycle: number) => number): void {
    const values = (c: number) => {
      const tilt = tiltDb(macrosAt(mixer, c).brightness);
      const safety = safetyAt(mixer, c);
      return { low: tilt.lowShelfDb, high: tilt.highShelfDb + safety.highShelfDb, trim: dbToGain(safety.masterDb) };
    };
    if (this.nextGrid === null) {
      const t = Math.max(this.ac.currentTime, audioTimeAt(nowCycle));
      const v = values(nowCycle);
      this.lowShelfPlan.reset(t, v.low);
      this.highShelfPlan.reset(t, v.high);
      this.trimPlan.reset(t, v.trim);
      this.nextGrid = Math.floor(nowCycle / GRID_BARS + 1) * GRID_BARS;
    }
    for (let g = this.nextGrid; g <= untilCycle + 1e-6; g += GRID_BARS) {
      this.nextGrid = g + GRID_BARS;
      const t = audioTimeAt(g);
      if (t <= this.ac.currentTime) continue;
      const v = values(g);
      this.lowShelfPlan.point(t, v.low);
      this.highShelfPlan.point(t, v.high);
      this.trimPlan.point(t, v.trim);
    }
  }

  meters(): { rmsDb: number; peakDb: number } {
    this.analyser.getFloatTimeDomainData(this.time);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < this.time.length; i++) {
      const x = this.time[i]!;
      sum += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    return { rmsDb: toDb(Math.sqrt(sum / this.time.length)), peakDb: toDb(peak) };
  }

  /** Accumulates telemetry statistics from the current analyser windows. */
  sample(): void {
    const s = this.stats;
    this.analyser.getFloatTimeDomainData(this.time);
    for (let i = 0; i < this.time.length; i++) {
      const x = this.time[i]!;
      s.sum += x * x;
      s.peak = Math.max(s.peak, Math.abs(x));
    }
    s.n += this.time.length;
    this.pre.getFloatTimeDomainData(this.time);
    for (let i = 0; i < this.time.length; i++) if (Math.abs(this.time[i]!) >= 1) s.clipped++;
    s.preN += this.time.length;
    this.analyser.getFloatFrequencyData(this.freq);
    const binHz = this.ac.sampleRate / this.analyser.fftSize;
    let num = 0;
    let den = 0;
    for (let i = 1; i < this.freq.length; i++) {
      const m = 10 ** (this.freq[i]! / 20);
      num += m * i * binHz;
      den += m;
    }
    if (den > 1e-6) {
      s.centroid += num / den;
      s.centroidN++;
    }
  }

  takeStats(): MasterStats {
    const s = this.stats;
    this.stats = { sum: 0, n: 0, peak: 0, clipped: 0, preN: 0, centroid: 0, centroidN: 0 };
    return {
      rmsDb: s.n ? toDb(Math.sqrt(s.sum / s.n)) : METER_FLOOR_DB,
      peakDb: toDb(s.peak),
      centroidHz: s.centroidN ? s.centroid / s.centroidN : 0,
      clipPct: s.preN ? (100 * s.clipped) / s.preN : 0,
    };
  }
}
