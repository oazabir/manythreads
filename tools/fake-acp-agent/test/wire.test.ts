import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRIPT, type FakeScript } from '../src/script.ts';
import { OURS, harness, kinds, start, texts, waitFor } from './helpers.ts';

/*
 * What the fake agent sends for a prompt, per flavor: the shapes P25-01 measured (docs/spikes/acp-measured.md), read back by the SDK's
 * own client. These are the frames the bridge's driver (P25-03) is tested against.
 */

const CWD = '/work/demo';

async function prompt(script: FakeScript, text: string, options?: Parameters<typeof harness>[1]) {
  const h = harness(script, options);
  const result = await h.run(async (agent) => {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
    const session = await agent.request('session/new', { cwd: CWD, mcpServers: [] });
    const answer = await agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
    return { sessionId: session.sessionId, answer };
  });
  return { h, ...result };
}

const byId = (updates: Array<Record<string, unknown>>, id: unknown) => updates.filter((u) => u.toolCallId === id);

describe('claude flavor: a worked prompt', () => {
  it('sends pending, then refined titles and paths, then the end, and never in_progress', async () => {
    const { h, answer } = await prompt(DEFAULT_SCRIPT, '[[work]]');
    expect(answer.stopReason).toBe('end_turn');
    const read = h.updates.find(
      (u) =>
        u.sessionUpdate === 'tool_call' &&
        (u._meta as { claudeCode: { toolName: string } }).claudeCode.toolName === 'Read' &&
        !('parentToolUseId' in (u._meta as { claudeCode: object }).claudeCode),
    );
    expect(read).toMatchObject({ status: 'pending', title: 'Read File', kind: 'read', locations: [] });
    const frames = byId(h.updates, read?.toolCallId);
    // pending, the refined title and paths, a status-less update carrying the tool response, then the end
    expect(frames).toHaveLength(4);
    expect(frames[1]).toMatchObject({ sessionUpdate: 'tool_call_update', title: 'Read package.json', locations: [{ path: `${CWD}/package.json` }] });
    expect(frames[1]).not.toHaveProperty('status');
    expect(frames[2]).not.toHaveProperty('status');
    expect(frames[3]).toMatchObject({ status: 'completed' });
    expect(frames[3]).toHaveProperty('rawOutput');
    expect(h.updates.some((u) => u.status === 'in_progress')).toBe(false);
  });

  it('puts the leaks on the wire that the bridge has to drop', async () => {
    const { h } = await prompt(DEFAULT_SCRIPT, '[[work]]');
    const bash = h.updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.title === 'pnpm test');
    expect(bash).toMatchObject({ rawInput: { command: 'pnpm test' } });
    const last = h.updates.filter((u) => u.toolCallId === bash?.toolCallId).at(-1);
    expect(last).toMatchObject({ status: 'completed', _meta: { claudeCode: { toolName: 'Bash', toolResponse: '3 passed' } } });
  });

  it('sends an edit as a diff', async () => {
    const { h } = await prompt(DEFAULT_SCRIPT, '[[work]]');
    const edit = h.updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.title === 'Edit package.json');
    expect(edit?.content).toEqual([{ type: 'diff', path: `${CWD}/package.json`, oldText: '"name":"demo"', newText: '"name":"renamed"' }]);
  });

  it('marks a helper with the measured shape: the Agent call, children with parentToolUseId, SubagentHandback, a report', async () => {
    const { h } = await prompt(DEFAULT_SCRIPT, '[[work]]');
    const parent = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'Task');
    expect(parent).toMatchObject({ kind: 'think', status: 'pending', _meta: { claudeCode: { toolName: 'Agent' } } });
    const children = h.updates.filter(
      (u) => u.sessionUpdate === 'tool_call' && (u._meta as { claudeCode: { parentToolUseId?: string } }).claudeCode.parentToolUseId === parent?.toolCallId,
    );
    expect(children.map((c) => (c._meta as { claudeCode: { toolName: string } }).claudeCode.toolName)).toEqual(['Read', 'SubagentHandback']);
    const end = byId(h.updates, parent?.toolCallId).at(-1);
    expect(end).toMatchObject({
      status: 'completed',
      _meta: { claudeCode: { toolResponse: { status: 'completed', agentType: 'general-purpose', handbackReport: 'The notes say hello.' } } },
    });
    expect(byId(h.updates, parent?.toolCallId)[1]).toMatchObject({ title: 'Read notes.txt' });
  });

  it('sends the whole plan each time and the cumulative cost', async () => {
    const { h, answer } = await prompt(DEFAULT_SCRIPT, '[[work]]');
    const plans = h.updates.filter((u) => u.sessionUpdate === 'plan');
    expect(plans).toHaveLength(2);
    expect(plans[0]?.entries).toEqual([
      { content: 'Read the package', status: 'in_progress', priority: 'medium' },
      { content: 'Change the name', status: 'pending', priority: 'medium' },
    ]);
    expect((plans[1]?.entries as Array<{ status: string }>).map((e) => e.status)).toEqual(['completed', 'completed']);
    const usage = h.updates.filter((u) => u.sessionUpdate === 'usage_update');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ used: 12555, size: 1_000_000, cost: { amount: 0.0038, currency: 'USD' } });
    expect(answer).toMatchObject({ usage: { totalTokens: expect.any(Number) } });
    expect(texts(h.updates)).toBe('Done. The package is renamed.');
  });

  it('splits text into chunks and fills the template', async () => {
    const { h } = await prompt(
      {
        scenarios: {
          a: [
            { do: 'text', text: 'one two three four five six', chunks: 3 },
            { do: 'text', text: ' turn {{turn}}: {{prompt}}' },
          ],
        },
      },
      'hi',
    );
    const chunks = h.updates.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(chunks).toHaveLength(4);
    expect(texts(h.updates)).toBe('one two three four five six turn 1: hi');
  });

  it('adds a usage_update by itself when the scenario sent none, with the cost adding up over prompts', async () => {
    const h = harness({ scenarios: { a: [{ do: 'text', text: 'ok' }] } });
    await h.run(async (agent) => {
      const sessionId = await start(agent);
      await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] });
      await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] });
    });
    const costs = h.updates.filter((u) => u.sessionUpdate === 'usage_update').map((u) => (u.cost as { amount: number }).amount);
    expect(costs).toEqual([0.001, 0.002]);
  });

  it('shows a failed step, then ends the prompt with an error', async () => {
    const h = harness(DEFAULT_SCRIPT);
    await expect(
      h.run(async (agent) => {
        const sessionId = await start(agent);
        await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[fail]]' }] });
      }),
    ).rejects.toMatchObject({ code: -32603, message: 'The model is overloaded' });
    expect(h.updates.find((u) => u.status === 'failed')).toMatchObject({ content: [{ type: 'content', content: { type: 'text', text: 'No such file' } }] });
  });

  it('ends with a stop reason when told to', async () => {
    const { answer } = await prompt(
      {
        scenarios: {
          a: [
            { do: 'text', text: 'cut' },
            { do: 'stop', reason: 'max_tokens' },
          ],
        },
      },
      'x',
    );
    expect(answer.stopReason).toBe('max_tokens');
  });
});

