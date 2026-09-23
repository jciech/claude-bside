// The engine-native riser transition (src/client/engine/types.ts, "Transitions"): looped stereo
// noise → high-pass sweeping 200 → 8000 Hz → gain rising to ≈ −18 dBFS, cut at bar 0, fed into
// the master bus before the limiter. Scheduled once per section from the audio times of its window.
const FROM_HZ = 200;
const TO_HZ = 8000;
const FROM_GAIN = 0.004;
/** Full-scale uniform noise has RMS ≈ 0.58; × 0.2 ≈ −19 dBFS. */
const TO_GAIN = 0.2;
const CUT_SEC = 0.03;

export class RiserVoice {
  private readonly ac: AudioContext;
  private readonly destination: AudioNode;
  private noise: AudioBuffer | null = null;
  private readonly active = new Map<string, { source: AudioBufferSourceNode; gain: GainNode }>();

  constructor(ac: AudioContext, destination: AudioNode) {
    this.ac = ac;
    this.destination = destination;
  }

  has(id: string): boolean {
    return this.active.has(id);
  }

  /** Sweeps over audio time [t0, t1], starting `progress` (0..1) of the way through the sweep. */
  schedule(id: string, t0: number, t1: number, progress: number): void {
    if (this.active.has(id) || t1 <= t0) return;
    const ac = this.ac;
    const source = new AudioBufferSourceNode(ac, { buffer: this.noiseBuffer(), loop: true });
    const filter = new BiquadFilterNode(ac, { type: 'highpass', Q: 1.2 });
    const gain = new GainNode(ac, { gain: 0 });
    const at = (a: number, b: number) => a * (b / a) ** Math.min(1, Math.max(0, progress));
    filter.frequency.setValueAtTime(at(FROM_HZ, TO_HZ), t0);
    filter.frequency.exponentialRampToValueAtTime(TO_HZ, t1);
    gain.gain.setValueAtTime(at(FROM_GAIN, TO_GAIN), t0);
    gain.gain.exponentialRampToValueAtTime(TO_GAIN, t1);
    gain.gain.linearRampToValueAtTime(0, t1 + CUT_SEC);
    source.connect(filter).connect(gain).connect(this.destination);
    source.start(t0);
    source.stop(t1 + CUT_SEC + 0.01);
    this.active.set(id, { source, gain });
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      this.active.delete(id);
    };
  }

  /** Fades out every riser (epoch change, revoked section). */
  stopAll(): void {
    const now = this.ac.currentTime;
    for (const { source, gain } of this.active.values()) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.1);
      source.stop(now + 0.12);
    }
  }

  private noiseBuffer(): AudioBuffer {
    if (!this.noise) {
      const length = Math.round(this.ac.sampleRate * 2);
      this.noise = this.ac.createBuffer(2, length, this.ac.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const data = this.noise.getChannelData(ch);
        for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      }
    }
    return this.noise;
  }
}
