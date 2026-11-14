import { parseBotMd } from '@manythreads/shared';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { agentFromFrame, approvalExtras, endOfTurn, kindOfTool, planFromFrame, stepFromFrame, thinkingFromFrame, toolFromFrame, toolResultFromFrame } from '../src/activity.ts';
import { runOnGateway, type GatewayRuntimeOptions } from '../src/gateway.ts';

// P25-04: the frames of the agent bridge (and the plain ones of a Hermes gateway) as the run's activity events.

describe('a tool by its name: the kind a Hermes gateway frame gets', () => {
  it('maps the names of Hermes\' tools to the kinds of ACP', () => {
    const cases: Array<[string, string]> = [
      ['terminal', 'execute'],
      ['shell_exec', 'execute'],
      ['bash', 'execute'],
      ['read_file', 'read'],
      ['list_directory', 'read'],
      ['memory_search', 'search'],
      ['search_files', 'search'],
      ['grep', 'search'],
      ['web_search', 'fetch'],
      ['browser_navigate', 'fetch'],
      ['write_file', 'edit'],
      ['patch', 'edit'],
      ['delete_file', 'delete'],
      ['move_file', 'move'],
      ['mcp__manythreads__mt_note', 'other'],
      ['todo', 'other'],
    ];
    for (const [tool, kind] of cases) expect(kindOfTool(tool), tool).toBe(kind);
  });
});

describe('the frames, read defensively', () => {
  it('tool.started: the step, its parent, kind, title and paths; a frame of an old gateway still gets a kind', () => {
    expect(toolFromFrame({ tool: 'Bash', preview: 'Terminal', step_id: 's1', parent_step_id: 'a1', kind: 'execute', title: 'pnpm test', paths: ['a.ts', 'a.ts', 'b.ts'] })).toEqual({
      type: 'tool',
      name: 'Bash',
      input: 'Terminal',
      stepId: 's1',
      parentStepId: 'a1',
      kind: 'execute',
      title: 'pnpm test',
      paths: ['a.ts', 'b.ts'],
    });
    expect(toolFromFrame({ tool: 'read_file', preview: '' })).toEqual({ type: 'tool', name: 'read_file', input: '', kind: 'read' });
    // a kind of a word that is not one is the name's kind; a title that is not text is nothing
    expect(toolFromFrame({ tool: 'terminal', kind: 'rm -rf', title: 7 })).toMatchObject({ kind: 'execute' });
    expect(toolFromFrame({ tool: 'terminal', title: 7 })).not.toHaveProperty('title');
  });

  it('bounds what it takes: the title at 160, a path at 200, five paths', () => {
    const e = toolFromFrame({ tool: 'x', title: 'a'.repeat(400), paths: Array.from({ length: 9 }, (_, i) => `${i}${'p'.repeat(300)}`) });
    expect(e.title).toHaveLength(160);
    expect(e.paths).toHaveLength(5);
    expect(e.paths!.every((p) => p.length <= 200)).toBe(true);
  });

  it('tool.completed: the step, the counts of a diff, the seconds; a failure keeps its one line', () => {
    expect(toolResultFromFrame({ tool: 'Edit', step_id: 's1', duration: 1.2, error: false, diff: { added: 3, removed: 1 } })).toEqual({ type: 'tool_result', name: 'Edit', ok: true, stepId: 's1', diff: { added: 3, removed: 1 }, seconds: 1.2 });
    expect(toolResultFromFrame({ tool: 'Bash', error: true })).toEqual({ type: 'tool_result', name: 'Bash', ok: false, reason: 'the tool reported an error' });
    expect(toolResultFromFrame({ tool: 'Edit', diff: { added: -1, removed: 'x' }, duration: -3 })).toEqual({ type: 'tool_result', name: 'Edit', ok: true });
  });

  it('step.update: only what changed; nothing when nothing did', () => {
    expect(stepFromFrame({ step_id: 's1', title: 'Read package.json', paths: ['package.json'] })).toEqual({ type: 'step', stepId: 's1', title: 'Read package.json', paths: ['package.json'] });
    expect(stepFromFrame({ step_id: 's1', status: 'in_progress' })).toEqual({ type: 'step', stepId: 's1', status: 'in_progress' });
    expect(stepFromFrame({ step_id: 's1', status: 'completed' })).toBeNull();
    expect(stepFromFrame({ title: 'no id' })).toBeNull();
  });

  it('agent.update: a helper and how far it is; a bad status is not passed on', () => {
    expect(agentFromFrame({ agent_id: 'a1', name: 'Read notes', status: 'working', steps: 2, parent_step_id: 's0' })).toEqual({ type: 'agent', agentId: 'a1', name: 'Read notes', status: 'working', steps: 2, parentStepId: 's0' });
    expect(agentFromFrame({ agent_id: 'a1', status: 'done' })).toEqual({ type: 'agent', agentId: 'a1', name: 'Helper', status: 'done', steps: 0 });
    expect(agentFromFrame({ agent_id: 'a1', status: 'lost' })).toBeNull();
    expect(agentFromFrame({ status: 'done' })).toBeNull();
  });

  it('plan.update: the whole list; a priority is dropped and an unknown status is pending', () => {
    expect(planFromFrame({ entries: [{ content: 'Read', status: 'completed', priority: 'high' }, { content: 'Write', status: 'weird' }, { content: '' }, 'x'] })).toEqual({
      type: 'plan',
      entries: [
        { content: 'Read', status: 'completed' },
        { content: 'Write', status: 'pending' },
      ],
    });
    expect(planFromFrame({ entries: 'no' })).toBeNull();
    expect(planFromFrame({ entries: Array.from({ length: 80 }, (_, i) => ({ content: `step ${i}` })) })!.entries).toHaveLength(30);
  });

  it('thinking: how long and nothing else', () => {
    expect(thinkingFromFrame({ seconds: 4.26, text: 'the model is reasoning about secrets' })).toEqual({ type: 'thinking', seconds: 4.3 });
    expect(thinkingFromFrame({ seconds: 'many' })).toEqual({ type: 'thinking', seconds: 0 });
  });

  it('run.completed: the stop reason and the cost, when they are well formed', () => {
    expect(endOfTurn({ stop_reason: 'end_turn', cost: { amount: 0.0038, currency: 'USD' } })).toEqual({ stopReason: 'end_turn', cost: { amount: 0.0038, currency: 'USD' } });
    expect(endOfTurn({ cost: { amount: 'a lot', currency: 'USD' } })).toEqual({});
    expect(endOfTurn({})).toEqual({});
  });

  it('approval.request: what the step is, and whether a note can go with the answer', () => {
    expect(approvalExtras({ kind: 'edit', title: 'Edit a.ts', paths: ['a.ts'], diff: { added: 1, removed: 0 }, step_id: 's9', note_ok: true })).toEqual({
      kind: 'edit',
      title: 'Edit a.ts',
      paths: ['a.ts'],
      diff: { added: 1, removed: 0 },
      stepId: 's9',
      canNote: true,
    });
    expect(approvalExtras({ note_ok: false })).toEqual({});
    expect(approvalExtras({ kind: 'nonsense' })).toEqual({});
  });
});

