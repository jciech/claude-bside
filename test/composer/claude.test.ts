// The Claude driver against a scripted stand-in for the SDK client: the tool loop, repairs,
// refusals, truncation, aborts, schema-invalid tool input, retries, request params and usage. Errors
// that arrive mid-stream are pinned against the real SDK client over a fake fetch.
import Anthropic, { APIUserAbortError, AuthenticationError, BadRequestError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageParam, BetaMessageStreamParams, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { auditionReport, createClaudeComposer, type AnthropicLike } from '../../src/server/composer/claude.ts';
import type { AuditionInput, AuditionResult, CommitResult, PlanRequest } from '../../src/shared/composer-api.ts';
import type { Plan } from '../../src/shared/plan.ts';
import type { ComposerTools, ServerConfig } from '../../src/server/types.ts';
import { memoryLog, smallCatalog, turnContext } from './fixtures.ts';

type Step = BetaMessage | Error | 'hang';

interface Stub extends AnthropicLike {
  calls: BetaMessageStreamParams[];
  aborted: number;
}

// The API's own content rules; a request that breaks them is refused before anything streams.
const blank = (m: BetaMessageParam) => Array.isArray(m.content) && (m.content.length === 0 || m.content.some((b) => b.type === 'text' && !b.text.trim()));
const emptyContentError = (index: number) => {
  const message = `messages.${index}: all messages must have non-empty content except for the optional final assistant message`;
  return new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message } }, message, new Headers());
};

function stubClient(steps: Step[]): Stub {
  const stub: Stub = {
    calls: [],
    aborted: 0,
    beta: {
      messages: {
        stream(body) {
          stub.calls.push(structuredClone(body));
          const empty = body.messages.findIndex((m, i) => i < body.messages.length - 1 && blank(m));
          const step = empty >= 0 ? emptyContentError(empty) : steps.shift();
          let reject: (e: unknown) => void = () => {};
          const final = new Promise<BetaMessage>((res, rej) => {
            reject = rej;
            if (step === undefined) rej(new Error('stub: no more steps'));
            else if (step instanceof Error) rej(step);
            else if (step !== 'hang') res(step);
          });
          return {
            finalMessage: () => final,
            abort: () => {
              stub.aborted++;
              reject(new APIUserAbortError());
            },
          };
        },
      },
    },
  };
  return stub;
}

