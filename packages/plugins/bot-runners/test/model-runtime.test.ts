import { RunEndedError } from '@manythreads/sdk';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope, ModelMessage, ModelTurnRequest, ModelTurnResult, PluginContext } from '@manythreads/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `model` bot runtime is a loop: ask the runner's alias, call the tool the model asks for through the MCP door, give the answer back, stop at the first turn with no tool call or at the
// step limit. Everything it needs from outside (the model call, the tool door, the runner lookup) is a stub here, so the loop is tested alone; the end-to-end run (spend under the bot, the reply in
// the thread) is in the runtime-hermes `model-run` test.

const resolveRunner = vi.fn();
vi.mock('../src/resolve.ts', () => ({ resolveRunner: (...args: unknown[]) => resolveRunner(...args) }));

const { createModelRuntime, DEFAULT_STEP_LIMIT, MAX_TOOL_ANSWER_CHARS, MAX_TOOL_CALLS_PER_RUN, MAX_TOOL_CALLS_PER_TURN, systemTextOf, wireNames } = await import('../src/model-runtime.ts');

const READY = { ok: true, target: { runner: 'brain-model', label: 'Brain model', kind: 'llm_gateway', status: 'ready', modelAlias: 'smart', address: null, key: null, agent: 'hermes', guard: false, profileRule: '{bot}' } };

const input = (over: { runner?: string | null; body?: string; maxTurns?: number | null; runBudgetSeconds?: number | null } = {}): BotRuntimeInput => {
  const runner = over.runner === undefined ? 'brain-model' : over.runner;
  return {
    bot: { id: 'b1', slug: 'brain', name: 'Brain', teamId: 't1', workspaceId: 'w1', runtime: 'hermes', definitionSha: 'x' },
    definition: { frontmatter: { name: 'Brain', ...(runner === null ? {} : { placement: { runs_on: runner } }) } as never, body: over.body ?? 'You answer from the team notes.' },
    trigger: 'mention',
    asker: null,
    prompt: 'What did we decide about pricing?',
    thread: null,
    endpoint: null,
    gateway: null,
    limits: { runBudgetSeconds: over.runBudgetSeconds ?? null, maxTurns: over.maxTurns ?? null, sessionMinutes: null },
  };
};

const ctx = {} as PluginContext;

type Said = { ok: true; text: string | null; toolCalls: Array<{ id: string; name: string; arguments: string }>; promptTokens: number; completionTokens: number; truncated?: boolean } | { ok: false; reason: 'refused' | 'unbound' | 'unavailable' | 'timeout'; detail: string };

/**
 * The model's answers in order; the last one repeats. The requests it was sent are kept for assertions. Like the real gateway it hands the history back (with `redact` applied to the messages
 * not checked on an earlier turn), and the loop is meant to carry on with that copy.
 */
function scriptedModel(answers: Said[], redact: (text: string) => string = (t) => t): { turn: (r: ModelTurnRequest) => Promise<ModelTurnResult>; requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = [];
  return {
    requests,
    turn: async (request) => {
      // Keep a copy: the loop keeps appending to the same message array.
      requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) as ModelMessage[] });
      const said = answers[Math.min(requests.length - 1, answers.length - 1)]!;
      if (!said.ok) return said;
      const messages = request.messages.map((m, i) => (i >= request.checkedUpTo && (m.role === 'user' || m.role === 'tool') ? { ...m, content: redact(m.content ?? '') } : { ...m })) as ModelMessage[];
      return { ...said, truncated: said.truncated ?? false, messages };
    },
  };
}

const text = (t: string, tokens = 10): Said => ({ ok: true, text: t, toolCalls: [], promptTokens: tokens, completionTokens: 5 });
const call = (name: string, args: unknown, id = 'c1'): Said => ({ ok: true, text: null, toolCalls: [{ id, name, arguments: JSON.stringify(args) }], promptTokens: 20, completionTokens: 8 });
const calls = (names: string[], prefix = 'c'): Said => ({ ok: true, text: null, toolCalls: names.map((name, i) => ({ id: `${prefix}${String(i + 1)}`, name, arguments: '{}' })), promptTokens: 20, completionTokens: 8 });

