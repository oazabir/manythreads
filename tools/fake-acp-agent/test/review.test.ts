import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeScript } from '../src/script.ts';
import { OURS, harness, start, waitFor } from './helpers.ts';

/* What the review of P25-03 asked the fake agent to do like the real adapters: a cancel that comes early or late, and the faults a client has to answer. */

const say = (agent: Parameters<Parameters<ReturnType<typeof harness>['run']>[0]>[0], sessionId: string, text: string) =>
  agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'fake-acp-review-'));
  dirs.push(d);
  return d;
};

const SLOW: FakeScript['scenarios'] = {
  slow: [{ do: 'text', text: 'start' }, { do: 'step', title: 'sleep 60', kind: 'execute', toolName: 'Bash', input: { command: 'sleep 60' }, ms: 60_000 }, { do: 'text', text: 'never' }],
  hello: [{ do: 'text', text: 'hello' }],
};

describe('session/cancel that comes early', () => {
  it('a prompt that was queued behind a running one when the cancel came ends cancelled, and never starts', async () => {
    const h = harness({ flavor: 'claude', scenarios: SLOW, default: 'slow' });
    const started = Date.now();
    const answers = await h.run(async (agent) => {
      const sessionId = await start(agent);
      const first = say(agent, sessionId, '[[slow]]');
      const second = say(agent, sessionId, '[[hello]]');
      await waitFor(() => h.updates.some((u) => u.sessionUpdate === 'tool_call'));
      await agent.notify('session/cancel', { sessionId });
      return Promise.all([first, second]);
    });
    expect(answers.map((a) => a.stopReason)).toEqual(['cancelled', 'cancelled']);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(h.updates.some((u) => u.sessionUpdate === 'agent_message_chunk' && (u.content as { text: string }).text === 'hello')).toBe(false);
  });

  it('a prompt sent after the cancel runs normally', async () => {
    const h = harness({ flavor: 'codex', scenarios: SLOW, default: 'slow' });
    const answer = await h.run(async (agent) => {
      const sessionId = await start(agent);
      const first = say(agent, sessionId, '[[slow]]');
      await waitFor(() => h.updates.some((u) => u.sessionUpdate === 'tool_call'));
      await agent.notify('session/cancel', { sessionId });
      await first;
      return say(agent, sessionId, '[[hello]]');
    });
    expect(answer.stopReason).toBe('end_turn');
  });

  it('a question is not sent once the turn was cancelled, unless the adapter was already inside the call', async () => {
    const late = (ignoreCancel: boolean): FakeScript['scenarios'] => ({
      late: [
        { do: 'sleep', ms: 400, uninterruptible: true },
        { do: 'permission', ignoreCancel, step: { title: 'touch a', kind: 'execute', toolName: 'Bash', input: { command: 'touch a' } }, onReject: [] },
      ],
    });
    for (const ignoreCancel of [false, true]) {
      const h = harness({ flavor: 'claude', scenarios: late(ignoreCancel), default: 'late' }, { permission: 'allow_once' });
      const answer = await h.run(async (agent) => {
        const sessionId = await start(agent);
        const pending = say(agent, sessionId, 'go');
        await new Promise((r) => setTimeout(r, 100));
        await agent.notify('session/cancel', { sessionId });
        return pending;
      });
      // already inside the call, the adapter takes the answer and goes on: only the one that checks the cancel first ends it
      if (!ignoreCancel) expect(answer.stopReason).toBe('cancelled');
      expect(h.permissions.length, `ignoreCancel ${ignoreCancel}`).toBe(ignoreCancel ? 1 : 0);
    }
  });
});

describe('a step that starts a command', () => {
  async function ran(flavor: 'claude' | 'codex' | 'hermes') {
    const stateDir = folder();
    const cwd = folder();
    const script: FakeScript = {
      flavor,
      stateDir,
      scenarios: { run: [{ do: 'step', title: 'sleep 60', kind: 'execute', toolName: 'Bash', input: { command: 'sleep 60' }, ms: 60_000, spawn: 'child.pid' }] },
      default: 'run',
    };
    const h = harness(script);
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const { sessionId } = await agent.request('session/new', { cwd, mcpServers: [] });
      const pending = say(agent, sessionId, 'go');
      await waitFor(() => existsSync(join(cwd, 'child.pid')));
      const pid = Number(readFileSync(join(cwd, 'child.pid'), 'utf8'));
      pids.push(pid);
      expect(alive(pid)).toBe(true);
      await agent.notify('session/cancel', { sessionId });
      expect((await pending).stopReason).toBe('cancelled');
      await new Promise((r) => setTimeout(r, 150));
      return pid;
    }).then((pid) => (ranPid = pid));
    return ranPid;
  }
  let ranPid = 0;

  it('claude and hermes end the command when the turn is cancelled', async () => {
    for (const flavor of ['claude', 'hermes'] as const) expect(alive(await ran(flavor)), flavor).toBe(false);
  });

  it('codex leaves it running (measured): only the end of the process group takes it', async () => {
    expect(alive(await ran('codex'))).toBe(true);
  });
});

describe('faults', () => {
  it('set_mode answers an error; set_config_option takes the id unless it is refused too', async () => {
    const h = harness({ flavor: 'claude', scenarios: SLOW, faults: { setMode: true, setConfig: ['effort'] } });
    await h.run(async (agent) => {
      const sessionId = await start(agent);
      await expect(agent.request('session/set_mode', { sessionId, modeId: 'plan' })).rejects.toMatchObject({ code: -32603 });
      await agent.request('session/set_config_option', { sessionId, configId: 'mode', value: 'plan' });
      await expect(agent.request('session/set_config_option', { sessionId, configId: 'effort', value: 'high' })).rejects.toMatchObject({ code: -32603 });
    });
  });

  it('noResume and noHttp are what initialize advertises; open makes resume and load fail with that error', async () => {
    const stateDir = folder();
    const base: FakeScript = { flavor: 'claude', stateDir, scenarios: SLOW };
    const caps = async (script: FakeScript) => {
      const h = harness(script);
      return h.run(async (agent) => ((await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS })) as { agentCapabilities: Record<string, any> }).agentCapabilities); // eslint-disable-line @typescript-eslint/no-explicit-any
    };
    const normal = await caps(base);
    expect(normal.sessionCapabilities).toHaveProperty('resume');
    expect(normal.mcpCapabilities.http).toBe(true);
    const faulty = await caps({ ...base, faults: { noResume: true, noHttp: true } });
    expect(faulty.sessionCapabilities ?? {}).not.toHaveProperty('resume');
    expect(faulty.mcpCapabilities.http).toBe(false);

    // a session that exists, then an error on opening it
    const first = harness(base);
    const sessionId = await first.run(async (agent) => {
      const id = await start(agent);
      await say(agent, id, '[[hello]]');
      return id;
    });
    const second = harness({ ...base, faults: { open: { code: -32603, message: 'Model not found' } } });
    await second.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      await expect(agent.request('session/resume', { sessionId, cwd: '/w', mcpServers: [] })).rejects.toMatchObject({ code: -32603, message: 'Model not found' });
      await expect(agent.request('session/load', { sessionId, cwd: '/w', mcpServers: [] })).rejects.toMatchObject({ message: 'Model not found' });
    });
  });
});
