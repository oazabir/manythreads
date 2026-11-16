import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAIN, chainScript, writeChainScripts } from '../src/chain.ts';
import type { FakeScript } from '../src/script.ts';
import { harness, texts } from './helpers.ts';

/* P27-19: the `mcp` and `run` actions and the chain's per-bot scripts, against a small MCP server that records the calls it gets. */

const CARD = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Call {
  tool: string;
  args: Record<string, unknown>;
  auth: string | undefined;
}
/** `answer` decides what each tool says; the default is `{ ok: true }` with a card and a board id in it. */
async function mcpServer(answer: (call: Call) => unknown = () => ({ ok: true, task: { id: CARD }, board: { id: 'board-1' } })): Promise<{ url: string; calls: Call[] }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; params: { name: string; arguments: Record<string, unknown> } };
      const call: Call = { tool: rpc.params.name, args: rpc.params.arguments, auth: req.headers.authorization };
      calls.push(call);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(answer(call)) }] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}

/** One prompt against a script with the MCP server given to the session; returns what the agent sent. */
async function play(script: FakeScript, mcp: { url: string }, prompt: string, cwd = process.cwd()) {
  const h = harness(script);
  await h.run(async (agent) => {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const s = await agent.request('session/new', { cwd, mcpServers: [{ type: 'http', name: 'manythreads', url: mcp.url, headers: [{ name: 'Authorization', value: 'Bearer run-token' }] } as never] });
    await agent.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: prompt }] });
  });
  return h;
}

describe('the mcp action', () => {
  it('makes the call with the run token, fills {{var:..}} from an earlier answer and shows each call as a step', async () => {
    const mcp = await mcpServer();
    const script: FakeScript = {
      scenarios: {
        work: [
          { do: 'mcp', tool: 'tasks.create', args: { title: 'T', branch: 'b' }, store: 'card' },
          { do: 'mcp', tool: 'tasks.handoff', args: { taskId: '{{var:card.task.id}}', toBotSlug: 'coder', note: 'from {{promptId}}' } },
          { do: 'text', text: 'done {{var:card.task.id}}' },
        ],
      },
    };
    const h = await play(script, mcp, `please look at ${CARD}`);
    expect(mcp.calls.map((c) => c.tool)).toEqual(['tasks.create', 'tasks.handoff']);
    expect(mcp.calls[0]!.auth).toBe('Bearer run-token');
    expect(mcp.calls[1]!.args).toEqual({ taskId: CARD, toBotSlug: 'coder', note: `from ${CARD}` });
    expect(texts(h.updates)).toBe(`done ${CARD}`);
    expect(h.updates.filter((u) => u.sessionUpdate === 'tool_call')).toHaveLength(2);
  });

  it('a refused call is a failed step and the script goes on', async () => {
    const mcp = await mcpServer(() => ({ ok: false, code: 'forbidden', message: 'no grant' }));
    const h = await play({ scenarios: { work: [{ do: 'mcp', tool: 'tasks.claim', args: {} }, { do: 'text', text: 'after' }] } }, mcp, 'go');
    const ended = h.updates.filter((u) => u.sessionUpdate === 'tool_call_update' && u.status);
    expect(ended.at(-1)).toMatchObject({ status: 'failed' });
    expect(texts(h.updates)).toBe('after');
  });

  it('a session with no MCP address fails the step without throwing', async () => {
    const h = harness({ scenarios: { work: [{ do: 'mcp', tool: 'tasks.claim' }, { do: 'text', text: 'after' }] } });
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const s = await agent.request('session/new', { cwd: process.cwd(), mcpServers: [] });
      await agent.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    });
    expect(texts(h.updates)).toBe('after');
    expect(h.updates.filter((u) => u.status === 'failed')).not.toHaveLength(0);
  });
});