let ids = 0;
function message(stop: BetaMessage['stop_reason'], content: unknown[], extra: Partial<BetaMessage> = {}): BetaMessage {
  return {
    id: `msg_${++ids}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: content as BetaContentBlock[],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 10, server_tool_use: null, service_tier: null } as never,
    ...extra,
  } as BetaMessage;
}

const toolUse = (name: string, input: unknown, id = `toolu_${++ids}`) => ({ type: 'tool_use', id, name, input });

const plan: Plan = {
  sections: [
    {
      name: 'Tide Line',
      role: 'groove',
      bars: 16,
      bpm: 120,
      tempoRampBars: 0,
      tempoRampAt: 'start',
      scale: 'D:dorian',
      chords: null,
      targets: { intensity: { start: 0.5, end: 0.5 }, brightness: { start: 0.5, end: 0.5 }, density: { start: 0.5, end: 0.5 }, tension: { start: 0.3, end: 0.3 } },
      transitionIn: { type: 'cut', bars: 0 },
      parts: [{ id: 'kick', role: 'kick', code: 's("sbd*4")', restart: false, chromatic: false, level: 0.8, enterBar: 0, exitBar: null, knobs: [], automation: [], duck: null }],
      reprise: null,
      publicNote: 'A steady tide.',
    },
  ],
  movement: null,
  fork: null,
  requestDecisions: [],
  motifs: [],
  announcement: null,
  rationale: 'keep it simple',
};

const audition: AuditionInput = { parts: [{ id: 'kick', role: 'kick', code: 's("sbd*4")', knobs: [], chromatic: false }], bpm: 120, scale: null, bars: null };
const auditionResult: AuditionResult = {
  ok: true,
  errors: [],
  warnings: [],
  parts: [{ id: 'kick', role: 'kick', ok: true, errors: [], warnings: [], analysis: null, digest: { id: 'kick', role: 'kick', instrument: 'Synth kick', evPerBar: 4, register: null, sync: 0, bright: 0.2, loud: 0.7, period: 1, keyFit: null } }],
  mix: null,
  descriptors: null,
};
const accepted: CommitResult = { accepted: true, errors: [], warnings: [], sections: [{ id: 'ep1-0002', name: 'Tide Line', startCycle: 20, bars: 16 }] };
const rejected: CommitResult = {
  accepted: false,
  errors: [{ severity: 'error', rule: 'unknown-method', message: 'Unknown Strudel method .reverb().', path: 'sections[0].parts[0] (kick)', line: 1, column: 10, excerpt: 's("sbd").reverb(1)\n         ^', hint: 'Did you mean .room()?' }],
  warnings: [],
  sections: [],
};

const config: ServerConfig = {
  port: 0,
  dev: true,
  dataDir: '/nonexistent',
  catalogPath: '',
  driver: 'claude',
  model: 'claude-opus-5',
  effort: { section: 'medium', movement: 'high' },
  maxPlansPerHour: 90,
  maxApiCallsPerPlan: 8,
  adminToken: null,
  secret: 'x',
  trustProxy: 0,
  ipv6Prefix: 48,
  maxSocketsPerNetwork: 8,
  sourceUrl: 'https://example.invalid',
};

interface SetupOptions {
  commits?: CommitResult[];
  config?: Partial<ServerConfig>;
  kind?: 'section' | 'movement';
}

const setup = (steps: Step[], opts: SetupOptions = {}) => harness(stubClient(steps), opts);

function harness<C extends AnthropicLike>(client: C, opts: SetupOptions = {}) {
  const log = memoryLog();
  const sleeps: number[] = [];
  const composer = createClaudeComposer({
    config: { ...config, ...opts.config },
    catalog: smallCatalog,
    log,
    client,
    now: () => 1000,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const commits: Plan[] = [];
  const auditions: AuditionInput[] = [];
  const results = [...(opts.commits ?? [accepted])];
  const request: PlanRequest = { id: 'ep1-r3', kind: opts.kind ?? 'section', createdAt: 0, softDeadlineMs: 40_000, hardDeadlineMs: 60_000, targetCycle: 20, scheduleRev: 2, context: turnContext({ kind: opts.kind }) };
  const tools: ComposerTools = {
    request,
    audition: async (input) => {
      auditions.push(input);
      return auditionResult;
    },
    commit: async (p) => {
      commits.push(p);
      return results.shift() ?? accepted;
    },
  };
  return { client, log, sleeps, composer, commits, auditions, request, tools };
}

const toolResults = (params: BetaMessageStreamParams) => {
  const last = params.messages[params.messages.length - 1]!;
  return (last.content as BetaToolResultBlockParam[]).filter((b) => b.type === 'tool_result');
};

const sse = (data: { type: string; [field: string]: unknown }) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const messageStart = sse({
  type: 'message_start',
  message: { id: 'msg_sse', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } },
});
const commitStream = [
  messageStart,
  sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_sse', name: 'commit_plan', input: {} } }),
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(plan) } }),
  sse({ type: 'content_block_stop', index: 0 }),
  sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 50 } }),
  sse({ type: 'message_stop' }),
].join('');
const streamError = (type: string) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type, message: type } })}\n\n`;

/** A 200 event stream that sends `text`, then ends cleanly or breaks with `failure`. */
function sseResponse(text: string, failure?: Error): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(text));
      } else if (failure) controller.error(failure);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
}

/** The real SDK client over a fake fetch that answers each request with the next response. */
function sdkSetup(responses: (() => Response)[], opts: SetupOptions = {}) {
  const fetches: string[] = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (url) => {
      fetches.push(String(url));
      const next = responses.shift();
      if (!next) throw new Error('fake fetch: no more responses');
      return next();
    },
  });
  return { ...harness(client, opts), fetches };
}

// What undici raises when the connection drops while the body is being read.
const terminated = () => new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