describe('permission requests', () => {
  it('claude: asks with the step id and the measured options, and carries on after Yes', async () => {
    const { h } = await prompt(DEFAULT_SCRIPT, '[[permission]]');
    const request = h.permissions[0];
    const step = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'Terminal');
    expect(request?.toolCall).toMatchObject({
      toolCallId: step?.toolCallId,
      name: 'Bash',
      status: 'pending',
      title: 'touch spike-a.txt',
      kind: 'execute',
      rawInput: { command: 'touch spike-a.txt' },
    });
    expect(request?.options.map((o) => [o.optionId, o.kind])).toEqual([
      ['allow-once', 'allow_once'],
      ['reject', 'reject_once'],
    ]);
    expect(texts(h.updates)).toBe('I need to create a file.Created.');
    expect(byId(h.updates, step?.toolCallId).at(-1)).toMatchObject({ status: 'completed' });
  });

  it('claude: a No fails the step with nonExecutionKind and ends the turn after the reply', async () => {
    const { h } = await prompt(DEFAULT_SCRIPT, '[[permission]]', { permission: 'reject_once' });
    const step = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'Terminal');
    expect(byId(h.updates, step?.toolCallId).at(-1)).toMatchObject({ status: 'failed', _meta: { claudeCode: { nonExecutionKind: 'permission-rule' } } });
    expect(texts(h.updates)).toBe('I need to create a file.Declined.');
  });

  it('a cancelled answer ends the prompt cancelled', async () => {
    const { answer, h } = await prompt(DEFAULT_SCRIPT, '[[permission]]', { permission: 'cancelled' });
    expect(answer.stopReason).toBe('cancelled');
    const step = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'Terminal');
    expect(byId(h.updates, step?.toolCallId).at(-1)).toMatchObject({ status: 'failed', _meta: { claudeCode: { nonExecutionKind: 'user-rejected' } } });
  });

  it('an unanswered request waits, and session/cancel ends it', async () => {
    const h = harness(DEFAULT_SCRIPT, { permission: 'hang' });
    const answer = await h.run(async (agent) => {
      const sessionId = await start(agent);
      const pending = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[permission]]' }] });
      await waitFor(() => h.permissions.length === 1);
      await new Promise((r) => setTimeout(r, 50));
      await agent.notify('session/cancel', { sessionId });
      return pending;
    });
    expect(answer.stopReason).toBe('cancelled');
  });

  it('codex: an MCP approval has no title, four options, the step id and the MCP flag', async () => {
    const script: FakeScript = {
      flavor: 'codex',
      scenarios: { a: [{ do: 'permission', mcp: true, step: { title: 'mcp.manythreads.mt_note', kind: 'execute', toolName: 'mt_note' } }] },
    };
    const { h } = await prompt(script, 'x');
    const step = h.updates.find((u) => u.sessionUpdate === 'tool_call');
    expect(h.permissions[0]?.toolCall).toEqual({ toolCallId: step?.toolCallId, kind: 'execute', status: 'pending' });
    expect(h.permissions[0]?.options.map((o) => [o.optionId, o.kind])).toEqual([
      ['allow_once', 'allow_once'],
      ['allow_session', 'allow_always'],
      ['allow_always', 'allow_always'],
      ['cancel', 'reject_once'],
    ]);
  });

  it('codex: an exec approval has a title and Yes, proceed / cancel', async () => {
    const script: FakeScript = {
      flavor: 'codex',
      scenarios: { a: [{ do: 'permission', step: { title: 'touch a.txt', kind: 'execute', input: { command: 'touch a.txt' } } }] },
    };
    const { h } = await prompt(script, 'x', { permission: 'reject_once' });
    expect(h.permissions[0]?.toolCall).toMatchObject({ title: 'touch a.txt', rawInput: { command: 'touch a.txt' } });
    expect(h.permissions[0]?.options.map((o) => o.optionId)).toEqual(['allow_once', 'cancel']);
    expect(h.updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({ status: 'failed' });
  });

  it('hermes: five options and a request id that is not the step id', async () => {
    const script: FakeScript = {
      flavor: 'hermes',
      scenarios: { a: [{ do: 'permission', step: { title: 'terminal: rm x', kind: 'execute', input: { command: 'rm x', description: 'Delete x' } } }] },
    };
    const { h } = await prompt(script, 'x');
    const step = h.updates.find((u) => u.sessionUpdate === 'tool_call');
    expect(h.permissions[0]?.toolCall).toMatchObject({ toolCallId: 'perm-check-1', title: 'Delete x: rm x', rawInput: { command: 'rm x', description: 'Delete x' } });
    expect(h.permissions[0]?.toolCall.toolCallId).not.toBe(step?.toolCallId);
    expect(h.permissions[0]?.options.map((o) => o.optionId)).toEqual(['allow_once', 'allow_session', 'allow_always', 'deny', 'deny_always']);
  });
});