describe('through a gateway run', () => {
  const KEY = 'profile-key-0123456789';
  let gw: FakeHermesGateway;
  const scope: BotRuntimeScope = { invoke: async () => ({}), logSource: async () => 0, log: () => undefined };
  beforeEach(async () => {
    gw = await startFakeHermesGateway({ profiles: { 'mt-coder': { apiKey: KEY } } });
  });
  afterEach(async () => {
    await gw.close();
  });

  const input = (): BotRuntimeInput => {
    const parsed = parseBotMd('---\nname: Coder\nrole: r\nkind: agent\nruntime: hermes\n---\nsoul\n');
    if (!parsed.ok) throw new Error('fixture');
    return {
      bot: { id: '11111111-1111-1111-1111-111111111111', slug: 'coder', name: 'Coder', teamId: '22222222-2222-2222-2222-222222222222', workspaceId: '33333333-3333-3333-3333-333333333333', runtime: 'hermes', definitionSha: 'a'.repeat(64) },
      definition: { frontmatter: parsed.frontmatter, body: parsed.body },
      trigger: 'mention',
      asker: null,
      prompt: 'Nadia in #dev:\n\n@coder go',
      thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: '66666666-6666-6666-6666-666666666666' },
      endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'http://x/api/mcp/runs/x', token: 't' },
      gateway: null,
      limits: { runBudgetSeconds: 30, maxTurns: null, sessionMinutes: null },
    };
  };
  const options = (agent: 'hermes' | 'claude-code' = 'claude-code'): GatewayRuntimeOptions => ({
    resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'external', agent }),
    killGraceSeconds: 1,
    retryUnitMs: 10,
  });
  const run = async (agent?: 'hermes' | 'claude-code'): Promise<BotRuntimeEvent[]> => {
    const handle = await runOnGateway(options(agent), input(), scope, { connection: 'host', profile: 'mt-coder' });
    const out: BotRuntimeEvent[] = [];
    for await (const e of handle.events) out.push(e);
    return out;
  };

  it('turns the bridge\'s frames of one run into events, in order, and the end into a result with its stop reason and cost', async () => {
    gw.setScript(() => [
      { type: 'frame', event: 'thinking', fields: { seconds: 1.5 } },
      { type: 'frame', event: 'plan.update', fields: { entries: [{ content: 'Read it', status: 'in_progress' }] } },
      { type: 'frame', event: 'tool.started', fields: { tool: 'Read', preview: 'Read File', step_id: 's1', kind: 'read', title: 'Read File', paths: [] } },
      { type: 'frame', event: 'step.update', fields: { step_id: 's1', title: 'Read package.json', paths: ['package.json'] } },
      { type: 'frame', event: 'agent.update', fields: { agent_id: 'a1', name: 'Check notes', status: 'working', steps: 0 } },
      { type: 'frame', event: 'tool.started', fields: { tool: 'Read', preview: 'Read notes', step_id: 's2', parent_step_id: 'a1', kind: 'read', title: 'Read notes.txt', paths: ['notes.txt'] } },
      { type: 'frame', event: 'tool.completed', fields: { tool: 'Read', step_id: 's2', duration: 0.4, error: false } },
      { type: 'frame', event: 'agent.update', fields: { agent_id: 'a1', name: 'Check notes', status: 'done', steps: 1 } },
      { type: 'frame', event: 'tool.completed', fields: { tool: 'Read', step_id: 's1', duration: 0.2, error: false, diff: { added: 2, removed: 1 } } },
      { type: 'delta', text: 'All ' },
      { type: 'delta', text: 'done.' },
      { type: 'finish', output: 'All done.', extra: { stop_reason: 'end_turn', cost: { amount: 0.0021, currency: 'USD' } } },
    ]);
    const events = await run();
    expect(events.map((e) => e.type)).toEqual(['thinking', 'plan', 'tool', 'step', 'agent', 'tool', 'tool_result', 'agent', 'tool_result', 'text', 'text', 'result']);
    expect(events[2]).toMatchObject({ type: 'tool', name: 'Read', stepId: 's1', kind: 'read', title: 'Read File' });
    expect(events[3]).toEqual({ type: 'step', stepId: 's1', title: 'Read package.json', paths: ['package.json'] });
    expect(events[5]).toMatchObject({ type: 'tool', stepId: 's2', parentStepId: 'a1', paths: ['notes.txt'] });
    expect(events[8]).toMatchObject({ type: 'tool_result', stepId: 's1', seconds: 0.2, diff: { added: 2, removed: 1 } });
    expect(events.at(-1)).toMatchObject({ type: 'result', ok: true, text: 'All done.', stopReason: 'end_turn', cost: { amount: 0.0021, currency: 'USD' } });
  });

  it('a Hermes gateway\'s own tool frames still work, and get a kind from the tool\'s name', async () => {
    gw.setScript(() => [{ type: 'tool', name: 'read_file' }, { type: 'tool', name: 'terminal', error: true }, { type: 'finish', output: 'x' }]);
    const events = await run('hermes');
    expect(events.filter((e) => e.type === 'tool')).toEqual([
      { type: 'tool', name: 'read_file', input: '', kind: 'read' },
      { type: 'tool', name: 'terminal', input: '', kind: 'execute' },
    ]);
    expect(events.filter((e) => e.type === 'tool_result')).toMatchObject([{ name: 'read_file', ok: true, seconds: 0.01 }, { name: 'terminal', ok: false }]);
    const result = events.at(-1)!;
    expect(result).toMatchObject({ type: 'result', ok: true });
    expect(result).not.toHaveProperty('stopReason');
  });

  it('a frame it does not know, or one that is not well formed, is not an event', async () => {
    gw.setScript(() => [
      { type: 'frame', event: 'step.update', fields: {} },
      { type: 'frame', event: 'agent.update', fields: { status: 'working' } },
      { type: 'frame', event: 'plan.update', fields: { entries: 3 } },
      { type: 'frame', event: 'session_info_update', fields: { title: 'x' } },
      { type: 'finish', output: 'ok' },
    ]);
    expect((await run()).map((e) => e.type)).toEqual(['result']);
  });

  it('an approval carries what the step is, and a note goes with the answer only when the card may offer one', async () => {
    const answered: Array<{ choice: string; steered: string[] }> = [];
    gw.setScript(() => [{ type: 'approval', command: 'Edit a.ts', onAnswer: (a) => void answered.push(a) }, { type: 'finish', output: 'ok' }]);
    const handle = await runOnGateway(options(), input(), scope, { connection: 'host', profile: 'mt-coder' });
    let seen: Extract<BotRuntimeEvent, { type: 'approval' }> | null = null;
    for await (const e of handle.events) {
      if (e.type === 'approval') {
        seen = e;
        await e.answer('once');
      }
    }
    expect(seen).toMatchObject({ command: 'Edit a.ts', choices: ['once', 'session', 'deny'] });
    // the fake gateway sends no structured fields: none are invented
    expect(seen).not.toHaveProperty('kind');
    expect(seen).not.toHaveProperty('canNote');
    expect(answered).toEqual([{ choice: 'once', steered: [] }]);
  });
});