describe('the run action', () => {
  it('runs a command in the session folder and keeps its exit code and output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-acp-run-'));
    dirs.push(dir);
    const mcp = await mcpServer();
    const h = await play(
      { scenarios: { work: [{ do: 'run', command: 'echo hello > out.txt && echo said-it', store: 'a' }, { do: 'run', command: 'exit 3', store: 'b' }, { do: 'text', text: 'a={{var:a.code}} b={{var:b.code}} {{var:a.out}}' }] } },
      mcp,
      'go',
      dir,
    );
    expect(existsSync(join(dir, 'out.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hello\n');
    expect(texts(h.updates).trim()).toBe('a=0 b=3 said-it');
  });
});

describe('the chain scripts', () => {
  it('every bot of the chain has one, and an unknown name is refused', () => {
    for (const { slug } of CHAIN) expect(chainScript(slug).scenarios['work']!.length).toBeGreaterThan(0);
    expect(() => chainScript('nobody')).toThrow(/no chain script/);
  });

  it('the engineer plans: board, plan message, two cards, the to-do list, a hand-off to the plan reviewer', async () => {
    const mcp = await mcpServer();
    const h = await play(chainScript('engineer'), mcp, 'Build a small page');
    expect(mcp.calls.map((c) => c.tool)).toEqual(['messages.search', 'boards.ensure', 'messages.post', 'tasks.create', 'tasks.create', 'tasks.todo', 'tasks.handoff']);
    expect(mcp.calls[3]!.args).toMatchObject({ boardId: 'board-1', branch: 'chain-demo' });
    expect(mcp.calls[5]!.args).toMatchObject({ action: 'set', items: [{ id: 'review', taskId: CARD }, { id: 'work', taskId: CARD }] });
    expect(mcp.calls[6]!.args).toMatchObject({ toBotSlug: 'plan-reviewer' });
    expect(texts(h.updates)).toContain('chain-ok');
  });

  it('a card is handed down the chain: each bot claims the card in its prompt and hands it to the next', async () => {
    for (const { slug, next } of CHAIN.filter((c) => c.slug !== 'engineer' && c.slug !== 'committer' && c.next !== null)) {
      const mcp = await mcpServer();
      await play(chainScript(slug), mcp, `Card ${CARD} is yours`);
      expect(mcp.calls[0]).toMatchObject({ tool: 'tasks.claim', args: { taskId: CARD } });
      expect(mcp.calls.at(-1)).toMatchObject({ tool: 'tasks.handoff', args: { taskId: CARD, toBotSlug: next } });
    }
  });

  it('the last bot completes the card and says so in the thread', async () => {
    const mcp = await mcpServer();
    await play(chainScript('web-smoke-tester'), mcp, `Card ${CARD}`);
    expect(mcp.calls.map((c) => c.tool)).toEqual(['tasks.claim', 'tasks.complete', 'messages.post']);
  });

  it('the committer runs mt-publish (check, then publish) and hands to the deployer even when the command is not there', async () => {
    const mcp = await mcpServer();
    const h = await play(chainScript('committer', { project: 'demo' }), mcp, `Card ${CARD}`);
    const commands = h.updates.filter((u) => u.sessionUpdate === 'tool_call' && String(u.title).startsWith('mt-publish')).map((u) => String(u.title));
    expect(commands[0]).toBe('mt-publish check demo');
    expect(commands[1]).toContain(`mt-publish publish demo ${CARD}`);
    expect(mcp.calls.at(-1)).toMatchObject({ tool: 'tasks.handoff', args: { toBotSlug: 'deployer' } });
  });

  it('writeChainScripts writes one loadable JSON file per bot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-acp-chain-'));
    dirs.push(dir);
    const files = writeChainScripts(dir);
    expect(Object.keys(files)).toEqual(CHAIN.map((c) => c.slug));
    expect(JSON.parse(readFileSync(files['coder']!, 'utf8'))).toMatchObject({ flavor: 'claude', default: 'work' });
  });
});