describe('a slow step and session/cancel', () => {
  async function cancelled(flavor: 'claude' | 'codex' | 'hermes') {
    const h = harness({ ...DEFAULT_SCRIPT, flavor });
    const started = Date.now();
    const result = await h.run(async (agent) => {
      const sessionId = await start(agent);
      const pending = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[slow]]' }] });
      await waitFor(() => h.updates.some((u) => u.sessionUpdate === 'tool_call'));
      await agent.notify('session/cancel', { sessionId });
      const answer = await pending;
      // the session stays usable
      const next = await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[hello]]' }] });
      return { answer, next };
    });
    return { h, ...result, ms: Date.now() - started };
  }

  it('claude: ends cancelled in milliseconds and marks the step failed user-rejected', async () => {
    const { h, answer, next, ms } = await cancelled('claude');
    expect(answer.stopReason).toBe('cancelled');
    expect(ms).toBeLessThan(2000);
    expect(h.updates.find((u) => u.status === 'failed')).toMatchObject({ _meta: { claudeCode: { nonExecutionKind: 'user-rejected' } } });
    expect(next.stopReason).toBe('end_turn');
    expect(texts(h.updates)).toContain('Hello from the fake agent.');
    expect(texts(h.updates)).not.toContain('It finished');
  });

  it('codex: ends cancelled and never finalises the step', async () => {
    const { h, answer } = await cancelled('codex');
    expect(answer.stopReason).toBe('cancelled');
    expect(h.updates.filter((u) => u.sessionUpdate === 'tool_call_update')).toHaveLength(0);
  });

  it('hermes: ends cancelled and the step says completed with the abandoned text', async () => {
    const { h, answer } = await cancelled('hermes');
    expect(answer.stopReason).toBe('cancelled');
    const update = h.updates.find((u) => u.sessionUpdate === 'tool_call_update');
    expect(update).toMatchObject({ status: 'completed' });
    expect(JSON.stringify(update)).toContain('terminal was abandoned');
  });

  it('waits cancelDelayMs before it answers', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, cancelDelayMs: 300 });
    const ms = await h.run(async (agent) => {
      const sessionId = await start(agent);
      const pending = agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[slow]]' }] });
      await waitFor(() => h.updates.some((u) => u.sessionUpdate === 'tool_call'));
      const t = Date.now();
      await agent.notify('session/cancel', { sessionId });
      await pending;
      return Date.now() - t;
    });
    expect(ms).toBeGreaterThanOrEqual(280);
  });
});

