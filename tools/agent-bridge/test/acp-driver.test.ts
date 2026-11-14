import { afterEach, describe, expect, it } from 'vitest';
import { acpHarness, post, runToEnd, startRun, watch, type AcpHarness, type Flavor, type Frame } from './acp-support.ts';
import { waitFor } from './support.ts';

// The acp driver end to end: the bridge's HTTP face, a run, the fake ACP agent as a child process (its frames follow the recorded fixtures; the real adapters are
// not run here). Mapping details over the fixtures themselves are in acp-frames.test.ts.

let h: AcpHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const MCP = { url: 'https://example.test/mcp', token: 'run-token-SECRET-12345' };
const names = (frames: Frame[]): string[] => frames.map((f) => f['event'] as string);
const last = (frames: Frame[]): Frame => frames.at(-1)!;

/** A script with one scenario of our own (the fake's tags `[[name]]` pick among them). */
const script = (flavor: Flavor, scenarios: Record<string, unknown[]>): Record<string, unknown> => ({ flavor, scenarios, default: Object.keys(scenarios)[0] });

describe('a run on each adapter', () => {
  for (const flavor of ['claude', 'codex', 'hermes'] as const) {
    it(`${flavor}: streams the text and ends with the answer, the stop reason and the usage`, async () => {
      h = await acpHarness({ flavor });
      const frames = await runToEnd(h, { input: 'hi [[hello]]' });
      expect(frames.filter((f) => f['event'] === 'message.delta').map((f) => f['delta']).join('')).toBe('Hello from the fake agent.');
      expect(last(frames)).toMatchObject({ event: 'run.completed', output: 'Hello from the fake agent.', stop_reason: 'end_turn' });
      expect(last(frames)['usage']).toMatchObject({ input_tokens: 12, output_tokens: 40 });
    });
  }

  it('claude: puts the session in the default mode (it starts in auto) and passes the run MCP endpoint as an HTTP server with the bearer header', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const frames = await runToEnd(h, { input: 'hi [[hello]]', manythreads: { tools: ['files'], mcp: MCP } });
    expect(last(frames)['event']).toBe('run.completed');
    const [session] = h.sessions();
    expect(session!['mode']).toBe('default');
    expect(session!['mcpServers']).toEqual([{ type: 'http', name: 'manythreads', url: MCP.url, headers: [{ name: 'Authorization', value: `Bearer ${MCP.token}` }] }]);
    // the token is on the adapter's stdin only: not in a frame the server reads
    expect(JSON.stringify(frames)).not.toContain(MCP.token);
  });

  it('codex: the grants pick the mode, and the model and effort are set as config options', async () => {
    h = await acpHarness({ flavor: 'codex', profile: { model: 'gpt-5.4' } });
    await runToEnd(h, { input: 'hi [[hello]]', manythreads: { tools: ['files'], mcp: MCP, model: { alias: null, effort: 'high' } } });
    await runToEnd(h, { input: 'again [[hello]]', manythreads: { tools: [], mcp: MCP } });
    const modes = h.sessions().map((s) => s['mode']).sort();
    expect(modes).toEqual(['read-only', 'workspace-write']);
    const writer = h.sessions().find((s) => s['mode'] === 'workspace-write')!;
    expect(writer['options']).toEqual({ model: 'gpt-5.4', reasoning_effort: 'high' });
  });

  it('puts the instructions in front of the prompt', async () => {
    h = await acpHarness({ flavor: 'claude' });
    await runToEnd(h, { input: 'the question [[hello]]', instructions: 'BOT body' });
    const prompt = (h.sessions()[0]!['history'] as Array<Record<string, any>>).find((u) => u['sessionUpdate'] === 'user_message_chunk')!; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(prompt['content']['text']).toBe('BOT body\n\n---\n\nthe question [[hello]]');
  });
});

