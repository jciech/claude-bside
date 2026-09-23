import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SectionCheck } from '../../src/shared/analysis.ts';
import type { CheckPartInput, CheckSectionInput, Checker } from '../../src/server/types.ts';
import { createChecker } from '../../src/server/check/checker.ts';

const catalog = JSON.parse(readFileSync(new URL('../fixtures/catalog.small.json', import.meta.url), 'utf8'));
const root = fileURLToPath(new URL('../..', import.meta.url));

const part = (id: string, code: string, extra: Partial<CheckPartInput> = {}): CheckPartInput => ({
  id, role: 'kick', code, knobs: [], chromatic: false, level: 0.9, enterBar: 0, exitBar: null, patternBarAtStart: 0, ...extra,
});
const section = (...parts: CheckPartInput[]): CheckSectionInput => ({ parts, bpm: 120, scale: 'D:dorian', bars: 16 });
const rulesOf = (c: SectionCheck) => c.errors.map((e) => e.rule);

describe('checker pool', () => {
  let checker: Checker;
  beforeAll(() => {
    checker = createChecker({ catalog, poolSize: 2, recycleAfter: 3 });
  });
  afterAll(() => checker.close());

  it('checks a section in a worker thread under vitest', async () => {
    const result = await checker.checkSection(
      section(
        part('kick', 's("sbd*4").gain(0.9)'),
        part('bass', 'n("<0 3 5 2>").scale("D2:dorian").s("sawtooth").lpf(knob("cut"))', {
          role: 'bass',
          knobs: [{ name: 'cut', default: 800, min: 300, max: 2400, follows: 'brightness' }],
        }),
        part('bad', 's("bd").reverb(0.4)', { role: 'perc' }),
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.parts.map((p) => p.ok)).toEqual([true, true, false]);
    expect(result.parts[1]!.digest).toMatchObject({ instrument: 'Sawtooth', register: 'bass', keyFit: 1 });
    expect(result.parts[2]!.errors[0]).toMatchObject({ rule: 'unknown-method', path: 'bad', hint: expect.stringMatching(/\.room\(\)/) });
    expect(result.mix!.audibleParts).toBe(2);
    expect(result.fingerprint!.bpm).toBe(120);
    expect(result.parts[0]!.timings.analyzeMs).toBeGreaterThan(0);
  });

  it('auditions loose parts', async () => {
    const result = await checker.audition({
      parts: [{ id: 'lead', role: 'lead', code: 'n("0 2 4 7").scale("D4:dorian").s("square")', knobs: [], chromatic: false }],
      bpm: null,
      scale: 'D:dorian',
      bars: null,
    });
    expect(result).toMatchObject({ ok: true, errors: [], warnings: [] });
    expect(result.parts[0]).toMatchObject({ id: 'lead', role: 'lead', ok: true, digest: { keyFit: 1, evPerBar: 4 } });
    expect(result.descriptors).toEqual(result.mix!.descriptors);
  });

  it('reports section-level audition issues on the result, not on a part, and not as ok', async () => {
    const hats = { role: 'hats' as const, code: 's("hh*16, hh*16, hh*16")', knobs: [], chromatic: false };
    const result = await checker.audition({
      parts: [0, 1, 2, 3, 4].map((i) => ({ ...hats, id: `h${i}` })),
      bpm: null,
      scale: 'D:dorain',
      bars: null,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => [e.rule, e.path])).toEqual([['scale', 'scale'], ['density', 'mix']]);
    expect(result.parts.every((p) => p.ok && p.errors.length === 0)).toBe(true);

    const timedOut = await checker.audition({ parts: [{ ...hats, id: 'h0' }], bpm: null, scale: null, bars: null }, { timeoutMs: 1 });
    expect(timedOut).toMatchObject({ ok: false, errors: [{ rule: 'timeout' }], mix: null });
  });

  it('times out a job, replaces the worker and keeps working', async () => {
    const timedOut = await checker.checkSection(section(part('kick', 's("sbd*4")')), { timeoutMs: 1 });
    expect(rulesOf(timedOut)).toEqual(['timeout']);
    expect(timedOut.errors[0]!.message).toMatch(/longer than 1 ms/);
    const after = await Promise.all([1, 2, 3, 4].map(() => checker.checkSection(section(part('kick', 's("sbd*4")')))));
    expect(after.every((r) => r.ok)).toBe(true); // also crosses recycleAfter: 3
  });

  it('rejects an aborted check', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(checker.checkSection(section(part('kick', 's("bd")')), { signal: controller.signal })).rejects.toThrow(/aborted/);
  });
});

describe('checker queue', () => {
  it('reports busy, lets commits evict auditions, runs commits first and honours aborts', async () => {
    const checker = createChecker({ catalog, poolSize: 1, maxQueue: 2 });
    try {
      const order: string[] = [];
      const track = (label: string, p: Promise<SectionCheck>) => p.then((r) => (order.push(label), r));
      const s = section(part('kick', 's("sbd*4")'));
      // The worker is still booting, so everything queues.
      const first = track('audition-1', checker.checkSection(s, { priority: 'audition' }));
      const aborted = new AbortController();
      const cancelled = checker.checkSection(s, { signal: aborted.signal });
      aborted.abort();
      await expect(cancelled).rejects.toThrow(/aborted/);
      const second = track('audition-2', checker.checkSection(s, { priority: 'audition' }));
      const busy = await checker.checkSection(s, { priority: 'audition' });
      expect(rulesOf(busy)).toEqual(['busy']);
      const commit = track('commit', checker.checkSection(s)); // evicts the newest audition

      const [r1, r2, r3] = await Promise.all([first, second, commit]);
      expect(r1.ok).toBe(true);
      expect(rulesOf(r2)).toEqual(['busy']);
      expect(r3.ok).toBe(true);
      expect(order).toEqual(['audition-2', 'commit', 'audition-1']);
    } finally {
      await checker.close();
    }
  });

  it('refuses work after close', async () => {
    const checker = createChecker({ catalog, poolSize: 1 });
    const pending = expect(checker.checkSection(section(part('kick', 's("bd")')))).rejects.toThrow(/closed/);
    await checker.close();
    await pending;
    await expect(checker.checkSection(section(part('kick', 's("bd")')))).rejects.toThrow(/closed/);
  });
});

describe('plain node', () => {
  for (const args of [[], ['--import', './src/server/node-hooks.ts']]) {
    it(`checks a section from a node process ${args.length ? 'with' : 'without'} the --import hook`, () => {
      const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args, 'test/strudel/check-under-node.ts'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(JSON.parse(out.trim().split('\n').pop()!)).toMatchObject({ ok: true, digest: { evPerBar: 4 } });
    });
  }
});
