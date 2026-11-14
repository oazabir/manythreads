import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acpHarness, nextScript, post, runToEnd, startRun, status, until, watch, type AcpHarness, type Flavor, type Frame } from './acp-support.ts';
import { alive } from './support.ts';

// The end-to-end half of the review of P25-03: the bridge's HTTP face, a run, the fake ACP agent as a child process.

let h: AcpHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const MCP = { url: 'https://example.test/mcp', token: 'run-token-SECRET-12345' };
const last = (frames: Frame[]): Frame => frames.at(-1)!;
const names = (frames: Frame[]): string[] => frames.map((f) => f['event'] as string);
const script = (flavor: Flavor, scenarios: Record<string, unknown[]>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ flavor, scenarios, default: Object.keys(scenarios)[0], ...extra });
const read = (n: string) => ({ do: 'step', title: `Read ${n}`, kind: 'read', toolName: 'Read', paths: [n] });

describe('maxTurns', () => {
  it('an ACP run is stopped and failed when the agent takes more turns than the bot may', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { busy: [{ do: 'text', text: 'Start. ' }, read('a'), read('b'), read('c'), read('d'), { do: 'step', title: 'sleep', kind: 'execute', toolName: 'Bash', input: { command: 'sleep 60' }, ms: 60_000 }, { do: 'text', text: 'never' }] }) });
    const started = Date.now();
    const frames = await runToEnd(h, { input: 'go', manythreads: { maxTurns: 3 } });
    expect(last(frames)).toMatchObject({ event: 'run.failed', error: 'turn limit exceeded' });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(JSON.stringify(frames)).not.toContain('never');
  });

  it('a run within the limit is not touched', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { busy: [{ do: 'text', text: 'Start. ' }, read('a'), read('b'), { do: 'text', text: 'Done.' }] }) });
    const frames = await runToEnd(h, { input: 'go', manythreads: { maxTurns: 10 } });
    expect(last(frames)).toMatchObject({ event: 'run.completed' });
  });
});

