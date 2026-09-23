import { afterEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ decoded: [] as string[] }));
vi.mock('@strudel/webaudio', () => ({
  getSampleInfo: () => ({}),
  getSound: () => undefined,
  loadBuffer: (url: string) => {
    env.decoded.push(url);
    return Promise.resolve({});
  },
}));
vi.mock('@strudel/soundfonts', () => ({ getFontBufferSource: () => Promise.resolve() }));

const { Preloader } = await import('../../src/client/engine/preload.ts');

afterEach(() => vi.unstubAllGlobals());

describe('Preloader', () => {
  it('fetches a sample whose file name has a "#" as superdough does (%23), not as a URL fragment', async () => {
    // dirt-samples' mute/000_FH A#2 SCF.wav, served where the browser would look for it.
    const url = 'https://samples.test/dirt/mute/000_FH A#2 SCF.wav';
    const served = 'https://samples.test/dirt/mute/000_FH%20A%232%20SCF.wav';
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: string) => {
      const target = new URL(input);
      target.hash = '';
      requested.push(target.href);
      return new Response('RIFF', { status: target.href === served ? 200 : 404 });
    });
    const preloader = new Preloader({ ac: () => ({}) as AudioContext, warm: () => Promise.resolve() });
    expect(await preloader.load({ key: url, kind: 'sample', label: 'mute:0', url, value: { s: 'mute' } })).toBe(true);
    expect(requested).toEqual([served]);
    // superdough's loadBuffer encodes the URL itself, and caches it under that key.
    expect(env.decoded).toEqual([url]);
  });
});