describe('codex and hermes flavors', () => {
  it('codex: in_progress then completed, a terminal leak on commands, a diff in the first frame, helper as three flat steps, no plan, no cost', async () => {
    const { h } = await prompt({ ...DEFAULT_SCRIPT, flavor: 'codex' }, '[[work]]');
    const run = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'pnpm test');
    expect(run).toMatchObject({ status: 'in_progress', rawInput: { command: 'pnpm test' } });
    expect(byId(h.updates, run?.toolCallId).at(-1)).toMatchObject({
      status: 'completed',
      _meta: { terminal_output_delta: { data: '3 passed' }, terminal_exit: { exit_code: 0 } },
    });
    const edit = h.updates.find((u) => u.sessionUpdate === 'tool_call' && u.title === 'Edit package.json');
    expect(edit?.content).toMatchObject([{ type: 'diff', _meta: { kind: 'update' } }]);
    expect(h.updates.filter((u) => u.sessionUpdate === 'tool_call' && /subagent|^wait$/.test(String(u.title))).map((u) => u.title)).toEqual([
      'Start subagent Read notes.txt',
      'wait',
      'Complete subagent Read notes.txt',
    ]);
    expect(kinds(h.updates)).not.toContain('plan');
    const usage = h.updates.find((u) => u.sessionUpdate === 'usage_update');
    expect(usage).not.toHaveProperty('cost');
    expect(usage).toMatchObject({ size: 258_400 });
  });

  it('hermes: no status at the start, completed at the end, a plan as todo_list steps with merge, one delegate_task step', async () => {
    const { h } = await prompt({ ...DEFAULT_SCRIPT, flavor: 'hermes' }, '[[work]]');
    const first = h.updates.find((u) => u.sessionUpdate === 'tool_call');
    expect(first).not.toHaveProperty('status');
    expect(kinds(h.updates)).not.toContain('plan');
    const todos = h.updates.filter((u) => u.sessionUpdate === 'tool_call' && String(u.title).startsWith('todo_list'));
    expect(todos.map((t) => t.title)).toEqual(['todo_list: planning 2 task(s)', 'todo_list: updating 2 task(s)']);
    expect(todos[0]?.rawInput).toEqual({
      todos: [
        { id: '1', content: 'Read the package', status: 'in_progress' },
        { id: '2', content: 'Change the name', status: 'pending' },
      ],
    });
    expect(todos[1]?.rawInput).toMatchObject({ merge: true });
    const delegate = h.updates.find((u) => u.sessionUpdate === 'tool_call' && String(u.title).startsWith('delegate_task'));
    expect(byId(h.updates, delegate?.toolCallId).at(-1)).toMatchObject({ status: 'completed' });
    expect(h.updates.some((u) => u.status === 'failed')).toBe(false);
    expect(h.updates.find((u) => u.sessionUpdate === 'usage_update')).not.toHaveProperty('cost');
  });

  it('hermes: a failed step is still completed, with the error as text; codex fails it with an exit code', async () => {
    const steps: FakeScript['scenarios'] = { a: [{ do: 'step', title: 'cat x', kind: 'execute', fail: 'No such file' }] };
    const hermes = await prompt({ flavor: 'hermes', scenarios: steps }, 'x');
    expect(hermes.h.updates.filter((u) => u.sessionUpdate === 'tool_call_update').at(-1)).toMatchObject({
      status: 'completed',
      content: [{ content: { text: 'No such file' } }],
    });
    const codex = await prompt({ flavor: 'codex', scenarios: steps }, 'x');
    expect(codex.h.updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({ status: 'failed', _meta: { terminal_exit: { exit_code: 1 } } });
  });

  it('leak: false keeps the inputs and outputs off the wire', async () => {
    const script: FakeScript = {
      scenarios: { a: [{ do: 'step', title: 'Run', kind: 'execute', toolName: 'Bash', input: { command: 'secret' }, output: 'out', leak: false }] },
    };
    const { h } = await prompt(script, 'x');
    expect(JSON.stringify(h.updates)).not.toContain('secret');
    expect(JSON.stringify(h.updates)).not.toContain('"out"');
  });
});