describe('the card shows what will run', () => {
  const command = "cat > .env <<'EOF'\nAPI_TOKEN=tok-VALUE-9\nurl=https://bob:pw-VALUE@host.test/p\nEOF\nrun --password hunter2-VALUE";

  it('a command of several lines, secrets out, and no other frame carries it', async () => {
    h = await acpHarness({
      flavor: 'claude',
      script: script('claude', { ask: [{ do: 'permission', step: { title: 'x', kind: 'execute', toolName: 'Bash', input: { command } }, onReject: [{ do: 'text', text: 'Declined.' }] }, { do: 'text', text: 'Ran.' }] }),
    });
    const id = await startRun(h, { input: 'go', manythreads: { mcp: MCP } });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    expect(ask['title']).toBe('Running cat');
    expect(ask['command']).toBe("cat > .env <<'EOF'\nAPI_TOKEN=[hidden]\nurl=https://[hidden]@host.test/p\nEOF\nrun --password [hidden]");
    await post(h, id, 'approval', { choice: 'once', request_id: ask['request_id'] });
    await w.done;
    const rest = w.frames.filter((f) => f['event'] !== 'approval.request');
    for (const leak of ['API_TOKEN', 'bob', 'hunter2', 'cat > .env', 'EOF']) expect(JSON.stringify(rest), leak).not.toContain(leak);
    expect(JSON.stringify(w.frames)).not.toContain('hunter2-VALUE');
  });

  it('a very long command is cut at about 2000 characters, with a mark that says so', async () => {
    const long = `echo start\n${'echo a-line-of-text-that-goes-on\n'.repeat(200)}echo END-OF-COMMAND`;
    h = await acpHarness({ flavor: 'claude', script: script('claude', { ask: [{ do: 'permission', step: { title: 'x', kind: 'execute', toolName: 'Bash', input: { command: long } }, onReject: [] }] }) });
    const id = await startRun(h, { input: 'go' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    const text = ask['command'] as string;
    expect(text.length).toBeLessThan(2200);
    expect(text.length).toBeGreaterThan(1900);
    expect(text).toMatch(/\n… \[cut: \d+ more characters not shown\]$/);
    expect(text).not.toContain('END-OF-COMMAND');
    await post(h, id, 'approval', { choice: 'deny' });
    await w.done;
  });

  it('codex: the request to implement a plan shows the plan, clipped and redacted', async () => {
    const plan = `## Plan\n\n1. Read the folder.\n2. Call the API with API_TOKEN=tok-VALUE-9.\n${'3. More.\n'.repeat(400)}`;
    h = await acpHarness({
      flavor: 'codex',
      script: script('codex', { ask: [{ do: 'permission', step: { title: 'Implement this plan?', kind: 'switch_mode', input: { plan } }, onReject: [{ do: 'text', text: 'Revised.' }] }, { do: 'text', text: 'Built.' }] }),
    });
    const id = await startRun(h, { input: 'go' });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    expect(ask).toMatchObject({ kind: 'switch_mode', title: 'Implement this plan?' });
    expect(ask['command']).toContain('1. Read the folder.\n2. Call the API with API_TOKEN=[hidden]');
    expect(ask['command']).toMatch(/\[cut: \d+ more characters not shown\]$/);
    expect(ask['command']).not.toContain('tok-VALUE-9');
    await post(h, id, 'approval', { choice: 'once' });
    await w.done;
  });
});

describe('nothing of the work leaks, whatever the adapter puts on the wire', () => {
  const VALUES = ['hunter2-VALUE', 'tok-VALUE-9', 'pw-VALUE', 'qv-VALUE', 'shadow-VALUE', 'person@example.test', 'THOUGHT-VALUE', 'OUTPUT-VALUE', 'deploy --force', 'API_TOKEN', MCP.token];
  const scenario = [
    { do: 'thought', text: 'THOUGHT-VALUE: I will use the secret.' },
    { do: 'text', text: 'First I look around. ' },
    { do: 'step', title: 'x', kind: 'execute', toolName: 'Bash', input: { command: 'deploy --force --password hunter2-VALUE API_TOKEN=tok-VALUE-9 https://bob:pw-VALUE@host.test/p?k=qv-VALUE' }, output: 'OUTPUT-VALUE person@example.test' },
    { do: 'step', title: 'Fetch https://bob:pw-VALUE@host.test/p?k=qv-VALUE', kind: 'fetch', toolName: 'WebFetch' },
    { do: 'step', title: 'Read /etc/shadow-VALUE', kind: 'read', toolName: 'Read', paths: ['/etc/shadow-VALUE'], output: 'OUTPUT-VALUE' },
    { do: 'step', title: 'Note {{mcpToken}}', kind: 'other', toolName: 'Tool' },
    { do: 'text', text: 'The token is {{mcpToken}} ok.' },
  ];

  for (const flavor of ['claude', 'codex', 'hermes'] as const) {
    it(`${flavor}: in no frame, in the status, nor in the failure that ends the run`, async () => {
      h = await acpHarness({ flavor, script: script(flavor, { leaky: [...scenario, { do: 'fail', message: 'boom {{mcpToken}}', code: -32603 }], fine: scenario }, { default: 'leaky' }) });
      for (const tag of ['leaky', 'fine']) {
        const id = await startRun(h, { input: `go [[${tag}]]`, manythreads: { mcp: MCP, tools: [] } });
        const w = watch(h, id);
        await w.done;
        const everything = JSON.stringify([w.frames, await status(h, id)]);
        for (const value of VALUES) expect(everything, `${flavor} ${tag}: ${value}`).not.toContain(value);
        expect(last(w.frames)['event']).toBe(tag === 'leaky' ? 'run.failed' : 'run.completed');
        if (tag === 'leaky') expect(last(w.frames)['error']).toContain('boom [hidden]');
        // what a person may read: the program, a link without its details, no named outside file
        const titles = w.frames.filter((f) => f['event'] === 'tool.started').map((f) => f['title']);
        expect(titles).toContain('Running deploy');
        expect(titles).toContain('Fetch https://host.test/p');
        expect(titles).toContain('Read a file outside the project');
        expect(titles).toContain('Note [hidden]');
        expect(w.frames.filter((f) => f['event'] === 'message.delta').map((f) => f['delta']).join('')).toContain('The token is [hidden] ok.');
      }
    });
  }
});

describe('text across steps', () => {
  it('is posted with a paragraph break where a step came between', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { talk: [{ do: 'text', text: 'Let me look.' }, read('a'), { do: 'text', text: 'Found it.' }, read('b'), { do: 'text', text: 'Done.' }] }) });
    const frames = await runToEnd(h, { input: 'go' });
    expect(last(frames)['output']).toBe('Let me look.\n\nFound it.\n\nDone.');
  });
});