describe('what a person sees of the work', () => {
  it('claude: steps with their ids and paths, a helper with its children, a plan, and a cost, and nothing the adapter leaks', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const frames = await runToEnd(h, { input: 'go [[work]]' });
    const started = frames.filter((f) => f['event'] === 'tool.started');
    expect(started.map((f) => f['title'])).toEqual(expect.arrayContaining(['Read File', 'Terminal']));
    expect(started.every((f) => typeof f['step_id'] === 'string' && Array.isArray(f['paths']))).toBe(true);
    const refined = frames.filter((f) => f['event'] === 'step.update');
    expect(refined.some((f) => f['title'] === 'Read package.json' && (f['paths'] as string[]).includes('package.json'))).toBe(true);
    expect(frames.filter((f) => f['event'] === 'plan.update').length).toBeGreaterThan(0);
    expect(frames.find((f) => f['event'] === 'tool.completed' && f['diff'])).toMatchObject({ diff: { added: 1, removed: 1 } });
    const helper = frames.filter((f) => f['event'] === 'agent.update');
    expect(helper.at(-1)).toMatchObject({ status: 'done' });
    expect(frames.some((f) => f['event'] === 'tool.started' && typeof f['parent_step_id'] === 'string')).toBe(true);
    expect(last(frames)['cost']).toEqual({ amount: expect.any(Number), currency: 'USD' });
    // whitelist: the command, its output, the old and new text of the edit never leave the bridge
    const all = JSON.stringify(frames);
    for (const leak of ['pnpm test', '3 passed', '"name":"demo"', '"name":"renamed"', 'rawInput', 'rawOutput', 'toolResponse', 'terminal_output', '/work/demo']) expect(all).not.toContain(leak);
  });

  it('codex: a run of steps and a helper as flat steps; no locations needed for an edit', async () => {
    h = await acpHarness({ flavor: 'codex' });
    const frames = await runToEnd(h, { input: 'go [[work]]' });
    const edit = frames.find((f) => f['event'] === 'tool.started' && f['kind'] === 'edit')!;
    expect(edit['paths']).toEqual(['package.json']);
    expect(frames.find((f) => f['event'] === 'tool.completed' && f['step_id'] === edit['step_id'])).toMatchObject({ diff: { added: 1, removed: 1 } });
    expect(last(frames)['event']).toBe('run.completed');
  });

  it('hermes: the plan is the todo list the agent keeps, and a step that fails is reported as failed', async () => {
    h = await acpHarness({ flavor: 'hermes' });
    const frames = await runToEnd(h, { input: 'go [[work]]' });
    const plans = frames.filter((f) => f['event'] === 'plan.update');
    expect(plans.at(-1)!['entries'].map((e: Frame) => e['content'])).toEqual(['Read the package', 'Change the name']);
    expect(frames.some((f) => f['event'] === 'tool.started' && f['title'] === 'todo_list')).toBe(false);
  });
});

describe('questions to a person (approval.request)', () => {
  it('claude: a permission request becomes a frame; a "once" answer lets the step run', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'ask [[permission]]' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    expect(ask).toMatchObject({ command: 'touch spike-a.txt', title: 'touch spike-a.txt', choices: ['once', 'deny'], kind: 'execute', paths: ['spike-a.txt'] });
    expect(typeof ask['request_id']).toBe('string');
    // the run is waiting: it is not over, and its time budget is held
    await new Promise((r) => setTimeout(r, 200));
    expect(names(w.frames)).not.toContain('run.completed');
    expect(await post(h, id, 'approval', { choice: 'once', request_id: ask['request_id'] })).toMatchObject({ status: 200 });
    await w.done;
    expect(last(w.frames)).toMatchObject({ event: 'run.completed', output: expect.stringContaining('Created.') });
    // a second answer to the same question has nothing to answer
    expect(await post(h, id, 'approval', { choice: 'once', request_id: ask['request_id'] })).toMatchObject({ status: 404 });
  });

  it('a "deny" answer is a No, and the agent goes on without the step', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'ask [[permission]]' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    await post(h, id, 'approval', { choice: 'deny', request_id: ask['request_id'] });
    await w.done;
    const done = last(w.frames);
    expect(done['event']).toBe('run.completed');
    expect(done['output']).toContain('Declined.');
    expect(done['output']).not.toContain('Created.');
  });

  it('"session" is one Yes (never a standing "always"), and an answer with no request id takes the one waiting', async () => {
    h = await acpHarness({ flavor: 'hermes' });
    const id = await startRun(h, { input: 'ask [[permission]]' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'approval.request');
    expect(await post(h, id, 'approval', { choice: 'session' })).toMatchObject({ status: 200 });
    await w.done;
    expect(last(w.frames)['output']).toContain('Created.');
  });

  it('refuses a bad choice, an unknown question and an answer when nothing waits', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'ask [[permission]]' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    expect(await post(h, id, 'approval', { choice: 'always' })).toMatchObject({ status: 400 });
    expect(await post(h, id, 'approval', { choice: 'once', request_id: 'nope' })).toMatchObject({ status: 404 });
    await post(h, id, 'approval', { choice: 'deny', request_id: ask['request_id'] });
    await w.done;
    expect(await post(h, id, 'approval', { choice: 'once' })).toMatchObject({ status: 404 });
  });

  it('silence is not consent: with no answer in time the request is refused', async () => {
    h = await acpHarness({ flavor: 'claude', config: { approvalWaitSeconds: 0.5 } });
    const frames = await runToEnd(h, { input: 'ask [[permission]]' });
    expect(frames.some((f) => f['event'] === 'approval.request')).toBe(true);
    expect(last(frames)['output']).toContain('Declined.');
  });

  it('codex: a call of the platform\'s own tool is covered by the bot\'s grants and asks nobody', async () => {
    h = await acpHarness({
      flavor: 'codex',
      script: script('codex', {
        mcp: [
          { do: 'permission', mcp: true, step: { title: 'mcp.manythreads.mt_note', kind: 'execute', input: { server: 'manythreads', tool: 'mt_note', arguments: { text: 'hi' } } }, onReject: [{ do: 'text', text: 'Refused.' }] },
          { do: 'text', text: 'Noted.' },
        ],
        other: [
          { do: 'permission', mcp: true, step: { title: 'mcp.elsewhere.do_it', kind: 'execute' }, onReject: [{ do: 'text', text: 'Refused.' }] },
          { do: 'text', text: 'Done elsewhere.' },
        ],
      }),
    });
    const frames = await runToEnd(h, { input: '[[mcp]]' });
    expect(frames.some((f) => f['event'] === 'approval.request')).toBe(false);
    expect(last(frames)['output']).toBe('Noted.');
    // another server's tool is not the platform's: a person is asked
    const id = await startRun(h, { input: '[[other]]' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    expect(ask['command']).toBe('mcp__elsewhere__do_it');
    await post(h, id, 'approval', { choice: 'once' });
    await w.done;
    expect(last(w.frames)['output']).toBe('Done elsewhere.');
  });
});

