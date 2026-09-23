// Checker worker thread. Registers the Strudel resolve hook itself (workers spawned under vitest don't
// inherit the parent's --import) and only then imports the toolkit dynamically.
import { parentPort, workerData } from 'node:worker_threads';
import { registerStrudelHooks } from '../node-hooks.ts';
import type { SectionCheck } from '../../shared/analysis.ts';
import type { CheckSectionInput } from '../types.ts';

export type WorkerRequest = { type: 'check'; id: number; input: CheckSectionInput };
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'progress'; id: number; part: string }
  | { type: 'result'; id: number; result: SectionCheck }
  | { type: 'failure'; id: number; message: string };

registerStrudelHooks();

const { log, warn } = console;
console.log = console.warn = () => {}; // Strudel announces itself on import ("🌀 @strudel/core loaded")
const [{ runCheck }, { parseCatalog, createSoundIndex }] = await Promise.all([import('./run.ts'), import('../../strudel/catalog.ts')]).finally(() => {
  console.log = log;
  console.warn = warn;
});

const index = createSoundIndex(parseCatalog((workerData as { catalog: unknown }).catalog));
const port = parentPort!;
const send = (m: WorkerResponse) => port.postMessage(m);

port.on('message', (msg: WorkerRequest) => {
  if (msg.type !== 'check') return;
  try {
    const result = runCheck(msg.input, { index, onPart: (part) => send({ type: 'progress', id: msg.id, part }) });
    send({ type: 'result', id: msg.id, result });
  } catch (e) {
    send({ type: 'failure', id: msg.id, message: String((e as Error)?.stack ?? e) });
  }
});
send({ type: 'ready' });
