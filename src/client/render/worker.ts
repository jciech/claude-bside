// Render worker entry: owns the transferred OffscreenCanvas and its own animation frames, so
// rasterising the record never competes with the audio scheduler on the main thread.
import type { FromRenderer, ToRenderer } from './protocol.ts';
import { createRenderer } from './renderer.ts';

const scope = self as unknown as {
  postMessage(message: FromRenderer): void;
  onmessage: ((event: MessageEvent<ToRenderer>) => void) | null;
};

const renderer = createRenderer((message) => scope.postMessage(message), { fpsCap: null });
scope.onmessage = (event) => renderer.handle(event.data);