describe('a session the adapter lost, and a resume that failed for another reason', () => {
  it('claude: "Model not found" fails the run and the thread keeps its session; the next run resumes it', async () => {
    const turns = script('claude', { turn: [{ do: 'text', text: 'turn {{turn}}' }] });
    h = await acpHarness({ flavor: 'claude', script: turns });
    expect(last(await runToEnd(h, { input: 'a', session_id: 't' }))['output']).toBe('turn 1');
    const mapping = (): string => readFileSync(join(h!.dir, 'state', 'sessions.json'), 'utf8');
    const before = mapping();
    expect(before).toContain('acp:claude-code:');
    nextScript({ ...turns, faults: { open: { code: -32603, message: 'Model not found' } } });
    expect(last(await runToEnd(h, { input: 'b', session_id: 't' }))).toMatchObject({ event: 'run.failed', error: expect.stringContaining('Model not found') });
    expect(mapping()).toBe(before);
    nextScript(turns);
    expect(last(await runToEnd(h, { input: 'c', session_id: 't' }))['output']).toBe('turn 2');
    // a session that really is gone is dropped and replaced
    nextScript({ ...turns, faults: { open: { code: -32002, message: 'Resource not found' } } });
    const replaced = await runToEnd(h, { input: 'd', session_id: 't' });
    expect(last(replaced)).toMatchObject({ event: 'run.completed' });
    expect(h.sessions().length).toBeGreaterThanOrEqual(2);
  });

  it('the adapter has no resume: the session is loaded, and its replay is not shown again', async () => {
    const turns = script('claude', { turn: [{ do: 'text', text: 'turn {{turn}}' }] }, { faults: { noResume: true } });
    h = await acpHarness({ flavor: 'claude', script: turns });
    await runToEnd(h, { input: 'a', session_id: 't' });
    const second = await runToEnd(h, { input: 'b', session_id: 't' });
    expect(last(second)['output']).toBe('turn 2');
    expect(second.filter((f) => f['event'] === 'message.delta').map((f) => f['delta']).join('')).toBe('turn 2');
    expect(h.sessions()).toHaveLength(1);
  });
});

describe('the mode, and what is wanted of the model', () => {
  it('a mode that set_mode refuses is set as a config option; both refused fails the run in plain words', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { hello: [{ do: 'text', text: 'ok' }] }, { faults: { setMode: true } }) });
    expect(last(await runToEnd(h, { input: 'a' }))['event']).toBe('run.completed');
    expect(h.sessions()[0]!['mode']).toBe('default');
    await h.close();
    h = await acpHarness({ flavor: 'claude', script: script('claude', { hello: [{ do: 'text', text: 'ok' }] }, { faults: { setMode: true, setConfig: ['mode'] } }) });
    expect(last(await runToEnd(h, { input: 'a' }))).toMatchObject({ event: 'run.failed', error: expect.stringContaining('Could not put the agent in "default" mode') });
  });

  it('an adapter that cannot take the platform\'s tools over HTTP fails the run before it starts', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { hello: [{ do: 'text', text: 'ok' }] }, { faults: { noHttp: true } }) });
    expect(last(await runToEnd(h, { input: 'a', manythreads: { mcp: MCP } }))).toMatchObject({ event: 'run.failed', error: "This agent's adapter cannot take the platform's tools over HTTP." });
    // with no platform tools asked for, it is fine
    expect(last(await runToEnd(h, { input: 'a' }))['event']).toBe('run.completed');
  });

  it('a model the profile pins that the adapter does not take fails the run; a bot\'s effort that it does not take is only logged', async () => {
    h = await acpHarness({ flavor: 'claude', profile: { model: 'no-such-model' } });
    const failed = last(await runToEnd(h, { input: 'a [[hello]]' }));
    expect(failed).toMatchObject({ event: 'run.failed', error: expect.stringContaining('did not take the model "no-such-model" that the profile pins') });
    await h.close();

    h = await acpHarness({ flavor: 'claude', profile: { model: 'opus' }, script: script('claude', { hello: [{ do: 'text', text: 'ok' }] }, { faults: { setConfig: ['effort'] } }) });
    const done = await runToEnd(h, { input: 'a', manythreads: { model: { alias: null, effort: 'high' } } });
    expect(last(done)['event']).toBe('run.completed');
    expect(h.sessions()[0]!['options']).toEqual({ model: 'opus' });
    expect(h.logs.some((l) => /did not take effort "high"/.test(l))).toBe(true);
    await h.close();

    // Hermes offers no model option at all: a pinned model cannot be set
    h = await acpHarness({ flavor: 'hermes', profile: { model: 'anthropic:x' } });
    expect(last(await runToEnd(h, { input: 'a [[hello]]' }))).toMatchObject({ event: 'run.failed', error: expect.stringContaining('does not let its model be chosen') });
  });
});

