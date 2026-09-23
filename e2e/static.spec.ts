// Listener and composer text is data: nothing in the client may render HTML from a string
// (docs/ARCHITECTURE.md §11.6). A static check, no browser needed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const CLIENT = fileURLToPath(new URL('../src/client', import.meta.url));
const SINKS = /\{@html\b|\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test('no file under src/client renders HTML from strings', async ({}, info) => {
  test.skip(info.project.name !== 'desktop', 'one run is enough');
  const sources = files(CLIENT).filter((f) => /\.(svelte|ts|js|mjs|html)$/.test(f));
  expect(sources.length).toBeGreaterThan(10);
  const offenders = sources.filter((f) => SINKS.test(readFileSync(f, 'utf8')));
  expect(offenders).toEqual([]);
});
