// Pure aggregation of listener inputs (docs/ARCHITECTURE.md §8), ported from the steering
// prototype (research/scratch-steering/steer.mjs).
import type { PadPoint } from '../../shared/protocol.ts';
import { CROWD } from './params.ts';

export interface Voice<T> {
  /** Capped listener weight (0 = not audible). */
  weight: number;
  /** 0..1; 0 = silent (no input, stale, or not yet allowed to steer). */
  freshness: number;
  value: T | null;
}

export interface Split {
  axis: 'x' | 'y';
  low: number;
  high: number;
}

export interface PadAggregate {
  /** P = Σ w·s·p / (Σ w·s + β·Σ w·(1−s)). */
  target: PadPoint;
  /** Σ w·s / Σ w. */
  turnout: number;
  /** Kish effective number of participants (Σ w·s)² / Σ (w·s)². */
  effectiveVoices: number;
  /** 1 − (weighted RMS distance of participants from their mean) / √2. */
  consensus: number;
  split: Split | null;
  participants: { weight: number; point: PadPoint }[];
}

export interface KeepAggregate {
  value: number;
  effectiveVoices: number;
}

const NO_PAD: PadAggregate = { target: { x: 0, y: 0 }, turnout: 0, effectiveVoices: 0, consensus: 1, split: null, participants: [] };

export function aggregatePad(voices: readonly Voice<PadPoint>[], beta: number = CROWD.silentPrior): PadAggregate {
  let sx = 0;
  let sy = 0;
  let part = 0;
  let part2 = 0;
  let silent = 0;
  const participants: PadAggregate['participants'] = [];
  for (const v of voices) {
    if (v.weight <= 0) continue;
    if (v.value && v.freshness > CROWD.minFreshness) {
      const ws = v.weight * v.freshness;
      sx += ws * v.value.x;
      sy += ws * v.value.y;
      part += ws;
      part2 += ws * ws;
      silent += v.weight * (1 - v.freshness);
      participants.push({ weight: ws, point: v.value });
    } else silent += v.weight;
  }
  const denom = part + beta * silent;
  if (denom <= 0) return NO_PAD;
  let consensus = 1;
  if (part > 0) {
    const mx = sx / part;
    const my = sy / part;
    const variance = participants.reduce((a, p) => a + p.weight * ((p.point.x - mx) ** 2 + (p.point.y - my) ** 2), 0) / part;
    consensus = Math.max(0, Math.min(1, 1 - Math.sqrt(variance) / Math.SQRT2));
  }
  return {
    target: { x: sx / denom, y: sy / denom },
    turnout: part / (part + silent),
    effectiveVoices: part2 > 0 ? (part * part) / part2 : 0,
    consensus,
    split: detectSplit(participants),
    participants,
  };
}

/**
 * Real bimodality only: 1-D 2-means per axis, reported when both clusters hold ≥ 25 % of the
 * participating weight and their centres are ≥ 1.0 apart (the wider axis wins).
 */
export function detectSplit(points: readonly { weight: number; point: PadPoint }[]): Split | null {
  if (points.length < CROWD.split.minPoints) return null;
  const total = points.reduce((a, p) => a + p.weight, 0);
  if (total <= 0) return null;
  let best: Split | null = null;
  for (const axis of ['x', 'y'] as const) {
    let lo = -0.5;
    let hi = 0.5;
    let wLo = 0;
    let wHi = 0;
    for (let iteration = 0; iteration < 10; iteration++) {
      let sLo = 0;
      let sHi = 0;
      wLo = 0;
      wHi = 0;
      for (const p of points) {
        const v = p.point[axis];
        if (Math.abs(v - lo) <= Math.abs(v - hi)) {
          sLo += p.weight * v;
          wLo += p.weight;
        } else {
          sHi += p.weight * v;
          wHi += p.weight;
        }
      }
      if (wLo) lo = sLo / wLo;
      if (wHi) hi = sHi / wHi;
    }
    const gap = hi - lo;
    if (wLo / total >= CROWD.split.minShare && wHi / total >= CROWD.split.minShare && gap >= CROWD.split.minGap) {
      if (!best || gap > best.high - best.low) best = { axis, low: lo, high: hi };
    }
  }
  return best;
}

/** Keep (+1) vs move on (−1), with the same silent-majority prior as the pad. */
export function aggregateKeep(voices: readonly Voice<1 | -1>[], beta: number = CROWD.silentPrior): KeepAggregate {
  let sum = 0;
  let part = 0;
  let part2 = 0;
  let silent = 0;
  for (const v of voices) {
    if (v.weight <= 0) continue;
    if (v.value !== null && v.freshness > CROWD.minFreshness) {
      const ws = v.weight * v.freshness;
      sum += ws * v.value;
      part += ws;
      part2 += ws * ws;
      silent += v.weight * (1 - v.freshness);
    } else silent += v.weight;
  }
  const denom = part + beta * silent;
  return { value: denom > 0 ? sum / denom : 0, effectiveVoices: part2 > 0 ? (part * part) / part2 : 0 };
}

/** Caps the summed weight of each network at `cap`, scaling its members proportionally. */
export function capByNetwork<K>(weights: Map<K, number>, networkOf: (key: K) => string, cap: number): Map<K, number> {
  const totals = new Map<string, number>();
  for (const [key, w] of weights) totals.set(networkOf(key), (totals.get(networkOf(key)) ?? 0) + w);
  const out = new Map<K, number>();
  for (const [key, w] of weights) {
    const total = totals.get(networkOf(key))!;
    out.set(key, total > cap ? (w * cap) / total : w);
  }
  return out;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
