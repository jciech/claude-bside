import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Engine } from '../../src/client/engine/types.ts';
import { createLathe } from '../../src/client/render/host.ts';
import { Lathe } from '../../src/client/render/lathe.ts';
import type { LabelState } from '../../src/client/render/protocol.ts';
import { FakeCanvas, sheens } from './fake-canvas.ts';

/** Waits (real time: the main-thread renderer runs its own frames) until `done` holds. */
async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Just enough of an engine for the host and its feed: a steady clock, nothing playing. */
function quietEngine(): Engine {
  const t0 = performance.now();
  return {
    state: 'ready',
    now: () => 4 + ((performance.now() - t0) / 1000) * 0.5,
    cps: () => 0.5,
    query: () => [],
    sections: () => [],
    sectionAt: () => null,
    meters: () => ({ master: { rmsDb: -120, peakDb: -120 }, parts: {} }),
    on: () => () => {},
  } as unknown as Engine;
}

beforeEach(() => vi.stubGlobal('OffscreenCanvas', FakeCanvas));
afterEach(() => vi.unstubAllGlobals());

describe('prefers-contrast: more', () => {
  it('the Lathe draws no sheen while it is set', () => {
    const canvas = new FakeCanvas(400, 400);
    const lathe = new Lathe(canvas as unknown as OffscreenCanvas, 400, 400, 1, 'full');
    lathe.draw(1, 0.5, 1000);
    expect(sheens(canvas)).toHaveLength(1);
    lathe.setPrefs({ contrastMore: true });
    lathe.draw(1.1, 0.5, 1100);
    expect(sheens(canvas)).toHaveLength(1);
    lathe.setPrefs({ contrastMore: false });
    lathe.draw(1.2, 0.5, 1200);
    expect(sheens(canvas)).toHaveLength(2);
  });

  it('reaches the renderer from createLathe and setPrefs', async () => {
    const canvas = new FakeCanvas(400, 400);
    const host = createLathe(canvas as unknown as HTMLCanvasElement, quietEngine(), { tier: 'full', useWorker: false, prefs: { contrastMore: true } });
    try {
      // The loupe's lens is a conic gradient too: two of them mean two frames were drawn.
      await until(() => canvas.gradients.filter((g) => g.kind === 'conic').length >= 2);
      expect(sheens(canvas)).toHaveLength(0);
      host.setPrefs({ contrastMore: false });
      await until(() => sheens(canvas).length > 0);
    } finally {
      host.destroy();
    }
  });
});

describe('LatheHost label', () => {
  it('calls a label listener at once with the current state', () => {
    const host = createLathe(new FakeCanvas(200, 200) as unknown as HTMLCanvasElement, quietEngine(), { tier: 'calm', useWorker: false });
    try {
      const seen: LabelState[] = [];
      const off = host.on('label', (s) => seen.push(s));
      expect(seen).toEqual([{ inverted: false, listening: false }]);
      off();
    } finally {
      host.destroy();
    }
  });
});