describe('what the measured adapters answer that the first fake did not', () => {
  it('claude and codex advertise steering at the top of the initialize result; hermes does not', async () => {
    for (const flavor of ['claude', 'codex', 'hermes'] as const) {
      const h = harness({ ...DEFAULT_SCRIPT, flavor });
      const init = await h.run((agent) => agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS }));
      expect(((init as { _meta?: { steering?: { supported?: boolean } } })._meta?.steering?.supported) === true).toBe(flavor !== 'hermes');
    }
  });

  it('returns configOptions with the mode, and set_config_option changes the mode and refuses an unknown value', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor: 'codex' });
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const created = (await agent.request('session/new', { cwd: CWD, mcpServers: [] })) as unknown as { sessionId: string; configOptions: Array<{ id: string }> };
      expect(created.configOptions.map((o) => o.id)).toEqual(['mode', 'model', 'reasoning_effort']);
      const set = (await agent.request('session/set_config_option', { sessionId: created.sessionId, configId: 'mode', value: 'read-only' })) as unknown as {
        configOptions: Array<{ id: string; currentValue: string }>;
      };
      expect(set.configOptions.find((o) => o.id === 'mode')?.currentValue).toBe('read-only');
      await expect(agent.request('session/set_config_option', { sessionId: created.sessionId, configId: 'model', value: 'nope' })).rejects.toThrow();
    });
  });

  it('codex edits carry no locations, only the diff block', async () => {
    const { h } = await prompt({ ...DEFAULT_SCRIPT, flavor: 'codex' }, '[[work]]');
    const edit = h.updates.find((u) => u.sessionUpdate === 'tool_call' && Array.isArray(u.content) && (u.content as Array<{ type: string }>)[0]?.type === 'diff');
    expect(edit).toBeDefined();
    expect(edit?.locations).toEqual([]);
  });

  it('refuses a permission answer whose option id it did not offer (it is not read as a Yes)', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor: 'claude' }, { permission: 'unknown_id' });
    await expect(
      h.run(async (agent) => {
        await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
        const session = await agent.request('session/new', { cwd: CWD, mcpServers: [] });
        return agent.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: '[[permission]]' }] });
      }),
    ).rejects.toThrow();
  });
});
