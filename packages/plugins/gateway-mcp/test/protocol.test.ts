import { HttpError, RunEndedError, type BotRunHandle, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolsDigest } from '../src/digest.ts';
import { decisionPlaces, handleBotRpc, handleRpc, keepablePath, offeredTools, setFaultLog, type BotEndpoint, type PairedBotHandle } from '../src/protocol.ts';
import { createMcpSessions } from '../src/session.ts';

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
  /** The `pre_egress` chain as the call sees it; the default is the data-loss plugin answering "nothing found" for every piece of text. */
  /** Tools of a source (`ctx.toolSources`), by tool name. */
  sourceTools?: Record<string, { kind: 'read' | 'write'; sourcesFrom?: (result: unknown) => Array<{ sourceType: string; sourceRef: string; scope: 'team' | 'channel' | 'person' }> }>;
  guard?: (input: { text: string; destination: string }) => { outcome: 'allow' | 'redact' | 'require_approval' | 'block'; text: string; rules: string[]; hooks: number; ran: string[]; message?: string };
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
    // P7-07: the content-blind decision line; the database side is in decisions.test.ts
    logDecision: () => Promise.resolve(0),
  };
  const providers = { get: (kind: string) => (kind === 'approvals' ? options.approvals : undefined) };
  const warned: string[] = [];
  setFaultLog((m) => void warned.push(m));
  const emitted: Array<Record<string, unknown>> = [];
  const guard = options.guard ?? ((input: { text: string }) => ({ outcome: 'allow' as const, text: input.text, rules: [], hooks: 1, ran: ['guardrails-dlp'] }));
  const hooks = { runPreEgress: (_tx: PluginTx, input: { text: string; destination: string }) => Promise.resolve(guard(input)) };
  const audit = { emit: (_tx: PluginTx, event: Record<string, unknown>) => Promise.resolve(void emitted.push(event)) };
  const sourceFind = (name: string) => {
    const t = options.sourceTools?.[name];
    return t ? { source: { id: 'fake', tools: [], offered: () => Promise.resolve([name]) }, tool: { name, description: `${name} does something`, inputSchema: { type: 'object' }, ...t } } : undefined;
  };
  const ctx = { manifest: { version: '0.1.0' }, runs, providers, toolSources: { register: () => undefined, list: () => [], find: sourceFind }, hooks, audit, runtime: { now: () => new Date('2026-10-30T09:00:00.000Z') } } as unknown as PluginContext;
  return { ctx, invoked, logged, authorized, warned, emitted };
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

  it('a successful read of a source tool always writes a run source line, beside what sourcesFrom answers', async () => {
    const read = { name: 'email.read', destructive: false };
    const decisions = { 'email.read': ALLOWED };
    // sourcesFrom answers nothing: the default line is still written
    const bare = fakeContext({ tools: [read], decisions, sourceTools: { 'email.read': { kind: 'read', sourcesFrom: () => [] } }, answer: () => ({ messages: [] }) });
    await handleRpc(bare.ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'email.read', arguments: {} } });
    expect(bare.logged).toEqual([{ sourceType: 'connection', sourceRef: 'email.read', scope: 'person' }]);
    // no sourcesFrom at all
    const none = fakeContext({ tools: [read], decisions, sourceTools: { 'email.read': { kind: 'read' } } });
    await handleRpc(none.ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'email.read', arguments: {} } });
    expect(none.logged).toEqual([{ sourceType: 'connection', sourceRef: 'email.read', scope: 'person' }]);
    // the source's own lines are kept too
    const both = fakeContext({
      tools: [read],
      decisions,
      sourceTools: { 'email.read': { kind: 'read', sourcesFrom: () => [{ sourceType: 'mail', sourceRef: 'm1', scope: 'team' }] } },
    });
    await handleRpc(both.ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'email.read', arguments: {} } });
    expect(both.logged).toEqual([
      { sourceType: 'mail', sourceRef: 'm1', scope: 'team' },
      { sourceType: 'connection', sourceRef: 'email.read', scope: 'person' },
    ]);
    // a refused call (no grant) writes no line
    const denied = fakeContext({ tools: [read], sourceTools: { 'email.read': { kind: 'read' } } });
    await handleRpc(denied.ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'email.read', arguments: {} } });
    expect(denied.logged).toEqual([]);
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

  it('accepts the `_meta` MCP reserves on params, so a real client’s call is a call and not bad params', async () => {
    // Hermes sends `"_meta": {}` on every tools/call (the MCP spec reserves the field for progress and tracing). Refusing it read as
    // "tools/call needs a tool name and object arguments" in the agent's own words, and it stopped using the tools altogether.
    const { ctx, invoked } = fakeContext({ tools: [SEARCH_TOOL], decisions: { 'messages.search': ALLOWED } });
    const res = await handleRpc(ctx, RUN, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'messages.search', arguments: { query: 'deploy' }, _meta: {} },
    });
    const { result } = (await body(res)) as { error?: unknown; result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ hits: [] });
    // `_meta` is the protocol's, never the tool's: the handler sees only the arguments.
    expect(invoked.map((c) => c.name)).toEqual(['messages.search']);
    expect(invoked[0]!.input).not.toHaveProperty('_meta');
    expect(invoked[0]!.input['query']).toBe('deploy');
  });

  it('a call that carries a finding the workspace blocks never reaches the handler, and the answer names no text', async () => {
    const { ctx, invoked } = fakeContext({
      tools: [WRITE_TOOL],
      decisions: { 'pages.write': ALLOWED },
      guard: (input) => ({ outcome: 'block', text: input.text, rules: ['api-key'], hooks: 1, ran: ['guardrails-dlp'], message: 'blocked' }),
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/x.md', content: 'sk-abcdefghijklmnopqrstuvwxyz' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(result.content[0]!.text).not.toContain('sk-abcdef');
    expect(invoked).toEqual([]);
  });

  it('a call is refused unread when no data-loss guard answered', async () => {
    const { ctx, invoked } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      guard: (input) => ({ outcome: 'allow', text: input.text, rules: [], hooks: 0, ran: [] }),
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(invoked).toEqual([]);
  });

  it('a redacted call runs with the redacted copy', async () => {
    const { ctx, invoked, emitted } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      guard: (input) => (input.destination === 'mcp' && input.text.includes('SECRET') ? { outcome: 'redact', text: input.text.replace('SECRET', '[redacted:api-key]'), rules: ['api-key'], hooks: 1, ran: ['guardrails-dlp'] } : { outcome: 'allow', text: input.text, rules: [], hooks: 1, ran: ['guardrails-dlp'] }),
    });
    await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'find SECRET now' } } });
    expect(invoked[0]!.input['query']).toBe('find [redacted:api-key] now');
    expect(JSON.stringify(emitted)).not.toContain('SECRET');
  });

  it('a finding in a field name refuses the call (a name cannot be redacted), and the name is not echoed', async () => {
    const { ctx, invoked } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      guard: (input) => (input.text.includes('SECRET') ? { outcome: 'redact', text: input.text.replace('SECRET', '[redacted:api-key]'), rules: ['api-key'], hooks: 1, ran: ['guardrails-dlp'] } : { outcome: 'allow', text: input.text, rules: [], hooks: 1, ran: ['guardrails-dlp'] }),
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy', SECRET_NAME: 1 } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(result.content[0]!.text).not.toContain('SECRET');
    expect(invoked).toEqual([]);
  });

  it('a check that throws refuses the call and logs the real error, instead of an error page or a call that runs unchecked', async () => {
    const { ctx, invoked, warned } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      guard: () => {
        throw new Error('relation "app.dlp_detectors" does not exist');
      },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 25, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'blocked_by_guardrail' });
    expect(result.content[0]!.text).not.toContain('dlp_detectors');
    expect(warned.join(' ')).toContain('dlp_detectors');
    expect(invoked).toEqual([]);
  });

  it('a result read back is held when the check on it cannot run', async () => {
    const { ctx } = fakeContext({
      tools: [SEARCH_TOOL],
      decisions: { 'messages.search': ALLOWED },
      guard: (input) => {
        if (input.destination === 'mcp_result') throw new Error('boom');
        return { outcome: 'allow', text: input.text, rules: [], hooks: 1, ran: ['guardrails-dlp'] };
      },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 26, method: 'tools/call', params: { name: 'messages.search', arguments: { query: 'deploy' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'withheld_by_guardrail' });
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

  it('knowledge.search is a read: it runs as the asker, and the run’s log names the document and version and the page a citation can open', async () => {
    const { ctx, invoked, logged } = fakeContext({
      tools: [KNOWLEDGE_TOOL],
      decisions: { 'knowledge.search': ALLOWED },
      answer: () => ({
        ok: true,
        hits: [
          { base: 'handbook', document: 'Refund policy.pdf', version: 2, file: 'knowledge/handbook/refund-policy.md', text: 'Refunds are paid within 14 days.' },
          { base: 'handbook', document: 'Notes.csv', version: 1, file: null, text: 'x' },
        ],
      }),
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'knowledge.search', arguments: { query: 'refund' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(result.isError).not.toBe(true);
    expect(invoked.map((i) => [i.name, i.as])).toEqual([['knowledge.search', 'reader']]);
    expect(logged).toEqual([
      { sourceType: 'knowledge', sourceRef: 'handbook/Refund policy.pdf v2', scope: 'team' },
      { sourceType: 'page', sourceRef: 'knowledge/handbook/refund-policy.md', scope: 'team' },
      { sourceType: 'knowledge', sourceRef: 'handbook/Notes.csv v1', scope: 'team' },
    ]);
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

  it('a handler that throws is a tool answer: platform errors keep their code and sentence, anything else is generic and logged', async () => {
    let thrown: unknown;
    const { ctx, warned } = fakeContext({
      tools: [WRITE_TOOL],
      decisions: { 'pages.write': ALLOWED },
      answer: () => {
        throw thrown;
      },
    });
    const call = async (id: number) => {
      const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'pages.write', arguments: { path: 'pages/x.md' } } });
      const { result } = (await body(res)) as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(result.isError).toBe(true);
      return JSON.parse(result.content[0]!.text) as { ok: boolean; code: string; message: string };
    };
    thrown = new HttpError(400, 'validation_failed', 'Unrecognized key: "meta"');
    expect(await call(60)).toEqual({ ok: false, code: 'validation_failed', message: 'Unrecognized key: "meta"' });
    thrown = new HttpError(409, 'conflict', 'Someone changed it first.');
    expect(await call(61)).toMatchObject({ code: 'conflict', message: 'Someone changed it first.' });
    thrown = new HttpError(403, 'forbidden', 'Not yours.');
    expect(await call(62)).toMatchObject({ code: 'forbidden' });
    thrown = new HttpError(404, 'not_found', 'No such card.');
    expect(await call(63)).toMatchObject({ code: 'not_found' });
    const bad = z.object({ title: z.string() }).safeParse({});
    thrown = bad.error;
    expect(await call(64)).toMatchObject({ code: 'validation_failed', message: expect.stringContaining('title') });
    expect(warned).toEqual([]);

    // a database-shaped error: nothing of its text reaches the model, the real text is logged
    thrown = Object.assign(new Error('invalid input syntax for type uuid: "x" (constraint tasks_owner_fk on relation app.tasks)'), { code: '22P02' });
    const generic = await call(65);
    expect(generic).toEqual({ ok: false, code: 'failed', message: 'the call failed' });
    expect(warned.join(' ')).toContain('invalid input syntax for type uuid');
  });

  it('a run that ends while the handler runs is rethrown, not turned into a tool answer', async () => {
    const { ctx } = fakeContext({
      tools: [WRITE_TOOL],
      decisions: { 'pages.write': ALLOWED },
      answer: () => {
        throw new RunEndedError(RUN.runId);
      },
    });
    const res = await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 66, method: 'tools/call', params: { name: 'pages.write', arguments: { path: 'pages/x.md' } } });
    const { result } = (await body(res)) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'run_ended' });
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

describe('a bot’s own address (PLAN P14-22)', () => {
  const BOT: PairedBotHandle = { botId: UUIDS.bot, botActorId: UUIDS.actor, teamId: UUIDS.team, workspaceId: UUIDS.workspace };
  const endpoint = () => {
    const listed: Array<{ botId: string; digest: string }> = [];
    const sessions = createMcpSessions(Buffer.alloc(32, 1));
    const value: BotEndpoint = { sessions, listed: (botId, digest) => void listed.push({ botId, digest }) };
    return { endpoint: value, listed, sessions };
  };

  it('initialize says the list can change and hands out a session id that names the bot; a run’s address does neither', async () => {
    const { ctx } = fakeContext({ tools: [] });
    const { endpoint: e, sessions } = endpoint();
    const res = await handleBotRpc(ctx, BOT, null, { jsonrpc: '2.0', id: 1, method: 'initialize' }, e);
    expect(((await body(res)).result as { capabilities: { tools: unknown } }).capabilities.tools).toEqual({ listChanged: true });
    expect(sessions.verify(res.headers!['mcp-session-id']!)).toBe(UUIDS.bot);
    // without the endpoint (the older callers) and at a run's own address: no push, no session
    const plain = await handleBotRpc(ctx, BOT, null, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(((await body(plain)).result as { capabilities: { tools: unknown } }).capabilities.tools).toEqual({ listChanged: false });
    expect(plain.headers).toBeUndefined();
    expect((await handleRpc(ctx, RUN, { jsonrpc: '2.0', id: 1, method: 'initialize' })).headers).toBeUndefined();
  });

  it('a tools/list reports the digest of the bot’s own list, with no run open and with one open (judged by that run, compared by the bot’s list)', async () => {
    const { ctx } = fakeContext({ tools: [SEARCH_TOOL, WRITE_TOOL], decisions: { 'messages.search': ALLOWED, 'pages.write': { allowed: true, reason: 'granted', needsApproval: true } } });
    const { endpoint: e, listed } = endpoint();
    const expected = toolsDigest(await offeredTools(ctx, { ...RUN, runId: '00000000-0000-0000-0000-000000000000' }));
    const none = await handleBotRpc(ctx, BOT, null, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, e);
    expect(((await body(none)).result as { tools: unknown[] }).tools).toHaveLength(2);
    expect(listed).toEqual([{ botId: UUIDS.bot, digest: expected }]);
    await handleBotRpc(ctx, BOT, RUN, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, e);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(listed).toHaveLength(2);
    expect(listed[1]!.digest).toBe(expected);
  });

  it('the digest changes with the approval flag of a grant and with a grant removed, the way the pod’s profile line needs', async () => {
    const digestOf = async (decisions: Record<string, Decision>) => toolsDigest(await offeredTools(fakeContext({ tools: [SEARCH_TOOL, WRITE_TOOL], decisions }).ctx, RUN));
    const both = { 'messages.search': ALLOWED, 'pages.write': ALLOWED };
    const base = await digestOf(both);
    expect(await digestOf({ ...both, 'pages.write': { allowed: true, reason: 'granted', needsApproval: true } })).not.toBe(base);
    expect(await digestOf({ 'messages.search': ALLOWED })).not.toBe(base);
    expect(await digestOf(both)).toBe(base);
  });

  it('a call with no run open is still an answer, with the endpoint on as well', async () => {
    const { ctx } = fakeContext({ tools: [SEARCH_TOOL], decisions: { 'messages.search': ALLOWED } });
    const { endpoint: e } = endpoint();
    const res = await handleBotRpc(ctx, BOT, null, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'messages.search', arguments: {} } }, e);
    expect(JSON.stringify((await body(res)).result)).toContain('no_open_run');
    const ambiguous = await handleBotRpc(ctx, BOT, 'ambiguous', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'messages.search', arguments: {} } }, e);
    expect(JSON.stringify((await body(ambiguous)).result)).toContain('ambiguous_run');
  });
});

describe('what a decision line may say about where a call aimed', () => {
  it('keeps a path only when it is shaped like a path of the team’s files', () => {
    expect(keepablePath('pages/handbook/onboarding.md')).toBe('pages/handbook/onboarding.md');
    expect(keepablePath('TEAM.md')).toBe('TEAM.md');
    for (const bad of [
      'pages/sk-live-abcdefghijklmnopqrstuvwx1234.md',
      'a sentence that is not a path',
      '../etc/passwd',
      'pages//double.md',
      'pages/../x',
      '/absolute/path',
      'unknown-root/file.md',
      `pages/${'a'.repeat(201)}`,
      '',
      42,
      null,
    ]) {
      expect(keepablePath(bad)).toBeNull();
    }
  });

  it('records paths for a change to the team’s files only, and marks what was left out', () => {
    expect(decisionPlaces('pages.write', 'write', {}, { path: 'pages/a.md' })).toEqual({ target: 'pages/a.md', path: 'pages/a.md', truncated: false });
    // a read names no place, even when the broker was handed one
    expect(decisionPlaces('pages.read', 'read', {}, { path: 'pages/a.md' })).toEqual({ target: null, truncated: false });
    expect(decisionPlaces('messages.post', 'write', { body: 'text' }, {})).toEqual({ target: null, truncated: false });
    // more than five places, or one that is not shaped like a path, is kept in part and says so
    const many = Array.from({ length: 7 }, (_, i) => `pages/p${String(i)}.md`);
    expect(decisionPlaces('files.commit', 'write', {}, { paths: many })).toMatchObject({ paths: many.slice(0, 5), truncated: true });
    expect(decisionPlaces('files.commit', 'write', {}, { paths: ['pages/a.md', 'a secret sk-live-abcdefghijklmnopqrstuvwx1234'] })).toEqual({
      target: 'pages/a.md',
      paths: ['pages/a.md'],
      truncated: true,
    });
    expect(decisionPlaces('pages.write', 'write', {}, { path: 'pages/' + 'x'.repeat(250) })).toEqual({ target: null, truncated: true });
  });

  it('names a target from the model’s arguments only if it is an id or a slug the platform would have issued', () => {
    const id = '00000000-0000-7000-8000-000000000001';
    expect(decisionPlaces('tasks.claim', 'write', { taskId: id }, {}).target).toBe(id);
    expect(decisionPlaces('tasks.claim', 'write', { taskId: 'sk-live-abcdefghijklmnopqrstuvwx1234' }, {}).target).toBeNull();
    expect(decisionPlaces('bots.message', 'write', { toBotSlug: 'support-bot' }, {}).target).toBe('support-bot');
    expect(decisionPlaces('bots.message', 'write', { toBotSlug: 'a secret sentence' }, {}).target).toBeNull();
    expect(decisionPlaces('bots.message', 'write', { toBotSlug: 'abcdefghijklmnopqrstuvwxyz0123456789' }, {}).target).toBeNull();
  });
});
