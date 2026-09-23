// Engine channels (src/client/engine/types.ts, "Level"): one per orbit, inserted between
// superdough's orbit output and the master bus. superdough 1.3.0 routes every hap into
// `Orbit.summingNode → Orbit.output`, and `Orbit.output.gain` belongs to the sidechain (duck ramps
// it), so the channel hangs off `Orbit.output`: we create the orbit before any hap can, disconnect
// its output from the StereoPanner that `connectToDestination` attached, and route it
//   Orbit.output → low-pass → high-pass → gain (level/automation/transitions/macros/trims)
//                → mute (listener's personal mix) → master bus   (+ an analyser tap for meters)
// Gains and filters are sampled from pure functions of cycle on a 1/8-bar grid and scheduled as
// AudioParam ramps at each point's audio time, so every client plays identical curves. The personal
// mix is planned on the same audio timeline: a channel mutes or unmutes exactly where an instance of
// a muted part takes it over, since its first note is handed to superdough well before it sounds.
import { getSuperdoughAudioController } from 'superdough';
import type { MixerState } from '../../shared/program.ts';
import { channelFiltersAt, channelGainAt, filterOwner, OPEN_HIGHPASS_HZ, OPEN_LOWPASS_HZ } from './envelope.ts';
import type { InstanceSpec, Score } from './score.ts';

export const GRID_BARS = 1 / 8;
const MUTE_TIME_CONSTANT = 0.03;
const EPS = 1e-6;

/** Schedules a sampled curve on one AudioParam, skipping constant stretches. */
export class ParamPlanner {
  private readonly param: AudioParam;
  private readonly exponential: boolean;
  private lastT = Number.NEGATIVE_INFINITY;
  private lastV: number | null = null;
  private heldT: number | null = null;

  constructor(param: AudioParam, exponential: boolean) {
    this.param = param;
    this.exponential = exponential;
  }

  /** Drops everything planned from `t` on and holds `v` there. */
  reset(t: number, v: number): void {
    const p = this.param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
    if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
    else p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
    this.lastT = t;
    this.lastV = v;
    this.heldT = null;
  }

  point(t: number, v: number): void {
    if (t <= this.lastT + EPS) return;
    if (this.lastV === null) {
      this.reset(t, v);
      return;
    }
    if (Math.abs(v - this.lastV) <= EPS * Math.max(1, Math.abs(v))) {
      this.heldT = t;
      return;
    }
    if (this.heldT !== null) {
      this.ramp(this.lastV, this.heldT);
      this.heldT = null;
    }
    this.ramp(v, t);
    this.lastT = t;
    this.lastV = v;
  }

  value(): number {
    return this.param.value;
  }

  private ramp(v: number, t: number): void {
    if (this.exponential) this.param.exponentialRampToValueAtTime(Math.max(EPS, v), t);
    else this.param.linearRampToValueAtTime(v, t);
  }
}

export interface Channel {
  orbit: number;
  gain: GainNode;
  mute: GainNode;
  analyser: AnalyserNode;
  gainPlan: ParamPlanner;
  lowpassPlan: ParamPlanner;
  highpassPlan: ParamPlanner;
  /** Mute state after the last planned mute change. */
  muted: boolean;
}

export interface PlanContext {
  /** The score in effect at a cycle (a late change switches at the next bar). */
  scoreAt(cycle: number): Score;
  mixer(): MixerState;
  audioTimeAt(cycle: number): number;
}

export class ChannelBank {
  private readonly ac: AudioContext;
  private readonly destination: AudioNode;
  private readonly channels = new Map<number, Channel>();
  /** Next grid cycle to plan, or null when planning must restart from "now". */
  private nextGrid: number | null = null;
  /** A schedule change: curves from this cycle on are re-planned at the next plan(). */
  private replanAt: number | null = null;
  /** Part ids the listener muted. */
  private mutedParts: ReadonlySet<string> = new Set();
  /** Next grid cycle whose mute state to plan, or null to apply the mix at "now" and plan on from there. */
  private nextMuteGrid: number | null = null;
  private readonly meterBuffer = new Float32Array(1024);