describe('the Claude driver', () => {
  it('auditions, commits and reports usage (happy path), with the right request shape', async () => {
    const t = setup([message('tool_use', [{ type: 'text', text: 'Trying the kick.' }, toolUse('audition', audition)]), message('tool_use', [toolUse('commit_plan', plan)])]);
    const outcome = await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'committed', result: accepted, attempts: 1, usage: { calls: 2, inputTokens: 200, outputTokens: 100, cacheReadTokens: 18000, cacheWriteTokens: 20 } });
    expect(t.auditions).toEqual([audition]);
    expect(t.commits).toEqual([plan]);

    const [first, second] = t.client.calls as [BetaMessageStreamParams, BetaMessageStreamParams];
    expect(first).toMatchObject({
      model: 'claude-opus-5',
      tool_choice: { type: 'auto' },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      betas: ['server-side-fallback-2026-07-01'],
    });
    expect(first).not.toHaveProperty('temperature');
    expect(first.system).toEqual([expect.objectContaining({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } })]);
    expect((first.system as { text: string }[])[0]!.text).toContain('# Strudel reference card');
    expect(first.tools!.map((x) => ({ name: (x as { name: string }).name, strict: (x as { strict?: boolean }).strict }))).toEqual([
      { name: 'audition', strict: undefined },
      { name: 'commit_plan', strict: true },
    ]);
    expect(first.messages).toHaveLength(1);
    expect(JSON.stringify(first.messages[0])).toContain('<turn_context>');
    // Second call: the assistant turn is echoed, all tool results come back in one user message, and
    // only the newest user turn carries a cache breakpoint.
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = toolResults(second);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
    expect(results[0]).not.toHaveProperty('is_error');
    expect(JSON.parse(results[0]!.content as string)).toMatchObject({ ok: true, parts: [{ id: 'kick', ok: true, digest: { instrument: 'Synth kick' } }] });
    expect(JSON.parse(results[0]!.content as string)).not.toHaveProperty('errors');
    expect(JSON.stringify(second.messages[0])).not.toContain('cache_control');
    expect(t.log.lines.find((l) => l.msg === 'claude: compose finished')?.data).toMatchObject({ status: 'committed', calls: 2 });
  });

  it('reports section-level audition issues, and an audition that fails only there as not ok', () => {
    const scale = { severity: 'error' as const, rule: 'scale', message: 'Unknown scale "D:dorain".', path: 'scale', hint: 'Did you mean "D:dorian"?' };
    const report = JSON.parse(auditionReport({ ...auditionResult, ok: false, errors: [scale] }));
    expect(report).toMatchObject({ ok: false, errors: [{ rule: 'scale', path: 'scale', hint: 'Did you mean "D:dorian"?' }], parts: [{ id: 'kick', ok: true, errors: [] }] });
    expect(report.errors[0]).not.toHaveProperty('severity');
  });

  it('asks Claude to repair a rejected commit, with every issue, and succeeds on the second try', async () => {
    const t = setup([message('tool_use', [toolUse('commit_plan', plan)]), message('tool_use', [toolUse('commit_plan', plan)])], { commits: [rejected, accepted] });
    const outcome = await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'committed', attempts: 2 });
    const [result] = toolResults(t.client.calls[1]!);
    expect(result!.is_error).toBe(true);
    expect(result!.content).toContain('[unknown-method] sections[0].parts[0] (kick), line 1, column 10: Unknown Strudel method .reverb().');
    expect(result!.content).toContain('hint: Did you mean .room()?');
    expect(result!.content).toContain('s("sbd").reverb(1)');
  });

  it('stops when the request is closed', async () => {
    const closed: CommitResult = { accepted: false, errors: [{ severity: 'error', rule: 'request-closed', message: 'closed' }], warnings: [], sections: [] };
    const t = setup([message('tool_use', [toolUse('commit_plan', plan)]), message('tool_use', [toolUse('commit_plan', plan)])], { commits: [closed] });
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: 'request-closed', attempts: 1 });
    expect(t.client.calls).toHaveLength(1);
  });

  it('gives up on a refusal without retrying', async () => {
    const t = setup([message('refusal', [], { stop_details: { type: 'refusal', category: 'cyber', explanation: null } as never })]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: 'refusal (cyber)', attempts: 0 });
    expect(t.client.calls).toHaveLength(1);
  });

  it('never runs a tool call cut off by max_tokens; it asks for a leaner plan instead', async () => {
    const t = setup([message('max_tokens', [toolUse('commit_plan', { sections: [] })]), message('tool_use', [toolUse('commit_plan', plan)])]);
    const outcome = await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'committed', attempts: 1 });
    expect(t.commits).toEqual([plan]);
    const retry = t.client.calls[1]!;
    expect(retry.messages.map((m) => m.role)).toEqual(['user']);
    expect(JSON.stringify(retry.messages[0])).toContain('ran out of room');
  });

  it('fails after repeated truncation', async () => {
    const cut = () => message('max_tokens', [toolUse('commit_plan', {})]);
    const t = setup([cut(), cut(), cut()]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: expect.stringContaining('max_tokens') });
  });

  it('aborts mid-stream when the signal fires', async () => {
    const t = setup(['hang']);
    const controller = new AbortController();
    const pending = t.composer.compose(t.request, t.tools, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort('deadline');
    expect(await pending).toMatchObject({ status: 'failed', reason: 'aborted: deadline', attempts: 0, usage: { calls: 1 } });
    expect(t.client.aborted).toBe(1);
  });

  it('answers schema-invalid tool input with an error result and never runs the tool', async () => {
    const bad = { ...plan, sections: [{ ...plan.sections[0], bars: 17 }] };
    const t = setup([message('tool_use', [toolUse('commit_plan', bad), toolUse('audition', { parts: [] })]), message('tool_use', [toolUse('commit_plan', plan)])]);
    const outcome = await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(outcome).toMatchObject({ status: 'committed', attempts: 1 });
    expect(t.commits).toEqual([plan]);
    expect(t.auditions).toEqual([]);
    const results = toolResults(t.client.calls[1]!);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.is_error)).toBe(true);
    expect(results[0]!.content).toContain('sections.0.bars');
  });

  it('retries rate limits with the server\'s retry-after, and fails fast on auth errors', async () => {
    const limited = new RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '2' }));
    const t = setup([limited, message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed', usage: { calls: 1 } });
    expect(t.sleeps).toEqual([2000]);
    expect(t.client.calls).toHaveLength(2);

    const auth = new AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 'bad key', new Headers());
    const u = setup([auth]);
    expect(await u.composer.compose(u.request, u.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: expect.stringContaining('api error (401)') });
    expect(u.sleeps).toEqual([]);
  });

  it('drops strict mode for good when the API refuses the strict schema, and fails on other bad requests', async () => {
    const tooComplex = () => new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Schema is too complex for strict mode' } }, 'Schema is too complex for strict mode', new Headers());
    const t = setup([tooComplex(), message('tool_use', [toolUse('commit_plan', plan)]), message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed', usage: { calls: 2 } });
    expect(t.client.calls.map((c) => c.tools!.map((tool) => (tool as { strict?: boolean }).strict))).toEqual([[undefined, true], [undefined, false]]);
    expect(t.log.lines.some((l) => l.msg.includes('continuing without strict'))).toBe(true);
    await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(t.client.calls[2]!.tools!.map((tool) => (tool as { strict?: boolean }).strict)).toEqual([undefined, false]);

    const other = new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: text content blocks must be non-empty' } }, 'messages: text content blocks must be non-empty', new Headers());
    const u = setup([other]);
    expect(await u.composer.compose(u.request, u.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: expect.stringContaining('api error (400)') });
    expect(u.client.calls).toHaveLength(1);
  });

  it('nudges Claude to commit when a turn ends without one, within the call budget', async () => {
    const t = setup([message('end_turn', [{ type: 'text', text: 'Here is my idea…' }]), message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed' });
    expect(JSON.stringify(t.client.calls[1]!.messages.at(-1))).toContain('You have not committed yet');

    const auditionOnly = () => message('tool_use', [toolUse('audition', audition)]);
    const u = setup([auditionOnly(), auditionOnly(), auditionOnly()], { config: { maxApiCallsPerPlan: 2 } });
    expect(await u.composer.compose(u.request, u.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: 'no accepted commit within 2 API calls', usage: { calls: 2 } });
  });

  it('thinks harder for movements, and only opts into fallbacks on models that have them', async () => {
    const t = setup([message('tool_use', [toolUse('commit_plan', plan)])], { kind: 'movement', config: { model: 'claude-sonnet-5', effort: { section: 'low', movement: 'xhigh' } } });
    await t.composer.compose(t.request, t.tools, new AbortController().signal);
    expect(t.client.calls[0]).toMatchObject({ model: 'claude-sonnet-5', output_config: { effort: 'xhigh' }, max_tokens: 64000 });
    expect(t.client.calls[0]).not.toHaveProperty('fallbacks');
    expect(t.client.calls[0]).not.toHaveProperty('betas');
  });

  it('resumes a paused turn by sending the assistant content back', async () => {
    const t = setup([message('pause_turn', [{ type: 'text', text: '…' }]), message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed' });
    expect(t.client.calls[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('never echoes an empty reply back; it nudges in the user turn instead', async () => {
    const t = setup([message('tool_use', [toolUse('audition', audition)]), message('end_turn', []), message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed', attempts: 1, usage: { calls: 3 } });
    const third = t.client.calls[2]!;
    expect(third.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(toolResults(third)).toHaveLength(1);
    const last = third.messages.at(-1)!.content as { type: string; text?: string }[];
    expect(last.at(-1)).toMatchObject({ type: 'text', text: expect.stringContaining('You have not committed yet') });

    // The same at the very first call, and for a reply that is only blank text.
    const u = setup([message('end_turn', [{ type: 'text', text: ' ' }]), message('end_turn', []), message('tool_use', [toolUse('commit_plan', plan)])]);
    expect(await u.composer.compose(u.request, u.tools, new AbortController().signal)).toMatchObject({ status: 'committed' });
    expect(u.client.calls[2]!.messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('the Claude driver, when the stream breaks after the 200 (real SDK client)', () => {
  it('retries an overloaded_error event sent mid-stream', async () => {
    const t = sdkSetup([() => sseResponse(messageStart + streamError('overloaded_error')), () => sseResponse(commitStream)]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed', attempts: 1, usage: { calls: 1 } });
    expect(t.fetches).toHaveLength(2);
    expect(t.sleeps).toHaveLength(1);
    expect(t.commits).toEqual([plan]);
  });

  it('retries a connection dropped while the body streams in, or a stream that ends early', async () => {
    const t = sdkSetup([() => sseResponse(messageStart, terminated()), () => sseResponse(messageStart), () => sseResponse(commitStream)]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'committed', usage: { calls: 1 } });
    expect(t.fetches).toHaveLength(3);
    expect(t.sleeps).toHaveLength(2);
    const retried = t.log.lines.filter((l) => l.msg === 'claude: retrying after an API error').map((l) => l.data?.error);
    expect(retried).toEqual(['terminated', expect.stringContaining('stream ended without producing a Message')]);
  });

  it('does not retry an error event that says the request itself is wrong, nor past the deadline', async () => {
    const t = sdkSetup([() => sseResponse(messageStart + streamError('invalid_request_error')), () => sseResponse(commitStream)]);
    expect(await t.composer.compose(t.request, t.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: expect.stringContaining('api error (invalid_request_error)') });
    expect(t.fetches).toHaveLength(1);
    expect(t.sleeps).toEqual([]);

    const u = sdkSetup([() => sseResponse(messageStart, terminated()), () => sseResponse(commitStream)]);
    const late = { ...u.request, hardDeadlineMs: 1500 };
    expect(await u.composer.compose(late, u.tools, new AbortController().signal)).toMatchObject({ status: 'failed', reason: expect.stringContaining('terminated') });
    expect(u.fetches).toHaveLength(1);
  });
});
