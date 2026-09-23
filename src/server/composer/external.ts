// The external driver (ARCHITECTURE §7.5): the composer is someone at a terminal (the bside CLI),
// Claude Code, or a script, talking to /api/composer/*. It commits over HTTP with the pending
// request's id; the conductor then aborts this request with reason 'fulfilled'. So compose() only
// waits for the abort and reports what it means.
import type { CommitResult, PlanRequest } from '../../shared/composer-api.ts';
import type { ComposeOutcome, Composer, ComposerTools, Logger } from '../types.ts';

/** The commit happened through the HTTP API; the conductor holds its result. */
const FULFILLED: CommitResult = { accepted: true, errors: [], warnings: [], sections: [] };

export function createExternalComposer(opts: { log: Logger }): Composer {
  const { log } = opts;
  return {
    driver: 'external',
    compose(request: PlanRequest, _tools: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome> {
      const outcome = (): ComposeOutcome => {
        const reason = String(signal.reason ?? 'aborted');
        return reason === 'fulfilled' ? { status: 'committed', result: FULFILLED, attempts: 1 } : { status: 'failed', reason, attempts: 0 };
      };
      if (signal.aborted) return Promise.resolve(outcome());
      log.info('external: waiting for a commit', {
        request: request.id,
        kind: request.kind,
        hint: `bside commit plan.json --request ${request.id}`,
      });
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            const result = outcome();
            if (result.status === 'failed') log.info('external: request closed without a commit', { request: request.id, reason: result.reason });
            resolve(result);
          },
          { once: true },
        );
      });
    },
  };
}
