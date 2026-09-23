// The Claude driver against a scripted stand-in for the SDK client: the tool loop, repairs,
// refusals, truncation, aborts, schema-invalid tool input, retries, request params and usage.
import { APIUserAbortError, AuthenticationError, BadRequestError, RateLimitError } from '@anthropic-ai/sdk';
import type { BetaContentBlock, BetaMessage, BetaMessageStreamParams, BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it } from 'vitest';
import { createClaudeComposer, type AnthropicLike } from '../../src/server/composer/claude.ts';
import type { AuditionInput, AuditionResult, CommitResult, PlanRequest } from '../../src/shared/composer-api.ts';
import type { Plan } from '../../src/shared/plan.ts';
import type { ComposerTools, ServerConfig } from '../../src/server/types.ts';
import { memoryLog, smallCatalog, turnContext } from './fixtures.ts';

type Step = BetaMessage | Error | 'hang';

interface Stub extends AnthropicLike {
  calls: BetaMessageStreamParams[];
  aborted: number;
}

function stubClient(steps: Step[]): Stub {
  const stub: Stub = {
    calls: [],
    aborted: 0,
    beta: {
      messages: {
        stream(body) {
          stub.calls.push(structuredClone(body));
          const step = steps.shift();
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

function setup(steps: Step[], opts: { commits?: CommitResult[]; config?: Partial<ServerConfig>; kind?: 'section' | 'movement' } = {}) {
  const client = stubClient(steps);
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
    expect(JSON.parse(results[0]!.content as string)).toMatchObject({ parts: [{ id: 'kick', ok: true, digest: { instrument: 'Synth kick' } }] });
    expect(JSON.stringify(second.messages[0])).not.toContain('cache_control');
    expect(t.log.lines.find((l) => l.msg === 'claude: compose finished')?.data).toMatchObject({ status: 'committed', calls: 2 });
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
});