describe('the adapters the bridge cannot hold to the bot\'s grants', () => {
  it('opencode is refused with a plain line, and no process is started', async () => {
    h = await acpHarness({ flavor: 'claude', profile: { agent: 'opencode', acp: { command: '/nonexistent/opencode', args: ['acp'] } } });
    expect(last(await runToEnd(h, { input: 'hi' }))).toMatchObject({ event: 'run.failed', error: expect.stringContaining('OpenCode cannot run yet') });
  });

  it('hermes-acp is refused for a bot with fewer tools than its Hermes has, and runs for one with all of them', async () => {
    h = await acpHarness({ flavor: 'hermes', gives: undefined, profile: { acp: { command: process.execPath, args: ['-e', 'process.exit(9)'] } } });
    const refused = last(await runToEnd(h, { input: 'hi', manythreads: { tools: ['files'] } }));
    expect(refused).toMatchObject({ event: 'run.failed', error: expect.stringContaining('Hermes cannot be limited to less per run') });
    expect(refused['error']).toContain('run commands');
    expect(refused['error']).not.toContain('read and change files');
    await h.close();

    h = await acpHarness({ flavor: 'hermes', gives: ['files'] });
    expect(last(await runToEnd(h, { input: 'hi [[hello]]', manythreads: { tools: ['files'] } }))['event']).toBe('run.completed');
    expect(last(await runToEnd(h, { input: 'hi [[hello]]', manythreads: { tools: ['shell'] } }))['event']).toBe('run.failed');
  });
});

describe('a question that nobody answers', () => {
  it('claude and hermes: the request is refused after the wait, and a frame says the question ran out', async () => {
    for (const flavor of ['claude', 'hermes'] as const) {
      h = await acpHarness({ flavor, config: { approvalWaitSeconds: 0.5 } });
      const frames = await runToEnd(h, { input: 'ask [[permission]]' });
      const ask = frames.find((f) => f['event'] === 'approval.request')!;
      const expired = frames.find((f) => f['event'] === 'approval.expired')!;
      expect(expired).toMatchObject({ request_id: ask['request_id'], message: expect.stringContaining('refused') });
      expect(names(frames).indexOf('approval.expired')).toBeGreaterThan(names(frames).indexOf('approval.request'));
      expect(last(frames)['output']).toContain('Declined.');
      await h.close();
    }
    h = undefined;
  });
});

