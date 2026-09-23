// The UI's musical clock. One animation-frame loop reads the engine and publishes what the DOM needs
// at the rate it changes: the bar number (once a bar), --beat/--bar (on tempo changes) and meter
// levels (≈ 15 Hz, written straight into CSS variables of the elements that asked for them).
import { writable, type Readable } from 'svelte/store';
import type { Engine } from '../engine/types.ts';

const METER_EVERY_MS = 66;

export interface Pulse {
  /** Integer bar (floor of the audible cycle); -Infinity until the clock is synced. */
  bar: Readable<number>;
  /** Svelte action: writes `--m` (0..1 loudness of the instance key) on the node. */
  meter: (node: HTMLElement, key: string) => { update(key: string): void; destroy(): void };
  stop(): void;
}

export function startPulse(engine: Engine, synced: Promise<void>, root: HTMLElement = document.documentElement): Pulse {
  const bar = writable(Number.NEGATIVE_INFINITY);
  // Before the clock sync the engine's "now" is not the room's bar: publish nothing rather than nonsense.
  let ready = false;
  void synced.then(() => (ready = true));
  const meters = new Map<HTMLElement, string>();
  let lastBar = Number.NEGATIVE_INFINITY;
  let lastCps = 0;
  let lastMeterAt = 0;
  let raf = 0;

  const frame = (t: number) => {
    raf = requestAnimationFrame(frame);
    const c = engine.now();
    if (!ready || !Number.isFinite(c)) return;
    const b = Math.floor(c + 1e-6);
    if (b !== lastBar) {
      lastBar = b;
      bar.set(b);
    }
    const cps = engine.cps();
    if (cps > 0 && Math.abs(cps - lastCps) > 1e-6) {
      lastCps = cps;
      const barMs = 1000 / cps;
      root.style.setProperty('--bar', `${Math.round(barMs)}ms`);
      root.style.setProperty('--beat', `${Math.round(barMs / 4)}ms`);
    }
    if (meters.size && t - lastMeterAt >= METER_EVERY_MS) {
      lastMeterAt = t;
      const parts = engine.meters().parts;
      for (const [node, key] of meters) node.style.setProperty('--m', (parts[key] ?? 0).toFixed(3));
    }
  };
  raf = requestAnimationFrame(frame);

  return {
    bar,
    meter(node, key) {
      meters.set(node, key);
      return {
        update: (next: string) => void meters.set(node, next),
        destroy: () => void meters.delete(node),
      };
    },
    stop: () => cancelAnimationFrame(raf),
  };
}