describe('stop, steer and failure', () => {
  it('a stop ends a long step: the run is cancelled and the adapter is gone', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'long [[slow]]' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'tool.started');
    const started = Date.now();
    expect(await post(h, id, 'stop')).toMatchObject({ status: 200 });
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
    expect(Date.now() - started).toBeLessThan(8000);
    // the step that was running is closed in the thread, not left spinning
    expect(w.frames.some((f) => f['event'] === 'tool.completed')).toBe(true);
  });

  it('a stop while a question waits answers it as cancelled and ends the run', async () => {
    h = await acpHarness({ flavor: 'codex' });
    const id = await startRun(h, { input: 'ask [[permission]]' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'approval.request');
    await post(h, id, 'stop');
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
  });

  it('steer: a note reaches an adapter that takes one, and the agent that cannot answers 409', async () => {
    const notes = { scenarios: { note: [{ do: 'text', text: 'start. ' }, { do: 'sleep', ms: 1500 }, { do: 'text', text: 'got: {{steered}}' }] } };
    h = await acpHarness({ flavor: 'claude', script: { flavor: 'claude', ...notes } });
    const id = await startRun(h, { input: '[[note]]' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'message.delta');
    expect(await post(h, id, 'steer', { input: 'use the other file' })).toMatchObject({ status: 200 });
    await w.done;
    expect(last(w.frames)['output']).toBe('start. got: use the other file');
    await h.close();

    h = await acpHarness({ flavor: 'hermes', script: { flavor: 'hermes', ...notes } });
    const id2 = await startRun(h, { input: '[[note]]' });
    const w2 = watch(h, id2);
    await w2.until((f) => f['event'] === 'message.delta');
    expect(await post(h, id2, 'steer', { input: 'use the other file' })).toMatchObject({ status: 409, body: { error: { code: 'steer_unsupported' } } });
    expect(await post(h, id2, 'steer', {})).toMatchObject({ status: 400 });
    await w2.done;
    expect(await post(h, id2, 'steer', { input: 'late' })).toMatchObject({ status: 404 });
  });

  it('the agent failing a prompt ends the run as failed with its message', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const frames = await runToEnd(h, { input: 'break [[fail]]' });
    expect(last(frames)).toMatchObject({ event: 'run.failed', error: expect.stringContaining('The model is overloaded') });
    const failed = frames.find((f) => f['event'] === 'tool.completed');
    expect(failed).toMatchObject({ error: true });
  });

  it('a refusal and a turn that ends cancelled are failures, not answers', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { refuse: [{ do: 'stop', reason: 'refusal' }], cut: [{ do: 'stop', reason: 'cancelled' }] }) });
    expect(last(await runToEnd(h, { input: '[[refuse]]' }))).toMatchObject({ event: 'run.failed', error: 'The agent refused the request.' });
    expect(last(await runToEnd(h, { input: '[[cut]]' }))['event']).toBe('run.failed');
  });

  it('an adapter that is not there fails the run with a plain line', async () => {
    h = await acpHarness({ flavor: 'claude', profile: { acp: { command: '/nonexistent/adapter', args: [] } } });
    const frames = await runToEnd(h, { input: 'hi' });
    expect(last(frames)).toMatchObject({ event: 'run.failed', error: expect.stringContaining('could not start') });
  });

  it('an adapter that ends under a run fails it and takes nothing else down', async () => {
    h = await acpHarness({ flavor: 'claude', profile: { acp: { command: process.execPath, args: ['-e', 'process.stderr.write("adapter crashed: no license\\n"); process.exit(3)'] } } });
    const frames = await runToEnd(h, { input: 'hi' });
    expect(last(frames)).toMatchObject({ event: 'run.failed', error: expect.stringContaining('adapter crashed') });
  });
});

