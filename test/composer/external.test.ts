import { describe, expect, it } from 'vitest';
import { createExternalComposer } from '../../src/server/composer/external.ts';
import type { PlanRequest } from '../../src/shared/composer-api.ts';
import type { ComposerTools } from '../../src/server/types.ts';
import { memoryLog, turnContext } from './fixtures.ts';

const request: PlanRequest = { id: 'ep1-r4', kind: 'section', createdAt: 0, softDeadlineMs: 0, hardDeadlineMs: 0, targetCycle: 20, scheduleRev: 1, context: turnContext() };
const tools = {} as ComposerTools;

describe('the external driver', () => {
  it('reports a commit when the conductor fulfils the request over HTTP', async () => {
    const log = memoryLog();
    const controller = new AbortController();
    const pending = createExternalComposer({ log }).compose(request, tools, controller.signal);
    expect(log.lines[0]).toMatchObject({ msg: 'external: waiting for a commit', data: { request: 'ep1-r4', hint: 'bside commit plan.json --request ep1-r4' } });
    controller.abort('fulfilled');
    expect(await pending).toMatchObject({ status: 'committed', attempts: 1, result: { accepted: true } });
  });

  it.each(['deadline', 'driver-switch', 'superseded'])('fails when the request ends with %s', async (reason) => {
    const controller = new AbortController();
    const pending = createExternalComposer({ log: memoryLog() }).compose(request, tools, controller.signal);
    controller.abort(reason);
    expect(await pending).toEqual({ status: 'failed', reason, attempts: 0 });
  });

  it('resolves at once for a request that is already over', async () => {
    const controller = new AbortController();
    controller.abort('deadline');
    expect(await createExternalComposer({ log: memoryLog() }).compose(request, tools, controller.signal)).toMatchObject({ status: 'failed', reason: 'deadline' });
  });
});
