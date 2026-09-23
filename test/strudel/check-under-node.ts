// Run by checker.test.ts as a plain `node` child process (no vitest, optionally no --import hook):
// the pool must boot its workers and check a section on its own.
import { readFileSync } from 'node:fs';
import { createChecker } from '../../src/server/check/checker.ts';

const catalog = JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'));
const checker = createChecker({ catalog, poolSize: 1 });
const result = await checker.checkSection({
  parts: [{ id: 'kick', role: 'kick', code: 's("bd*4")', knobs: [], chromatic: false, level: 1, enterBar: 0, exitBar: null, patternBarAtStart: 0 }],
  bpm: 120,
  scale: null,
  bars: 8,
});
await checker.close();
console.log(JSON.stringify({ ok: result.ok, digest: result.parts[0]?.digest }));
