// The Claude driver (ARCHITECTURE §7.2): a manual tool loop over the streaming Messages API. One
// user message per plan (the TurnContext), a stable system prompt cached for an hour, two tools —
// `audition` and a strict `commit_plan` — and a bounded number of calls. Tool inputs are validated
// with zod before anything runs; every tool_use gets a tool_result in one user message; a rejected
// commit comes back as an error result so Claude repairs it.
import Anthropic, { APIConnectionError, APIError, APIUserAbortError, BadRequestError, InternalServerError, RateLimitError } from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTextBlockParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { z } from 'zod';
import type { Issue } from '../../shared/analysis.ts';
import type { AuditionResult, CommitResult, PlanRequest } from '../../shared/composer-api.ts';
import { AuditionInputSchema, PlanSchema, auditionToolSchema, planToolSchema } from '../../shared/plan.ts';
import type { Catalog, ComposeOutcome, Composer, ComposerTools, ComposerUsage, Logger, ServerConfig } from '../types.ts';
import { composerSystemPrompt, renderTurn } from './reference.ts';

/** The part of the SDK client the driver uses (tests inject a stub). */
export interface AnthropicLike {
  beta: {
    messages: {
      stream(body: BetaMessageStreamParams, options?: { signal?: AbortSignal | null; maxRetries?: number }): { finalMessage(): Promise<BetaMessage>; abort(): void };
    };
  };
}