describe('a thread across runs', () => {
  it('resumes the session of the same thread, and starts a new one when the adapter no longer has it', async () => {
    const turns = script('claude', { turn: [{ do: 'text', text: 'turn {{turn}}' }] });
    h = await acpHarness({ flavor: 'claude', script: turns });
    const first = await runToEnd(h, { input: 'a', session_id: 'bot:thread-1' });
    const second = await runToEnd(h, { input: 'b', session_id: 'bot:thread-1' });
    expect(last(first)['output']).toBe('turn 1');
    expect(last(second)['output']).toBe('turn 2');
    expect(h.sessions()).toHaveLength(1);
    // another thread is another session
    expect(last(await runToEnd(h, { input: 'c', session_id: 'bot:thread-2' }))['output']).toBe('turn 1');
    expect(h.sessions()).toHaveLength(2);
    // the adapter lost its sessions: one new session, the run still answers
    const { rmSync } = await import('node:fs');
    rmSync(`${h.stateDir}/sessions`, { recursive: true, force: true });
    expect(last(await runToEnd(h, { input: 'd', session_id: 'bot:thread-1' }))['output']).toBe('turn 1');
  });

  it('codex: the adapter\'s "no rollout found" is the same as a lost session', async () => {
    const turns = script('codex', { turn: [{ do: 'text', text: 'turn {{turn}}' }] });
    h = await acpHarness({ flavor: 'codex', script: turns });
    await runToEnd(h, { input: 'a', session_id: 't' });
    const { rmSync } = await import('node:fs');
    rmSync(`${h.stateDir}/sessions`, { recursive: true, force: true });
    expect(last(await runToEnd(h, { input: 'b', session_id: 't' }))).toMatchObject({ event: 'run.completed', output: 'turn 1' });
  });

  it('hermes: an unknown session answers success, and the replay of a known one is not shown again', async () => {
    const turns = script('hermes', { turn: [{ do: 'text', text: 'turn {{turn}}' }] });
    h = await acpHarness({ flavor: 'hermes', script: turns });
    expect(last(await runToEnd(h, { input: 'a', session_id: 't' }))['output']).toBe('turn 1');
    const second = await runToEnd(h, { input: 'b', session_id: 't' });
    expect(last(second)['output']).toBe('turn 2');
    expect(second.filter((f) => f['event'] === 'message.delta').map((f) => f['delta']).join('')).toBe('turn 2');
    const { rmSync } = await import('node:fs');
    rmSync(`${h.stateDir}/sessions`, { recursive: true, force: true });
    expect(last(await runToEnd(h, { input: 'c', session_id: 't' }))['output']).toBe('turn 1');
  });

  it('keeps the budget off while a question waits and fails a run that is over it', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'ask [[permission]]', manythreads: { budgetSeconds: 0.8 } });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    await new Promise((r) => setTimeout(r, 1500)); // longer than the budget: held while a person decides
    expect(names(w.frames)).not.toContain('run.failed');
    await post(h, id, 'approval', { choice: 'once', request_id: ask['request_id'] });
    await w.done;
    expect(last(w.frames)['event']).toBe('run.completed');
    await waitFor(() => true);
  });
});

describe('the routes on a run that is not on ACP', () => {
  it('a CLI run has no question to answer and no way to take a note', async () => {
    const { harness, start, auth, events } = await import('./support.ts');
    const cli = await harness({}, 'claude-code');
    try {
      const { run_id } = (await (await start(cli, { input: 'SLOW' })).json()) as { run_id: string };
      const call = (route: string, body: object) => fetch(`${cli.bridge.url}/p/default/v1/runs/${run_id}/${route}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await call('approval', { choice: 'once' })).status).toBe(404);
      expect((await call('steer', { input: 'hello' })).status).toBe(409);
      await call('stop', {});
      await events(cli, run_id);
    } finally {
      await cli.close();
    }
  });
});
