import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/server/log.ts';

describe('createLogger', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
    vi.restoreAllMocks();
  });

  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => (out.push(String(chunk)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => (err.push(String(chunk)), true));
    return { out, err };
  }

  it('writes one JSON object per line, filtered by BSIDE_LOG, warnings to stderr', () => {
    process.env.BSIDE_LOG = 'info';
    process.env.BSIDE_LOG_FORMAT = 'json';
    const { out, err } = capture();
    const log = createLogger('crowd');
    log.debug('hidden');
    log.info('joined', { listeners: 3, msg: 'cannot override' });
    log.error('failed', { err: new Error('boom') });
    expect(out.length).toBe(1);
    const line = JSON.parse(out[0]!);
    expect(line).toMatchObject({ level: 'info', scope: 'crowd', msg: 'joined', listeners: 3 });
    expect(typeof line.time).toBe('string');
    const error = JSON.parse(err[0]!);
    expect(error.err).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('is silent when asked, and survives circular data', () => {
    process.env.BSIDE_LOG = 'silent';
    const { out, err } = capture();
    createLogger('x').error('nothing');
    expect(out.length + err.length).toBe(0);
    process.env.BSIDE_LOG = 'debug';
    process.env.BSIDE_LOG_FORMAT = 'json';
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    createLogger('x').debug('loop', { circular });
    expect(JSON.parse(out[0]!).circular.self).toBe('[circular]');
  });
});
