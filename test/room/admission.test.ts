// Admission at the engine.io handshake (src/server/room/socket.ts): what a connection that never
// joins the namespace costs.
import { afterEach, expect, it } from 'vitest';
import { bootRoom, type Room } from '../integration/harness.ts';

let room: Room | null = null;
afterEach(async () => {
  await room?.close();
  room = null;
});

/** Opens a raw websocket to engine.io and closes it again; true when the handshake was accepted. */
async function touch(url: string): Promise<boolean> {
  const ws = new WebSocket(url);
  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
  });
  if (opened) await new Promise((resolve) => ((ws.onclose = resolve), ws.close()));
  return opened;
}

it('rate-limits handshakes per network, counting connections that never join the namespace', async () => {
  room = await bootRoom();
  const url = `${room.url.replace('http', 'ws')}/socket.io/?EIO=4&transport=websocket`;
  let accepted = 0;
  for (let i = 0; i < 45; i++) if (await touch(url)) accepted++;
  // The burst of 30 (plus what refills at 1/s meanwhile), although no more than one is ever open at once.
  expect(accepted).toBeGreaterThanOrEqual(28);
  expect(accepted).toBeLessThan(40);
  // A real listener from that network waits for the same bucket.
  await expect(room.connect()).rejects.toThrow();
});