describe('stop', () => {
  it('before the session opens: the run is cancelled and the adapter is gone', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'go [[hello]]' });
    expect(await post(h, id, 'stop')).toMatchObject({ status: 200 });
    const w = watch(h, id);
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
  });

  it('while a question waits: the run is cancelled at once, the budget clock is not what ends it, and the question cannot be answered afterwards', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const id = await startRun(h, { input: 'ask [[permission]]', manythreads: { budgetSeconds: 30 } });
    const w = watch(h, id);
    const ask = await w.until((f) => f['event'] === 'approval.request');
    const t = Date.now();
    await post(h, id, 'stop');
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
    expect(Date.now() - t).toBeLessThan(5000);
    expect(await post(h, id, 'approval', { choice: 'once', request_id: ask['request_id'] })).toMatchObject({ status: 404 });
  });

  it('a question that comes after the stop is answered cancelled and never shown', async () => {
    const late = [{ do: 'text', text: 'working' }, { do: 'sleep', ms: 1200, uninterruptible: true }, { do: 'permission', ignoreCancel: true, step: { title: 'touch late.txt', kind: 'execute', toolName: 'Bash', input: { command: 'touch late.txt' } }, onReject: [] }, { do: 'text', text: 'after' }];
    h = await acpHarness({ flavor: 'claude', script: script('claude', { late }) });
    const id = await startRun(h, { input: 'go' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'message.delta');
    await post(h, id, 'stop');
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
    expect(names(w.frames)).not.toContain('approval.request');
  });

  it('a second stop does not push the kill back', async () => {
    h = await acpHarness({ flavor: 'claude', config: { cancelGraceSeconds: 1 } });
    const id = await startRun(h, { input: 'long [[slow]]' });
    const w = watch(h, id);
    await w.until((f) => f['event'] === 'tool.started');
    await post(h, id, 'stop');
    await post(h, id, 'stop');
    await post(h, id, 'stop');
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
  });

  it('codex leaves the command running after a cancel (measured): the end of the process group takes it', async () => {
    const pidFile = 'child.pid';
    h = await acpHarness({
      flavor: 'codex',
      script: script('codex', { work: [{ do: 'text', text: 'running' }, { do: 'step', title: 'sleep 60', kind: 'execute', toolName: 'Bash', input: { command: 'sleep 60' }, ms: 60_000, spawn: pidFile }] }),
    });
    const id = await startRun(h, { input: 'go' });
    const w = watch(h, id);
    const file = join(h.dir, 'work', pidFile);
    await until(() => {
      try {
        return Number(readFileSync(file, 'utf8')) > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(readFileSync(file, 'utf8'));
    expect(alive(pid)).toBe(true);
    await post(h, id, 'stop');
    await w.done;
    expect(last(w.frames)['event']).toBe('run.cancelled');
    await until(() => !alive(pid), 8000);
  });
});

describe('the budget', () => {
  it('an ACP run over its budget is stopped and failed, and its adapter is gone', async () => {
    h = await acpHarness({ flavor: 'claude' });
    const started = Date.now();
    const frames = await runToEnd(h, { input: 'long [[slow]]', manythreads: { budgetSeconds: 0.4 } });
    expect(last(frames)).toMatchObject({ event: 'run.failed', error: 'budget exceeded' });
    expect(Date.now() - started).toBeLessThan(12_000);
  });
});

describe('two runs at once', () => {
  it('each has its own adapter, its own questions and its own answer', async () => {
    h = await acpHarness({ flavor: 'claude', script: script('claude', { ask: [{ do: 'text', text: 'for {{prompt}}' }, { do: 'permission', step: { title: 'touch a.txt', kind: 'execute', toolName: 'Bash', input: { command: 'touch a.txt' } }, onReject: [{ do: 'text', text: 'No.' }] }, { do: 'text', text: 'Yes.' }] }) });
    const a = await startRun(h, { input: 'alpha', session_id: 'one' });
    const b = await startRun(h, { input: 'beta', session_id: 'two' });
    const wa = watch(h, a);
    const wb = watch(h, b);
    const askA = await wa.until((f) => f['event'] === 'approval.request');
    const askB = await wb.until((f) => f['event'] === 'approval.request');
    expect(askA['request_id']).not.toBe(askB['request_id']);
    // a question of the other run is not this run's to answer
    expect(await post(h, a, 'approval', { choice: 'once', request_id: askB['request_id'] })).toMatchObject({ status: 404 });
    await post(h, b, 'approval', { choice: 'deny', request_id: askB['request_id'] });
    await wb.done;
    expect(last(wb.frames)['output']).toContain('No.');
    expect(wa.frames.some((f) => f['event'] === 'run.completed')).toBe(false);
    await post(h, a, 'approval', { choice: 'once', request_id: askA['request_id'] });
    await wa.done;
    expect(last(wa.frames)['output']).toContain('for alpha');
    expect(last(wa.frames)['output']).toContain('Yes.');
    expect(last(wb.frames)['output']).toContain('for beta');
    expect(h.sessions()).toHaveLength(2);
  });
});
