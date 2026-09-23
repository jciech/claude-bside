// Strudel audio boot with the pinned packages (no @strudel/web, no repl web component): our own
// AudioContext handed to superdough, worklets loaded before the gesture, and the two superdough
// 1.3.0 initAudio bugs worked around — it never resumes the context ((!ctx) instanceof … is always
// false) and leaves maxPolyphony NaN unless it is passed (superdough.mjs:49-51, :291).
import { initAudio, setAudioContext } from '@strudel/webaudio';
import { setTime } from '@strudel/core';

export const MAX_POLYPHONY = 96;

let context: AudioContext | null = null;
let graph: Promise<void> | null = null;

/** Creates (once) the context superdough renders into; suspended until a gesture resumes it. */
export function audioContext(): AudioContext {
  if (!context) {
    context = new AudioContext({ latencyHint: 'playback' });
    setAudioContext(context);
  }
  return context;
}

/** Loads superdough's worklets and polyphony settings (allowed on a suspended context). */
export function initAudioGraph(): Promise<void> {
  audioContext();
  const pending: Promise<void> =
    graph ??
    initAudio({ maxPolyphony: MAX_POLYPHONY, multiChannelOrbits: false }).catch((e: unknown) => {
      graph = null;
      throw e;
    });
  graph = pending;
  return pending;
}

/** Must run synchronously inside the gesture handler (Safari honours resume() only there). */
export function resumeInGesture(): Promise<void> {
  return audioContext().resume();
}

/** Anything calling Strudel's getTime() (e.g. signals of wall time) reads the engine's cycle. */
export function bindStrudelTime(now: () => number): void {
  setTime(now);
}
