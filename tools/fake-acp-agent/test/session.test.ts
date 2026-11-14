import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientContext } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCRIPT, type FakeScript, type Flavor } from '../src/script.ts';
import { OURS, harness, kinds, start } from './helpers.ts';

/* Sessions: new, resume and load in another process (a second agent over the same state dir), unknown ids, list, modes, what the client sent. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scriptFor(flavor: Flavor): FakeScript {
  const stateDir = mkdtempSync(join(tmpdir(), 'fake-acp-'));
  dirs.push(stateDir);
  return { ...DEFAULT_SCRIPT, flavor, stateDir };
}

const say = (agent: ClientContext, sessionId: string, text: string) => agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });

/** The first process works and ends. A second one (same state dir) resumes or loads. */
async function earlier(script: FakeScript): Promise<string> {
  const h = harness(script);
  return h.run(async (agent) => {
    const sessionId = await start(agent);
    await say(agent, sessionId, '[[work]]');
    return sessionId;
  });
}

describe('session/new', () => {
  it('keeps what the client sent (cwd, the MCP server with its header, _meta) for a test to look at', async () => {
    const h = harness(DEFAULT_SCRIPT);
    const mcp = { type: 'http', name: 'manythreads', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer test' }] };
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      await agent.request('session/new', {
        cwd: '/work/a',
        mcpServers: [mcp as never],
        _meta: { claudeCode: { options: { extraArgs: { restricted: null, 'strict-mcp-config': null } } } },
      });
    });
    const call = h.fake.received.find((r) => r.method === 'session/new');
    expect(call?.params).toMatchObject({ cwd: '/work/a', mcpServers: [mcp], _meta: { claudeCode: { options: { extraArgs: { 'strict-mcp-config': null } } } } });
  });

  it('returns the adapter modes and lets the client set one', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor: 'codex' });
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const s = await agent.request('session/new', { cwd: '/w', mcpServers: [] });
      expect(s.modes).toMatchObject({
        currentModeId: 'agent',
        availableModes: [{ id: 'read-only' }, { id: 'workspace-write' }, { id: 'agent' }, { id: 'agent-full-access' }],
      });
      await agent.request('session/set_mode', { sessionId: s.sessionId, modeId: 'workspace-write' });
    });
    expect(h.fake.received.some((r) => r.method === 'session/set_mode')).toBe(true);
  });

  it('prompts of one session run one after another', async () => {
    const h = harness({
      scenarios: {
        a: [
          { do: 'step', title: 'one', ms: 60 },
          { do: 'text', text: '{{turn}}' },
        ],
      },
    });
    await h.run(async (agent) => {
      const sessionId = await start(agent);
      await Promise.all([say(agent, sessionId, 'a'), say(agent, sessionId, 'b')]);
    });
    const order = h.updates
      .filter((u) => u.sessionUpdate === 'agent_message_chunk' || u.sessionUpdate === 'tool_call')
      .map((u) => (u.sessionUpdate === 'tool_call' ? 'step' : (u.content as { text: string }).text));
    expect(order).toEqual(['step', '1', 'step', '2']);
  });
});

describe('resume and load in a new process', () => {
  it('claude: resume replays nothing, keeps the turn and cost counters, and answers with the session id', async () => {
    const script = scriptFor('claude');
    const sessionId = await earlier(script);
    const h = harness(script);
    const resumed = await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const r = await agent.request('session/resume', { sessionId, cwd: '/work/other', mcpServers: [] });
      await say(agent, sessionId, '[[hello]]');
      return r;
    });
    expect(resumed).toMatchObject({ sessionId });
    expect(kinds(h.updates)).toEqual(['agent_message_chunk', 'agent_message_chunk', 'agent_message_chunk', 'usage_update']);
    expect(h.updates.find((u) => u.sessionUpdate === 'usage_update')).toMatchObject({ cost: { amount: 0.0038 + 0.001 } });
  });

  it('claude and codex: load replays the messages only, user and agent', async () => {
    for (const flavor of ['claude', 'codex'] as const) {
      const script = scriptFor(flavor);
      const sessionId = await earlier(script);
      const h = harness(script);
      await h.run(async (agent) => {
        await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
        await agent.request('session/load', { sessionId, cwd: '/w', mcpServers: [] });
      });
      const seen = new Set(kinds(h.updates));
      expect([...seen].sort()).toEqual(['agent_message_chunk', 'user_message_chunk']);
      expect(h.updates[0]).toMatchObject({ sessionUpdate: 'user_message_chunk', content: { text: '[[work]]' } });
    }
  });

  it('codex: resume answers without a session id and replays nothing', async () => {
    const script = scriptFor('codex');
    const sessionId = await earlier(script);
    const h = harness(script);
    const r = await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      return agent.request('session/resume', { sessionId, cwd: '/w', mcpServers: [] });
    });
    expect(r).not.toHaveProperty('sessionId');
    expect(h.updates).toEqual([]);
  });

  it('hermes: resume replays the whole history, steps included, and says it found the session', async () => {
    const script = scriptFor('hermes');
    const sessionId = await earlier(script);
    const h = harness(script);
    const r = await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      return agent.request('session/resume', { sessionId, cwd: '/w', mcpServers: [] });
    });
    expect(kinds(h.updates)).toContain('tool_call');
    expect(kinds(h.updates)[0]).toBe('user_message_chunk');
    expect(r._meta).toMatchObject({ hermes: { sessionProvenance: { acpSessionId: sessionId } } });
  });

  it('unknown ids: claude -32002, codex -32603 with details, hermes no error', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const claude = harness(DEFAULT_SCRIPT);
    await claude.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      await expect(agent.request('session/resume', { sessionId: id, cwd: '/w', mcpServers: [] })).rejects.toMatchObject({
        code: -32002,
        message: 'Resource not found',
        data: { sessionId: id },
      });
      await expect(agent.request('session/load', { sessionId: id, cwd: '/w', mcpServers: [] })).rejects.toMatchObject({ code: -32002 });
    });
    const codex = harness({ ...DEFAULT_SCRIPT, flavor: 'codex' });
    await codex.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      await expect(agent.request('session/resume', { sessionId: id, cwd: '/w', mcpServers: [] })).rejects.toMatchObject({
        code: -32603,
        message: 'Internal error',
        data: { details: `no rollout found for thread id ${id}` },
      });
    });
    const hermes = harness({ ...DEFAULT_SCRIPT, flavor: 'hermes' });
    await hermes.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const resumed = await agent.request('session/resume', { sessionId: id, cwd: '/w', mcpServers: [] });
      expect(resumed).toHaveProperty('modes');
      expect(resumed).not.toHaveProperty('_meta');
      await expect(agent.request('session/load', { sessionId: id + '1', cwd: '/w', mcpServers: [] })).resolves.toEqual({});
    });
  });

  it('lists the sessions of a folder, and delete forgets one', async () => {
    const script = scriptFor('claude');
    const h = harness(script);
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      const a = await agent.request('session/new', { cwd: '/w/a', mcpServers: [] });
      await agent.request('session/new', { cwd: '/w/b', mcpServers: [] });
      const listed = await agent.request('session/list', { cwd: '/w/a' });
      expect(listed.sessions.map((s) => s.sessionId)).toEqual([a.sessionId]);
      await agent.request('session/delete', { sessionId: a.sessionId });
      expect((await agent.request('session/list', { cwd: '/w/a' })).sessions).toEqual([]);
    });
  });
});
