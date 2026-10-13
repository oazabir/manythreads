import { HttpError, RunEndedError, type BotRunHandle, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { handleRpc } from '../src/protocol.ts';

// The JSON-RPC face without a database: what a run is offered, what a call does, and which failures are answers
// (isError content the model reads) versus transport errors (a JSON-RPC error envelope). The gateway's own
// decisions are all here; the database half (mint, resolve, RLS, the source log) is in gateway.test.ts.

const UUIDS = {
  run: '00000000-0000-4000-8000-000000000001',
  bot: '00000000-0000-4000-8000-000000000002',
  actor: '00000000-0000-4000-8000-000000000003',
  team: '00000000-0000-4000-8000-000000000004',
  workspace: '00000000-0000-4000-8000-000000000005',
};

const RUN: BotRunHandle = {
  runId: UUIDS.run,
  botId: UUIDS.bot,
  botActorId: UUIDS.actor,
  teamId: UUIDS.team,
  workspaceId: UUIDS.workspace,
  trigger: 'conversation',
  askerActorId: null,
  expiresAt: '2026-10-09T12:00:00.000Z',
};

type Decision = { allowed: boolean; reason: string; needsApproval: boolean };
const ALLOWED: Decision = { allowed: true, reason: 'granted', needsApproval: false };
const DENIED: Decision = { allowed: false, reason: 'no grant for "messages.search" in the actor’s allowlist', needsApproval: false };

function fakeContext(options: {
  tools: Array<{ name: string; destructive: boolean }>;
  decisions?: Record<string, Decision>;
  answer?: (name: string, input: Record<string, unknown>) => unknown;
  /** The approvals plugin's handler, when the deployment has it. */
  approvals?: { request: (tx: PluginTx, input: Record<string, unknown>) => Promise<{ approvalId: string; created: boolean }> };
}) {
  const invoked: Array<{ name: string; input: Record<string, unknown>; as: 'bot' | 'reader' }> = [];
  const logged: Array<{ sourceType: string; sourceRef: string; scope: string }> = [];
  /** What the broker would have judged each call by (`{ path }` for a mutation). */
  const authorized: Array<{ name: string; context: Record<string, unknown> }> = [];
  let current: 'bot' | 'reader' = 'bot';
  const tx = { actor: { kind: current, id: UUIDS.actor, workspaceId: UUIDS.workspace }, query: () => Promise.resolve({ rows: [] }) } as unknown as PluginTx;
  const runs = {
    catalog: () => options.tools,
    may: (_run: BotRunHandle, name: string) => Promise.resolve(options.decisions?.[name] ?? DENIED),
    authorize: (_run: BotRunHandle, name: string, context: Record<string, unknown> = {}) => {
      authorized.push({ name, context });
      return Promise.resolve(options.decisions?.[name] ?? DENIED);
    },
    asBot: async (_run: BotRunHandle, fn: (t: PluginTx) => Promise<unknown>) => {
      current = 'bot';
      return fn(tx);
    },
    asReader: async (_run: BotRunHandle, fn: (t: PluginTx) => Promise<unknown>) => {
      current = 'reader';
      return fn(tx);
    },
    invoke: (_tx: PluginTx, name: string, input: Record<string, unknown>) => {
      invoked.push({ name, input, as: current });
      return Promise.resolve(options.answer?.(name, input) ?? { hits: [] });
    },
    logSource: (_tx: PluginTx, source: { sourceType: string; sourceRef: string; scope: string }) => {
      logged.push(source);
      return Promise.resolve(logged.length);
    },
  };
  const providers = { get: (kind: string) => (kind === 'approvals' ? options.approvals : undefined) };
  const ctx = { manifest: { version: '0.1.0' }, runs, providers } as unknown as PluginContext;
  return { ctx, invoked, logged, authorized };
}

const body = async (res: { body?: unknown }): Promise<Record<string, unknown>> => res.body as Record<string, unknown>;

const SEARCH_TOOL = { name: 'messages.search', destructive: false };
const WRITE_TOOL = { name: 'pages.write', destructive: false };
const KNOWLEDGE_TOOL = { name: 'knowledge.search', destructive: false };

describe('gateway-mcp protocol', () => {
  it('initialize answers the MCP revision and the server name', async () => {
    const { ctx } = fakeContext({ tools: [] });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.status).toBe(200);
    const { result } = (await body(res)) as { result: { protocolVersion: string; serverInfo: { name: string; version: string }; capabilities: { tools: unknown } } };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: 'manythreads', version: '0.1.0' });
    expect(result.capabilities.tools).toEqual({ listChanged: false });
  });

  it('a notification is answered with 202 and no body', async () => {
    const { ctx } = fakeContext({ tools: [] });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.body).toBeUndefined();
  });

  it('tools/list offers only the tools the broker would allow, with their descriptions', async () => {
    const { ctx } = fakeContext({
      tools: [SEARCH_TOOL, WRITE_TOOL, KNOWLEDGE_TOOL],
      decisions: { 'messages.search': ALLOWED, 'pages.write': { allowed: true, reason: 'granted', needsApproval: true } },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 'a', method: 'tools/list' });
    const { result } = (await body(res)) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
    expect(result.tools.map((t) => t.name)).toEqual(['messages.search', 'pages.write']);
    expect(result.tools[0]!.inputSchema).toMatchObject({ properties: { query: { type: 'string' } }, required: ['query'] });
    // the approval flag reaches the model as copy, so it can prefer a path that does not wait for a person
    expect(result.tools[1]!.description).toContain('approval');
    expect(result.tools[0]!.description).not.toContain('approval');
  });

  it('a denied tool call is an answer, not an error, and nothing runs', async () => {
    const { ctx, invoked, logged } = fakeContext({ tools: [SEARCH_TOOL] });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(invoked).toEqual([]);
    expect(logged).toEqual([]);
  });

  it('a grant that needs approval stops before the handler runs', async () => {
    const { ctx, invoked } = fakeContext({
      tools: [WRITE_TOOL],
      decisions: { 'pages.write': { allowed: true, reason: 'granted', needsApproval: true } },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/x.md', content: 'hi' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'approval_required' });
    expect(invoked).toEqual([]);
  });

  it('with the approvals plugin loaded, a grant that needs approval becomes a pending approval and the model is told', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const { ctx, invoked } = fakeContext({
      tools: [WRITE_TOOL],
      decisions: { 'pages.write': { allowed: true, reason: 'granted', needsApproval: true } },
      approvals: {
        request: (_tx, input) => {
          asked.push(input);
          return Promise.resolve({ approvalId: 'a0000000-0000-4000-8000-000000000001', created: true });
        },
      },
    });
    const args = { mode: 'create', path: 'pages/x.md', content: 'hi', apiToken: 'sk-secret' };
    const call = () => handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pages.write', arguments: args } });
    const { result } = (await body(await call())) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'approval_pending', approvalId: 'a0000000-0000-4000-8000-000000000001' });
    expect(invoked).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      runId: RUN.runId,
      source: 'grant',
      tool: 'pages.write',
      resume: { kind: 'tool', capability: 'pages.write', args },
    });
    // the approver is shown a preview with the secret hidden; the real arguments only travel in `resume`
    expect(asked[0]!['argsPreview']).toMatchObject({ path: 'pages/x.md', apiToken: '[hidden]' });
    // asking for the same thing again is the same dedupe key, so the inbox holds one approval
    await call();
    expect(asked[1]!['dedupeKey']).toBe(asked[0]!['dedupeKey']);
  });

  it('a read that is flagged needsApproval is refused, not parked: a re-run would be the bot\'s, not the asker\'s', async () => {
    const asked: unknown[] = [];
    const { ctx, invoked } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': { allowed: true, reason: 'granted', needsApproval: true } },
      approvals: { request: (_tx, input) => (asked.push(input), Promise.resolve({ approvalId: 'x', created: true })) },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(asked).toEqual([]);
    expect(invoked).toEqual([]);
  });

  it('a stub answers what it knows and never invents content', async () => {
    const { ctx, invoked } = fakeContext({ tools: [KNOWLEDGE_TOOL], decisions: { 'knowledge.search': ALLOWED } });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'knowledge.search', arguments: { query: 'cache' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.content[0]!.text)).toEqual({ hits: [], reason: 'no bases configured' });
    expect(invoked).toEqual([]);
  });

  it('a read runs in the reader transaction, is confined to the run’s team, and logs every hit', async () => {
    const { ctx, invoked, logged, authorized } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      answer: () => ({
        hits: [
          { id: '00000000-0000-4000-8000-0000000000a1', channel: { id: '00000000-0000-4000-8000-0000000000b1' } },
          { id: '00000000-0000-4000-8000-0000000000a2', channel: null },
        ],
      }),
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ hits: [{ id: '00000000-0000-4000-8000-0000000000a1', channel: { id: '00000000-0000-4000-8000-0000000000b1' } }, { id: '00000000-0000-4000-8000-0000000000a2', channel: null }] });
    expect(invoked).toEqual([{ name: 'messages.search', input: { query: 'deploy', teamId: UUIDS.team }, as: 'reader' }]);
    // a read names no path, so the broker judges it by name alone
    expect(authorized).toEqual([{ name: 'messages.search', context: {} }]);
    expect(logged).toEqual([
      { sourceType: 'message', sourceRef: '00000000-0000-4000-8000-0000000000a1', scope: 'channel' },
      { sourceType: 'message', sourceRef: '00000000-0000-4000-8000-0000000000a2', scope: 'team' },
    ]);
  });

  it('a write runs in the bot transaction, gets the run’s team, and is authorized with the path it names', async () => {
    const { ctx, invoked, authorized } = fakeContext({ tools: [WRITE_TOOL], decisions: { 'pages.write': ALLOWED }, answer: () => ({ ok: true }) });
    await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/x.md', content: 'hi' } } });
    expect(invoked).toEqual([
      { name: 'pages.write', input: { mode: 'create', path: 'pages/x.md', content: 'hi', team: UUIDS.team }, as: 'bot' },
    ]);
    // The broker's path guard has to see the path the handler will write, or every mutation would be "needs a path".
    expect(authorized).toEqual([{ name: 'pages.write', context: { path: 'pages/x.md' } }]);
  });

  it('a tool nothing implements is refused without calling anything', async () => {
    // granted, but no plugin registered it: this is the collision the stubs exist to avoid, and it answers plainly
    const { ctx, invoked } = fakeContext({ tools: [SEARCH_TOOL], decisions: { 'invented.tool': ALLOWED } });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'invented.tool', arguments: {} } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'unknown_tool' });
    expect(invoked).toEqual([]);

    // and a name the run has no grant for is answered the same way whether or not anything implements it: fail closed
    const denied = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'alsonot.real', arguments: {} } });
    const deniedBody = (await body(denied)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(deniedBody.result.isError).toBe(true);
    expect(JSON.parse(deniedBody.result.content[0]!.text)).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('a run that ended under the call is a tool answer for a call and a 401 for anything else, never a 500', async () => {
    const { ctx } = fakeContext({ tools: [SEARCH_TOOL], decisions: { 'messages.search': ALLOWED } });
    const ended = () => Promise.reject(new RunEndedError(RUN.runId));
    (ctx.runs as unknown as Record<string, unknown>)['authorize'] = ended;
    (ctx.runs as unknown as Record<string, unknown>)['may'] = ended;

    const call = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'messages.search', arguments: {} } });
    expect(call.status).toBe(200);
    const answered = (await body(call)) as { id: number; result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(answered.id).toBe(31);
    expect(answered.result.isError).toBe(true);
    expect(JSON.parse(answered.result.content[0]!.text)).toMatchObject({ ok: false, code: 'run_ended' });

    await expect(handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 32, method: 'tools/list' })).rejects.toMatchObject({ status: 401 });
    await expect(handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 32, method: 'tools/list' })).rejects.toBeInstanceOf(HttpError);

    // anything else that goes wrong is still a fault
    (ctx.runs as unknown as Record<string, unknown>)['may'] = () => Promise.reject(new Error('database went away'));
    await expect(handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 33, method: 'tools/list' })).rejects.toThrow('database went away');
  });

  it('tools/list asks about each capability once and does not look the run up again for each', async () => {
    const { ctx } = fakeContext({ tools: [SEARCH_TOOL, WRITE_TOOL], decisions: { 'messages.search': ALLOWED, 'pages.write': ALLOWED } });
    const options: unknown[] = [];
    const inner = ctx.runs.may.bind(ctx.runs);
    (ctx.runs as unknown as Record<string, unknown>)['may'] = (run: BotRunHandle, name: string, context?: unknown, opts?: unknown) => {
      options.push(opts);
      return inner(run, name, context as never);
    };
    await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 34, method: 'tools/list' });
    expect(options).toEqual([{ alreadyLive: true }, { alreadyLive: true }]);
  });

  it('transport faults are JSON-RPC errors', async () => {
    const { ctx } = fakeContext({ tools: [] });
    const bad = await handleRpc(ctx, RUN, { id: 8, method: 'tools/list' });
    expect((await body(bad)).error).toMatchObject({ code: -32600 });

    const unknownMethod = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 9, method: 'resources/list' });
    expect((await body(unknownMethod)).error).toMatchObject({ code: -32601 });

    const badParams = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { arguments: {} } });
    expect((await body(badParams)).error).toMatchObject({ code: -32602 });
  });
});