export interface ClaudeComposerOptions {
  config: ServerConfig;
  catalog: Catalog;
  log: Logger;
  client?: AnthropicLike;
  /** Server clock (ms), the clock PlanRequest deadlines are in. */
  now?: () => number;
  /** Abortable wait between retries (tests shorten it). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const AUDITION_TOOL = 'audition';
const COMMIT_TOOL = 'commit_plan';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;
const MAX_TRUNCATIONS = 2;

const AUDITION_DESCRIPTION =
  'Try parts before committing them. Each part is validated against the room\'s allowlist, evaluated, and analysed with the ' +
  'others over `bars` (default 16) at `bpm` in `scale`, all playing from bar 0. Returns per-part errors and warnings (with ' +
  'line, column, excerpt and a fix hint) and a digest (events per bar, register, syncopation, brightness, loudness, period, ' +
  'key fit), plus the mix\'s measured descriptors. Use it for any new or uncertain code; it changes nothing in the room.';

const COMMIT_DESCRIPTION =
  'Commit your Plan: the next 1–2 sections, plus a new movement, fork, request decisions and motifs when relevant. The ' +
  'conductor checks everything and either schedules it or returns every issue to fix. Call it once with the complete plan; ' +
  'call it again only with a corrected complete plan after a rejection. An accepted commit ends your turn.';

const NUDGE_COMMIT = 'You have not committed yet. Finish now by calling commit_plan with your complete plan.';
const NUDGE_TRUNCATED =
  'Your last reply ran out of room before the tool call finished. Keep thinking brief and commit a leaner plan now ' +
  '(fewer parts or shorter code) by calling commit_plan.';

const serverNow = () => performance.timeOrigin + performance.now();

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const isRetryable = (e: unknown) =>
  e instanceof RateLimitError ||
  e instanceof InternalServerError ||
  (e instanceof APIConnectionError && !(e instanceof APIUserAbortError)) ||
  (e instanceof APIError && (e.status === 408 || e.status === 409));

function retryAfterMs(e: unknown): number | null {
  if (!(e instanceof APIError) || !e.headers) return null;
  const ms = Number(e.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(e.headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

const brief = (i: Issue) => ({
  rule: i.rule,
  message: i.message,
  ...(i.path ? { path: i.path } : {}),
  ...(i.line ? { line: i.line, column: i.column } : {}),
  ...(i.excerpt ? { excerpt: i.excerpt } : {}),
  ...(i.hint ? { hint: i.hint } : {}),
});

/** Audition results without the heavy per-onset analysis (the digest carries what matters). */
export function auditionReport(r: AuditionResult): string {
  return JSON.stringify({
    parts: r.parts.map((p) => ({ id: p.id, ok: p.ok, errors: p.errors.map(brief), warnings: p.warnings.map(brief), digest: p.digest })),
    mix: r.mix ? { descriptors: r.mix.descriptors, spans: r.mix.spans, onsetsPerBar: r.mix.onsetsPerBar, peakOverlapGain: r.mix.peakOverlapGain } : null,
  });
}

function issueLines(issues: readonly Issue[]): string[] {
  return issues.map((i) => {
    const where = [i.path, i.line ? `line ${i.line}, column ${i.column}` : null].filter(Boolean).join(', ');
    const lines = [`- [${i.rule}]${where ? ` ${where}:` : ''} ${i.message}`];
    if (i.excerpt) lines.push(...i.excerpt.split('\n').map((l) => `    ${l}`));
    if (i.hint) lines.push(`    hint: ${i.hint}`);
    return lines.join('\n');
  });
}

export function rejectionReport(r: CommitResult): string {
  const out = ['Rejected. Fix these and call commit_plan again with the complete corrected plan:', ...issueLines(r.errors)];
  if (r.warnings.length) out.push('Warnings (not blocking):', ...issueLines(r.warnings.slice(0, 8)));
  return out.join('\n');
}

function schemaReport(error: z.ZodError): string {
  const issues = error.issues.slice(0, 12).map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`);
  return ['The tool input does not match the schema:', ...issues].join('\n');
}

/** Messages with a cache breakpoint on the newest user turn only (at most 4 breakpoints per request). */
function withBreakpoint(messages: readonly BetaMessageParam[]): BetaMessageParam[] {
  return messages.map((m, i) => {
    if (i !== messages.length - 1 || m.role !== 'user' || typeof m.content === 'string') return m;
    const content = m.content.map((b, j) => (j === m.content.length - 1 ? ({ ...b, cache_control: { type: 'ephemeral' } } as BetaContentBlockParam) : b));
    return { ...m, content };
  });
}

class Aborted extends Error {}

export function createClaudeComposer(opts: ClaudeComposerOptions): Composer {
  const { config, catalog, log } = opts;
  const client: AnthropicLike = opts.client ?? new Anthropic({ maxRetries: 0 });
  const now = opts.now ?? serverNow;
  const sleep = opts.sleep ?? abortableSleep;
  const system: BetaTextBlockParam[] = [{ type: 'text', text: composerSystemPrompt(catalog), cache_control: { type: 'ephemeral', ttl: '1h' } }];
  // Only commit_plan is strict: strict schemas share a server-side budget of union-typed parameters,
  // and the Plan alone uses most of it.
  const toolsFor = (strictCommit: boolean): BetaTool[] => [
    { name: AUDITION_TOOL, description: AUDITION_DESCRIPTION, input_schema: auditionToolSchema() as BetaTool.InputSchema },
    { name: COMMIT_TOOL, description: COMMIT_DESCRIPTION, input_schema: planToolSchema() as BetaTool.InputSchema, strict: strictCommit },
  ];
  let strict = true;
  let tools = toolsFor(strict);
  const fallbacks = /^claude-(opus-5|fable-5)/.test(config.model);

  async function callOnce(params: BetaMessageStreamParams, signal: AbortSignal): Promise<BetaMessage> {
    const stream = client.beta.messages.stream(params, { signal, maxRetries: 0 });
    const onAbort = () => stream.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await stream.finalMessage();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** One Messages call, retried with backoff on rate limits, overload and connection errors. */
  async function call(params: BetaMessageStreamParams, signal: AbortSignal, deadlineMs: number): Promise<BetaMessage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await callOnce(params, signal);
      } catch (e) {
        if (signal.aborted) throw new Aborted(String(signal.reason ?? 'aborted'));
        const wait = retryAfterMs(e) ?? RETRY_BASE_MS * 2 ** attempt * (1 + Math.random() * 0.25);
        if (!isRetryable(e) || attempt >= MAX_RETRIES || now() + wait >= deadlineMs) throw e;
        log.warn('claude: retrying after an API error', { attempt: attempt + 1, waitMs: Math.round(wait), error: (e as Error).message });
        try {
          await sleep(wait, signal);
        } catch {
          throw new Aborted(String(signal.reason ?? 'aborted'));
        }
      }
    }
  }

  return {
    driver: 'claude',

    async compose(request: PlanRequest, tools_: ComposerTools, signal: AbortSignal): Promise<ComposeOutcome> {
      const started = now();
      const usage: ComposerUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, ms: 0 };
      let attempts = 0;
      const done = (outcome: { status: 'failed'; reason: string } | { status: 'committed'; result: CommitResult }): ComposeOutcome => {
        usage.ms = Math.round(now() - started);
        log.info('claude: compose finished', { request: request.id, status: outcome.status, attempts, ...usage, ...(outcome.status === 'failed' ? { reason: outcome.reason } : {}) });
        return { ...outcome, attempts, usage };
      };
      if (signal.aborted) return done({ status: 'failed', reason: `aborted: ${String(signal.reason)}` });

      const effort = request.kind === 'movement' ? config.effort.movement : config.effort.section;
      const messages: BetaMessageParam[] = [{ role: 'user', content: [{ type: 'text', text: renderTurn(request.context) }] }];
      const nudge = (text: string) => {
        const last = messages[messages.length - 1]!;
        if (last.role === 'user' && Array.isArray(last.content)) last.content.push({ type: 'text', text });
        else messages.push({ role: 'user', content: [{ type: 'text', text }] });
      };
      let truncations = 0;

      while (usage.calls < config.maxApiCallsPerPlan) {
        const params: BetaMessageStreamParams = {
          model: config.model,
          max_tokens: effort === 'xhigh' ? 64000 : 32000,
          system,
          tools,
          tool_choice: { type: 'auto' },
          thinking: { type: 'adaptive' },
          output_config: { effort },
          messages: withBreakpoint(messages),
          ...(fallbacks ? { fallbacks: 'default' as const, betas: [FALLBACK_BETA] } : {}),
        };
        let message: BetaMessage;
        try {
          usage.calls++;
          message = await call(params, signal, request.hardDeadlineMs);
        } catch (e) {
          if (e instanceof Aborted || signal.aborted) return done({ status: 'failed', reason: `aborted: ${String(signal.reason ?? (e as Error).message)}` });
          // Inputs are zod-validated anyway, so a refused strict schema costs only the grammar
          // guarantee, for the rest of this composer's life.
          if (e instanceof BadRequestError && strict && /strict|schema|grammar|union|complex/i.test(e.message)) {
            log.warn('claude: strict tool schema refused; continuing without strict', { request: request.id, error: e.message });
            strict = false;
            tools = toolsFor(strict);
            continue;
          }
          const status = e instanceof APIError ? ` (${e.status ?? 'network'})` : '';
          log.error('claude: API call failed', { request: request.id, error: (e as Error).message });
          return done({ status: 'failed', reason: `api error${status}: ${(e as Error).message}` });
        }
        usage.inputTokens += message.usage.input_tokens;
        usage.outputTokens += message.usage.output_tokens;
        usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
        if (message.content.some((b) => b.type === 'fallback')) log.warn('claude: a fallback model served this turn', { request: request.id, model: message.model });

        const uses = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use');
        switch (message.stop_reason) {
          case 'refusal':
            return done({ status: 'failed', reason: `refusal (${message.stop_details?.category ?? 'unspecified'})` });
          case 'max_tokens':
            if (++truncations > MAX_TRUNCATIONS) return done({ status: 'failed', reason: 'max_tokens: the reply was cut off repeatedly' });
            // A cut-off tool_use can't be answered, so the truncated turn is dropped rather than kept.
            if (uses.length) nudge(NUDGE_TRUNCATED);
            else {
              messages.push({ role: 'assistant', content: message.content });
              nudge(NUDGE_COMMIT);
            }
            continue;
          case 'pause_turn':
            messages.push({ role: 'assistant', content: message.content });
            continue;
          case 'tool_use':
            break;
          case 'end_turn':
          case 'stop_sequence':
            if (!uses.length) {
              messages.push({ role: 'assistant', content: message.content });
              nudge(NUDGE_COMMIT);
              continue;
            }
            break;
          default:
            return done({ status: 'failed', reason: `stopped: ${message.stop_reason ?? 'unknown'}` });
        }

        const results: BetaToolResultBlockParam[] = [];
        for (const use of uses) {
          if (signal.aborted) return done({ status: 'failed', reason: `aborted: ${String(signal.reason)}` });
          if (use.name === AUDITION_TOOL) {
            const input = AuditionInputSchema.safeParse(use.input);
            if (!input.success) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: schemaReport(input.error) });
              continue;
            }
            try {
              results.push({ type: 'tool_result', tool_use_id: use.id, content: auditionReport(await tools_.audition(input.data)) });
            } catch (e) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Audition failed: ${(e as Error).message}` });
            }
          } else if (use.name === COMMIT_TOOL) {
            const plan = PlanSchema.safeParse(use.input);
            if (!plan.success) {
              results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: schemaReport(plan.error) });
              continue;
            }
            attempts++;
            const result = await tools_.commit(plan.data);
            if (result.accepted) {
              if (result.warnings.length) log.info('claude: accepted with warnings', { request: request.id, warnings: result.warnings.map((w) => w.rule) });
              return done({ status: 'committed', result });
            }
            if (result.errors.some((e) => e.rule === 'request-closed')) return done({ status: 'failed', reason: 'request-closed' });
            log.info('claude: commit rejected; asking for a repair', { request: request.id, errors: result.errors.map((e) => `${e.rule} ${e.path ?? ''}`) });
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: rejectionReport(result) });
          } else {
            results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool "${use.name}". Use ${AUDITION_TOOL} or ${COMMIT_TOOL}.` });
          }
        }
        messages.push({ role: 'assistant', content: message.content });
        messages.push({ role: 'user', content: results });
      }
      return done({ status: 'failed', reason: `no accepted commit within ${config.maxApiCallsPerPlan} API calls` });
    },
  };
}