  constructor(ac: AudioContext, destination: AudioNode) {
    this.ac = ac;
    this.destination = destination;
  }

  /** Creates the orbit and its channel before superdough can create the orbit on its own. */
  ensure(orbit: number): Channel {
    const existing = this.channels.get(orbit);
    if (existing) return existing;
    const ac = this.ac;
    const bus = getSuperdoughAudioController().getOrbit(orbit, [0, 1]);
    bus.output.disconnect();
    const lowpass = new BiquadFilterNode(ac, { type: 'lowpass', frequency: OPEN_LOWPASS_HZ, Q: -3.01 });
    const highpass = new BiquadFilterNode(ac, { type: 'highpass', frequency: OPEN_HIGHPASS_HZ, Q: -3.01 });
    const gain = new GainNode(ac, { gain: 0 });
    const mute = new GainNode(ac, { gain: 1 });
    const analyser = new AnalyserNode(ac, { fftSize: 1024, smoothingTimeConstant: 0 });
    bus.output.connect(lowpass).connect(highpass).connect(gain).connect(mute).connect(this.destination);
    mute.connect(analyser);
    const channel: Channel = {
      orbit,
      gain,
      mute,
      analyser,
      gainPlan: new ParamPlanner(gain.gain, false),
      lowpassPlan: new ParamPlanner(lowpass.frequency, true),
      highpassPlan: new ParamPlanner(highpass.frequency, true),
      muted: false,
    };
    this.channels.set(orbit, channel);
    // Planned curves exist only for the channels that existed; start everyone from the current values.
    this.nextGrid = null;
    this.nextMuteGrid = null;
    return channel;
  }

  /** Forget planned curves; the next plan() restarts from the audio clock. */
  restart(): void {
    this.nextGrid = null;
    this.nextMuteGrid = null;
  }

  /** Re-plans from `cycle` on (a schedule change); curves before it stay as scheduled. */
  replanFrom(cycle: number): void {
    this.replanAt = this.replanAt === null ? cycle : Math.min(this.replanAt, cycle);
    this.nextMuteGrid = null;
  }

  /** The listener's personal mix: channels mute while an instance of one of these part ids owns them. */
  setMuted(partIds: ReadonlySet<string>): void {
    this.mutedParts = new Set(partIds);
    this.nextMuteGrid = null;
  }

  /** Schedules channel curves on the grid up to `untilCycle`. */
  plan(nowCycle: number, untilCycle: number, ctx: PlanContext): void {
    const mixer = ctx.mixer();
    const reset = (cycle: number) => {
      const t = Math.max(this.ac.currentTime, ctx.audioTimeAt(cycle));
      for (const ch of this.channels.values()) {
        const list = ctx.scoreAt(cycle).byOrbit.get(ch.orbit) ?? [];
        const f = channelFiltersAt(list, cycle);
        ch.gainPlan.reset(t, channelGainAt(list, cycle, mixer));
        ch.lowpassPlan.reset(t, f.lowpass);
        ch.highpassPlan.reset(t, f.highpass);
      }
    };
    if (this.nextGrid === null) {
      reset(nowCycle);
      this.nextGrid = Math.floor(nowCycle / GRID_BARS + 1) * GRID_BARS;
      this.replanAt = null;
    } else if (this.replanAt !== null) {
      const at = Math.max(this.replanAt, nowCycle);
      // Only points already planned at or after `at` are replaced; the grid reaches the rest.
      if (at < this.nextGrid - GRID_BARS + EPS) {
        reset(at);
        this.nextGrid = Math.floor(at / GRID_BARS + 1) * GRID_BARS;
      }
      this.replanAt = null;
    }
    for (let g = this.nextGrid; g <= untilCycle + EPS; g += GRID_BARS) {
      const t = ctx.audioTimeAt(g);
      this.nextGrid = g + GRID_BARS;
      if (t <= this.ac.currentTime) continue;
      const score = ctx.scoreAt(g);
      for (const ch of this.channels.values()) {
        const list = score.byOrbit.get(ch.orbit) ?? [];
        const f = channelFiltersAt(list, g);
        ch.gainPlan.point(t, channelGainAt(list, g, mixer));
        ch.lowpassPlan.point(t, f.lowpass);
        ch.highpassPlan.point(t, f.highpass);
      }
    }
    this.planMutes(nowCycle, untilCycle, ctx);
  }