async function drain(i: BotRuntimeInput, scope: Partial<BotRuntimeScope>): Promise<BotRuntimeEvent[]> {
  const runtime = createModelRuntime(ctx);
  const handle = await runtime.run(i, { invoke: async () => ({}), logSource: async () => 1, log: () => undefined, ...scope });
  const out: BotRuntimeEvent[] = [];
  for await (const e of handle.events) out.push(e);
  return out;
}
const resultOf = (events: BotRuntimeEvent[]): Extract<BotRuntimeEvent, { type: 'result' }> => events.find((e): e is Extract<BotRuntimeEvent, { type: 'result' }> => e.type === 'result')!;

beforeEach(() => {
  resolveRunner.mockReset();
  resolveRunner.mockResolvedValue(READY);
});

describe('the model runtime', () => {
  it('is the provider called "model", gated, with no gateway address of its own', () => {
    const runtime = createModelRuntime(ctx);
    expect(runtime.id).toBe('model');
    expect(runtime.gated).toBe(true);
    expect(runtime.usesGateway).toBeFalsy();
  });

  it('answers a question that needs no tool in one turn, with BOT.md body as the system text', async () => {
    const model = scriptedModel([text('We chose per-seat pricing.')]);
    const events = await drain(input(), { model });
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'We chose per-seat pricing.', tokens: { input: 10, output: 5, total: 15 } });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({ alias: 'smart', firstTurn: true });
    expect(model.requests[0]!.messages[0]).toEqual({ role: 'system', content: 'You answer from the team notes.' });
    expect(model.requests[0]!.messages[1]).toEqual({ role: 'user', content: 'What did we decide about pricing?' });
  });

  it('names the bot in one line when BOT.md has no body', () => {
    expect(systemTextOf(input({ body: '   ' }))).toBe('You are Brain, a bot of a team on manythreads.');
  });

  it('calls the tool the model asks for through the tool door and uses the result in the next turn', async () => {
    const model = scriptedModel([call('brain_search', { query: 'pricing' }), text('Per-seat, decided on the 3rd.')]);
    const made: Array<{ name: string; args: Record<string, unknown> }> = [];
    const tools = {
      list: async () => [{ name: 'brain.search', description: 'Search the notes', inputSchema: { type: 'object' } }],
      call: async (name: string, args: Record<string, unknown>) => {
        made.push({ name, args });
        return { text: 'Note: pricing is per seat (3rd).', isError: false };
      },
    };
    const events = await drain(input(), { model, tools });
    expect(made).toEqual([{ name: 'brain.search', args: { query: 'pricing' } }]);
    expect(events.map((e) => e.type)).toEqual(['tool', 'tool_result', 'result']);
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'Per-seat, decided on the 3rd.', tokens: { input: 30, output: 13, total: 43 } });
    // The first turn was offered the tools; the second turn carries the assistant's call and the tool's answer, and is not a new request against the rate limit.
    expect(model.requests[0]!.tools).toHaveLength(1);
    expect(model.requests[1]!.firstTurn).toBe(false);
    const second = model.requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'brain_search' }] });
    expect(second.at(-1)).toEqual({ role: 'tool', toolCallId: 'c1', content: 'Note: pricing is per seat (3rd).' });
  });

  it('offers the model names a provider accepts (a capability has a dot) and calls the real tool when the model uses one', async () => {
    const model = scriptedModel([call('memory_recall', { query: 'pricing' }), text('Per seat.')]);
    const made: string[] = [];
    const tools = {
      list: async () => [{ name: 'memory.recall', description: 'Recall', inputSchema: { type: 'object' } }],
      call: async (name: string) => {
        made.push(name);
        return { text: 'per seat', isError: false };
      },
    };
    const events = await drain(input(), { model, tools });
    expect(model.requests[0]!.tools.map((t) => t.name)).toEqual(['memory_recall']);
    expect(made).toEqual(['memory.recall']);
    expect(events[0]).toMatchObject({ type: 'tool', name: 'memory.recall' });
    expect(resultOf(events).ok).toBe(true);
  });

  it('answers a call to a tool that was not offered with a tool error and does not call any tool', async () => {
    const model = scriptedModel([call('rm_rf', {}), text('Sorry.')]);
    const toolCall = vi.fn();
    const events = await drain(input(), { model, tools: { list: async () => [], call: toolCall } });
    expect(toolCall).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, reason: 'unknown_tool' });
  });

  it('keeps two capabilities apart when their wire names would be the same', () => {
    const { offered, real } = wireNames([
      { name: 'a.b', description: '', inputSchema: {} },
      { name: 'a_b', description: '', inputSchema: {} },
      { name: 'x y!', description: '', inputSchema: {} },
    ]);
    expect(offered.map((t) => t.name)).toEqual(['a_b', 'a_b_2', 'x_y_']);
    expect(real.get('a_b_2')).toBe('a_b');
    expect(offered.every((t) => /^[a-zA-Z0-9_-]{1,64}$/.test(t.name))).toBe(true);
  });

  it('hands a refused tool call back to the model as a tool answer, not as the end of the run', async () => {
    const model = scriptedModel([call('brain_write', { x: 1 }), text('I could not save that.')]);
    const tools = { list: async () => [{ name: 'brain.write', description: '', inputSchema: {} }], call: async () => ({ text: '{"ok":false,"code":"not_granted"}', isError: true }) };
    const events = await drain(input(), { model, tools });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, reason: 'refused' });
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'I could not save that.' });
  });

  it('answers a call whose arguments are not a JSON object with a tool error, without calling the tool', async () => {
    const model = scriptedModel([{ ok: true, text: null, toolCalls: [{ id: 'c1', name: 'brain.search', arguments: '[1,2]' }], promptTokens: 1, completionTokens: 1 }, text('Done.')]);
    const toolCall = vi.fn();
    const events = await drain(input(), { model, tools: { list: async () => [], call: toolCall } });
    expect(toolCall).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, reason: 'bad_arguments' });
    expect(resultOf(events).ok).toBe(true);
  });

  it('cuts a very long tool answer before the model reads it', async () => {
    const model = scriptedModel([call('brain_search', {}), text('ok')]);
    const tools = { list: async () => [{ name: 'brain.search', description: '', inputSchema: {} }], call: async () => ({ text: 'x'.repeat(MAX_TOOL_ANSWER_CHARS + 5000), isError: false }) };
    await drain(input(), { model, tools });
    expect((model.requests[1]!.messages.at(-1) as { content: string }).content).toHaveLength(MAX_TOOL_ANSWER_CHARS);
  });

  it('ends a loop at the step limit with the "steps" failure, after exactly that many model turns', async () => {
    const model = scriptedModel([call('brain_search', {})]);
    const tools = { list: async () => [{ name: 'brain.search', description: '', inputSchema: {} }], call: async () => ({ text: 'more', isError: false }) };
    const events = await drain(input({ maxTurns: 3 }), { model, tools });
    expect(model.requests).toHaveLength(3);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'steps' });
  });

  it('uses a default step limit of 12 when the definition sets none', async () => {
    expect(DEFAULT_STEP_LIMIT).toBe(12);
    const model = scriptedModel([call('brain_search', {})]);
    const tools = { list: async () => [{ name: 'brain.search', description: '', inputSchema: {} }], call: async () => ({ text: 'more', isError: false }) };
    const events = await drain(input(), { model, tools });
    expect(model.requests).toHaveLength(12);
    expect(resultOf(events).failure).toBe('steps');
  });

  it('turns a guard refusal into the run\'s failure and says nothing the gateway said', async () => {
    const model = scriptedModel([{ ok: false, reason: 'refused', detail: 'The workspace\'s model limits or guardrails did not allow the call.' }]);
    const log = vi.fn();
    const events = await drain(input(), { model, log });
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'limit' });
    expect(events.filter((e) => e.type === 'tool')).toHaveLength(0);
    expect(log).toHaveBeenCalled();
  });

  it('maps a missing alias, an unreachable gateway and a timeout to their failures', async () => {
    for (const [reason, failure] of [['unbound', 'gateway'], ['unavailable', 'gateway'], ['timeout', 'timeout']] as const) {
      const model = scriptedModel([{ ok: false, reason, detail: 'd' }]);
      expect(resultOf(await drain(input(), { model }))).toMatchObject({ ok: false, failure });
    }
  });

  it('fails plainly when the model gateway is not loaded', async () => {
    expect(resultOf(await drain(input(), {}))).toMatchObject({ ok: false, failure: 'gateway' });
  });

  it('stops at once when the run budget is already spent', async () => {
    const model = scriptedModel([text('never')]);
    const events = await drain(input({ runBudgetSeconds: -1 }), { model });
    expect(model.requests).toHaveLength(0);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('fails when the model answers with nothing at all', async () => {
    const events = await drain(input(), { model: scriptedModel([text('   ')]) });
    expect(resultOf(events)).toMatchObject({ ok: false });
  });

  it('turns the runner\'s own refusal into the run\'s refusal, and never asks the model', async () => {
    resolveRunner.mockResolvedValue({ ok: false, reason: 'disabled', message: 'This bot runs on Brain model, which an admin has switched off.' });
    const model = scriptedModel([text('never')]);
    const events = await drain(input(), { model });
    expect(model.requests).toHaveLength(0);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'runner_refused', refusal: { runner: 'brain-model', reason: 'disabled', line: 'This bot runs on Brain model, which an admin has switched off.' } });
  });

  it('refuses a runner that is not an LLM gateway runner, and a bot placed on nothing', async () => {
    resolveRunner.mockResolvedValue({ ok: true, target: { ...READY.target, kind: 'hermes_gateway', modelAlias: null } });
    expect(resultOf(await drain(input(), { model: scriptedModel([text('x')]) }))).toMatchObject({ ok: false, failure: 'runner_refused' });
    expect(resultOf(await drain(input({ runner: null }), { model: scriptedModel([text('x')]) })).ok).toBe(false);
  });

  const ONE_TOOL = { list: async () => [{ name: 'brain.search', description: '', inputSchema: {} }] };

  it('answers a tool that throws with a tool error and lets the model go on', async () => {
    const model = scriptedModel([call('brain_search', {}), text('The search failed, so I cannot say.')]);
    const log = vi.fn();
    const events = await drain(input(), {
      model,
      log,
      tools: {
        ...ONE_TOOL,
        call: async () => {
          throw new Error('connection reset by peer (internal detail)');
        },
      },
    });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false, reason: 'failed' });
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'The search failed, so I cannot say.' });
    // The model hears a fixed answer, never the error text.
    const answered = model.requests[1]!.messages.at(-1) as { content: string };
    expect(answered.content).toContain('"code":"failed"');
    expect(answered.content).not.toContain('connection reset');
    expect(log).toHaveBeenCalled();
  });

  it('ends the run when the run itself has ended while a tool was being called', async () => {
    const model = scriptedModel([call('brain_search', {}), text('never')]);
    const events = await drain(input(), {
      model,
      tools: {
        ...ONE_TOOL,
        call: async () => {
          throw new RunEndedError('r1');
        },
      },
    });
    expect(model.requests).toHaveLength(1);
    expect(resultOf(events)).toMatchObject({ ok: false });
    expect(resultOf(events).failure).toBeUndefined();
  });

  it('ends a run whose tool never answers at the run budget, instead of holding the bot', async () => {
    const model = scriptedModel([call('brain_search', {}), text('never')]);
    const started = Date.now();
    const events = await drain(input({ runBudgetSeconds: 0.15 }), { model, tools: { ...ONE_TOOL, call: () => new Promise<never>(() => undefined) } });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'timeout' });
    expect(model.requests).toHaveLength(1);
  });

  it('ends a run whose model call never answers at the run budget', async () => {
    const events = await drain(input({ runBudgetSeconds: 0.15 }), { model: { turn: () => new Promise<never>(() => undefined) } });
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('stops at once when told to stop while a tool never answers', async () => {
    const runtime = createModelRuntime(ctx);
    const model = scriptedModel([call('brain_search', {}), text('never')]);
    const handle = await runtime.run(input(), { invoke: async () => ({}), logSource: async () => 1, log: () => undefined, model, tools: { ...ONE_TOOL, call: () => new Promise<never>(() => undefined) } });
    const out: BotRuntimeEvent[] = [];
    for await (const e of handle.events) {
      out.push(e);
      if (e.type === 'tool') setTimeout(() => void handle.stop(), 20);
    }
    expect(resultOf(out)).toMatchObject({ ok: false, failure: 'timeout' });
  });

  it('answers every one of several tool calls in one step, in order', async () => {
    const model = scriptedModel([calls(['brain_search', 'brain_search', 'brain_search']), text('Done.')]);
    let n = 0;
    const events = await drain(input(), { model, tools: { ...ONE_TOOL, call: async () => ({ text: `answer ${String((n += 1))}`, isError: false }) } });
    expect(resultOf(events)).toMatchObject({ ok: true });
    const second = model.requests[1]!.messages;
    expect(second.filter((m) => m.role === 'tool')).toEqual([
      { role: 'tool', toolCallId: 'c1', content: 'answer 1' },
      { role: 'tool', toolCallId: 'c2', content: 'answer 2' },
      { role: 'tool', toolCallId: 'c3', content: 'answer 3' },
    ]);
  });

  it('runs only so many tool calls in one step and answers the rest as "too many"', async () => {
    const names = Array.from({ length: MAX_TOOL_CALLS_PER_TURN + 2 }, () => 'brain_search');
    const model = scriptedModel([calls(names), text('Done.')]);
    const toolCall = vi.fn(async () => ({ text: 'ok', isError: false }));
    const events = await drain(input(), { model, tools: { ...ONE_TOOL, call: toolCall } });
    expect(toolCall).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_TURN);
    const answers = model.requests[1]!.messages.filter((m) => m.role === 'tool') as Array<{ toolCallId: string; content: string }>;
    expect(answers).toHaveLength(names.length);
    expect(answers.at(-1)!.content).toContain('too_many_calls');
    expect(resultOf(events).ok).toBe(true);
  });

  it('ends a run at its total tool-call limit with the "steps" failure', async () => {
    const model = scriptedModel([calls(Array.from({ length: MAX_TOOL_CALLS_PER_TURN }, () => 'brain_search'))]);
    const toolCall = vi.fn(async () => ({ text: 'ok', isError: false }));
    const events = await drain(input({ maxTurns: 50 }), { model, tools: { ...ONE_TOOL, call: toolCall } });
    expect(toolCall).toHaveBeenCalledTimes(MAX_TOOL_CALLS_PER_RUN);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'steps' });
  });

  it('does not post an answer that was cut off at the length limit as if it were complete', async () => {
    const events = await drain(input(), { model: scriptedModel([{ ...(text('The decision was to') as Extract<Said, { ok: true }>), truncated: true }]) });
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'too_long' });
  });

  it("carries the gateway's redacted history into the next turn, so a secret in the prompt is not sent again in clear text", async () => {
    const model = scriptedModel([call('brain_search', {}), text('Done.')], (t) => t.replace(/sk-[A-Za-z0-9]+/g, '[redacted]'));
    const i = input();
    i.prompt = 'My key is sk-ABC123 please search';
    const events = await drain(i, { model, tools: { ...ONE_TOOL, call: async () => ({ text: 'found it', isError: false }) } });
    expect(resultOf(events).ok).toBe(true);
    expect(model.requests[0]).toMatchObject({ firstTurn: true, checkedUpTo: 0 });
    // The second turn is sent the system text, the redacted prompt, the call and its answer; only the last two are new to the gateway.
    expect(model.requests[1]).toMatchObject({ firstTurn: false, checkedUpTo: 2 });
    const second = model.requests[1]!.messages;
    expect(second[1]).toEqual({ role: 'user', content: 'My key is [redacted] please search' });
    expect(JSON.stringify(second)).not.toContain('sk-ABC123');
  });

  it('shows a tool name the model made up without control characters and cut to a sane length', async () => {
    const model = scriptedModel([call('evil\n[ok] fake line\u0000' + 'x'.repeat(500), {}), text('Done.')]);
    const events = await drain(input(), { model, tools: { list: async () => [], call: vi.fn() } });
    const shown = (events.find((e) => e.type === 'tool') as { name: string }).name;
    expect([...shown].every((ch) => ch.charCodeAt(0) > 0x1f)).toBe(true);
    expect(shown.startsWith('evil[ok] fake line')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(100);
  });
});