  private planMutes(nowCycle: number, untilCycle: number, ctx: PlanContext): void {
    if (this.nextMuteGrid === null) {
      const t = this.ac.currentTime;
      const score = ctx.scoreAt(nowCycle);
      for (const ch of this.channels.values()) {
        ch.muted = this.mutedAt(score, ch.orbit, nowCycle);
        ch.mute.gain.cancelScheduledValues(t);
        ch.mute.gain.setTargetAtTime(ch.muted ? 0 : 1, t, MUTE_TIME_CONSTANT);
      }
      this.nextMuteGrid = Math.floor(nowCycle / GRID_BARS + 1) * GRID_BARS;
    }
    for (let g = this.nextMuteGrid; g <= untilCycle + EPS; g += GRID_BARS) {
      const t = ctx.audioTimeAt(g);
      this.nextMuteGrid = g + GRID_BARS;
      if (t <= this.ac.currentTime) continue;
      const score = ctx.scoreAt(g);
      for (const ch of this.channels.values()) {
        const m = this.mutedAt(score, ch.orbit, g);
        if (m === ch.muted) continue;
        // Consecutive sections never share an orbit between different instances, so whatever owned
        // the channel before has long gone quiet: the step is silent.
        ch.mute.gain.setValueAtTime(m ? 0 : 1, t);
        ch.muted = m;
      }
    }
  }

  private mutedAt(score: Score, orbit: number, cycle: number): boolean {
    const owner = filterOwner(score.byOrbit.get(orbit) ?? [], cycle);
    return !!owner && this.mutedParts.has(owner.part.id);
  }

  /** Fades every channel out over [t0, t1] (epoch change); planning resumes at t1. */
  retire(t0: number, t1: number, resumeCycle: number): void {
    for (const ch of this.channels.values()) {
      ch.gainPlan.reset(t0, ch.gain.gain.value);
      ch.gainPlan.point(t1, 0);
    }
    this.nextGrid = Math.floor(resumeCycle / GRID_BARS + 1) * GRID_BARS;
    this.nextMuteGrid = this.nextGrid;
    this.replanAt = null;
  }

  /** RMS (linear) of each channel's output right now. */
  levels(): Map<number, number> {
    const out = new Map<number, number>();
    const buf = this.meterBuffer;
    for (const ch of this.channels.values()) {
      ch.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      out.set(ch.orbit, Math.sqrt(sum / buf.length));
    }
    return out;
  }

  /** The instance sounding (or releasing) on a channel at `cycle`, for meters keyed by instance. */
  static ownerAt(score: Score, orbit: number, cycle: number): InstanceSpec | null {
    const owner = filterOwner(score.byOrbit.get(orbit) ?? [], cycle);
    return owner && cycle < owner.end + Math.max(owner.releaseBars, owner.endReleaseBars) ? owner : null;
  }

  /** Current AudioParam values of a channel (diagnostics). */
  inspect(orbit: number): { gain: number; lowpass: number; highpass: number; mute: number } | null {
    const ch = this.channels.get(orbit);
    if (!ch) return null;
    return { gain: ch.gain.gain.value, lowpass: ch.lowpassPlan.value(), highpass: ch.highpassPlan.value(), mute: ch.mute.gain.value };
  }
}
