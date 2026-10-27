import { AgentBridgeRunExtension, parseBotMd } from '@manythreads/shared';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { MAX_FRAME_BYTES, profileFor, readLimitedText, runOnGateway, sessionIdFor, sseFrames, type GatewayRuntimeOptions } from '../src/gateway.ts';

// The gateway transport against a server that speaks the measured wire of Hermes' api_server: profile in the path, the profile's own key,
// 202 + run id, a server-sent-event stream, stop, the idempotency replay and the 429.

const KEY = 'profile-key-0123456789';
const BOT_ID = '11111111-1111-1111-1111-111111111111';
const RUN_ID = '77777777-7777-7777-7777-777777777777';
const THREAD = '66666666-6666-6666-6666-666666666666';

let gw: FakeHermesGateway;
const logs: string[] = [];
const scope: BotRuntimeScope = { invoke: async () => ({}), logSource: async () => 0, log: (line) => void logs.push(line) };

beforeEach(async () => {
  logs.length = 0;
  gw = await startFakeHermesGateway({ profiles: { 'mt-coder': { apiKey: KEY }, custom: { apiKey: 'other-key-0123456789' } } });
});
afterEach(async () => {
  await gw.close();
});

const input = (over: Partial<BotRuntimeInput> = {}, budget: number | null = 30): BotRuntimeInput => {
  const parsed = parseBotMd('---\nname: Coder\nrole: r\nkind: agent\nruntime: hermes\n---\nsoul\n');
  if (!parsed.ok) throw new Error('fixture');
  return {
    bot: { id: BOT_ID, slug: 'coder', name: 'Coder', teamId: '22222222-2222-2222-2222-222222222222', workspaceId: '33333333-3333-3333-3333-333333333333', runtime: 'hermes', definitionSha: 'a'.repeat(64) },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: null,
    prompt: 'Nadia in #dev:\n\n@coder what changed?',
    thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: THREAD },
    endpoint: { runId: RUN_ID, url: 'http://x/api/mcp/runs/x', token: 't' },
    gateway: null,
    limits: { runBudgetSeconds: budget, maxTurns: null, sessionMinutes: null },
    ...over,
  };
};

const options = (over: Partial<GatewayRuntimeOptions> = {}, key = KEY): GatewayRuntimeOptions => ({
  resolve: async () => ({ baseUrl: gw.url, apiKey: key, kind: 'managed', agent: 'hermes' }),
  killGraceSeconds: 1,
  retryUnitMs: 10,
  ...over,
});

const collect = async (events: AsyncIterable<BotRuntimeEvent>): Promise<BotRuntimeEvent[]> => {
  const out: BotRuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const resultOf = (events: BotRuntimeEvent[]) => events.find((e): e is Extract<BotRuntimeEvent, { type: 'result' }> => e.type === 'result')!;

describe('the names a run goes by', () => {
  it('one Hermes session per thread, and mt-<slug> for the managed pod', () => {
    expect(sessionIdFor(BOT_ID, THREAD, RUN_ID)).toBe(`${BOT_ID}:${THREAD}`);
    expect(sessionIdFor(BOT_ID, null, RUN_ID)).toBe(`${BOT_ID}:${RUN_ID}`);
    expect(profileFor('coder', { connection: 'managed' })).toBe('mt-coder');
    expect(profileFor('coder', { connection: 'host', profile: 'custom' })).toBe('custom');
  });
});

describe('what a run carries to the gateway', () => {
  const external = (agent: 'hermes' | 'claude-code' | 'codex') => ({ resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'external' as const, agent }) });
  const bodyOf = (): Record<string, unknown> => gw.calls.find((c) => c.method === 'POST' && c.path === '/p/mt-coder/v1/runs')!.body as Record<string, unknown>;

  it('sends the definition body as instructions to a gateway the customer runs, and not to the team’s own pod', async () => {
    await collect((await runOnGateway(options(external('hermes')), input(), scope, { connection: 'host', profile: 'mt-coder' })).events);
    expect(bodyOf()['instructions']).toBe('soul');
    gw.calls.length = 0;
    await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(bodyOf()).not.toHaveProperty('instructions');
  });

  it('sends the run extension only to a bridge agent, with the run token', async () => {
    const parsed = parseBotMd('---\nname: Coder\nrole: r\nkind: agent\nruntime: hermes\nmodel:\n  aliases: [smart]\n  effort: high\ncapabilities:\n  runtime: [web-search]\n---\nsoul\n');
    if (!parsed.ok) throw new Error('fixture');
    const withNamedAlias = input({ definition: { frontmatter: parsed.frontmatter, body: parsed.body }, endpoint: { runId: RUN_ID, url: 'https://mt.example/mcp', token: 'run-token-abc' } });
    await collect((await runOnGateway(options(external('claude-code')), withNamedAlias, scope, { connection: 'host', profile: 'mt-coder' })).events);
    const ext = AgentBridgeRunExtension.parse(bodyOf()['manythreads']);
    expect(ext).toEqual({
      bot: 'coder',
      runId: RUN_ID,
      mcp: { url: 'https://mt.example/mcp', token: 'run-token-abc' },
      tools: ['web-search'],
      model: { alias: 'smart', effort: 'high' },
      budgetSeconds: 30,
      maxTurns: null,
    });
  });

  it('never puts the run token in the body of a Hermes agent', async () => {
    const withToken = input({ endpoint: { runId: RUN_ID, url: 'https://mt.example/mcp', token: 'run-token-abc' } });
    await collect((await runOnGateway(options(external('hermes')), withToken, scope, { connection: 'host', profile: 'mt-coder' })).events);
    expect(bodyOf()).not.toHaveProperty('manythreads');
    expect(JSON.stringify(bodyOf())).not.toContain('run-token-abc');
  });

  it('refuses a bridge run that has no tools endpoint', async () => {
    const result = resultOf(await collect((await runOnGateway(options(external('codex')), input({ endpoint: null }), scope, { connection: 'host', profile: 'mt-coder' })).events));
    expect(result.ok).toBe(false);
    expect(gw.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('a run on a gateway', () => {
  it('posts the run with the run id as its idempotency key and the thread as its session, and turns the stream into events', async () => {
    gw.setScript(() => [
      { type: 'tool', name: 'mcp__manythreads__memory_recall' },
      { type: 'delta', text: 'Looking ' },
      { type: 'delta', text: 'now.' },
      { type: 'finish', output: 'Looking now. Done.', usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
    ]);
    const handle = await runOnGateway(options(), input(), scope, { connection: 'managed' });
    const events = await collect(handle.events);

    const post = gw.calls.find((c) => c.method === 'POST' && c.path === '/p/mt-coder/v1/runs')!;
    expect(post.authorized).toBe(true);
    expect(post.idempotencyKey).toBe(RUN_ID);
    expect(post.body).toEqual({ input: 'Nadia in #dev:\n\n@coder what changed?', session_id: `${BOT_ID}:${THREAD}` });

    expect(events.map((e) => e.type)).toEqual(['tool', 'tool_result', 'text', 'text', 'result']);
    expect(events[0]).toMatchObject({ type: 'tool', name: 'mcp__manythreads__memory_recall' });
    expect(events[1]).toMatchObject({ type: 'tool_result', ok: true });
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'Looking now. Done.', tokens: { input: 100, output: 20, total: 120 } });
    // Nothing to stop once the run has ended on its own.
    await handle.stop();
    expect(gw.calls.some((c) => c.path.endsWith('/stop'))).toBe(false);
  });

  it('a failed tool is a failed tool_result, and a failed run is a failed result with the gateway’s reason', async () => {
    gw.setScript(() => [{ type: 'tool', name: 'x', error: true }, { type: 'fail', error: 'model fell over' }]);
    const events = await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ ok: false });
    // the gateway's own words are not repeated
    expect(resultOf(events).error).not.toContain('model fell over');
    expect(resultOf(events).ok).toBe(false);
    expect(resultOf(events).failure).toBeUndefined();
  });

  it('uses the profile named on a connection of the customer’s own, with that connection’s key', async () => {
    const events = await collect((await runOnGateway(options({}, 'other-key-0123456789'), input(), scope, { connection: 'host', profile: 'custom' })).events);
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'echo: Nadia in #dev:\n\n@coder what changed?' });
    expect(gw.calls.find((c) => c.path === '/p/custom/v1/runs')).toMatchObject({ authorized: true });
  });

  it('a start that is repeated returns the same gateway run: one run, not two (the key is the run id)', async () => {
    await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(gw.runs).toHaveLength(1);
    expect(gw.calls.filter((c) => c.path === '/p/mt-coder/v1/runs' && c.method === 'POST')).toHaveLength(2);
  });

  it('waits out a 429 and then starts the run', async () => {
    gw.rejectNextRuns(2);
    const events = await collect((await runOnGateway(options({ retryUnitMs: 5 }), input(), scope, { connection: 'managed' })).events);
    expect(resultOf(events).ok).toBe(true);
    expect(gw.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(3);
    expect(logs.some((l) => /run limit/.test(l))).toBe(true);
  });

  it('reopens a stream that drops and does not repeat an event', async () => {
    gw.setScript(() => [{ type: 'delta', text: 'a' }, { type: 'wait', ms: 150 }, { type: 'delta', text: 'b' }, { type: 'finish', output: 'ab' }]);
    gw.dropNextStreams(1);
    const events = await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['a', 'b']);
    expect(resultOf(events)).toMatchObject({ ok: true, text: 'ab' });
  });

  it('stop asks the gateway to stop, and the run ends as stopped', async () => {
    gw.setScript(() => [{ type: 'hang' }]);
    const handle = await runOnGateway(options(), input(), scope, { connection: 'managed' });
    const pending = collect(handle.events);
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop();
    const events = await pending;
    expect(gw.calls.some((c) => c.method === 'POST' && c.path.endsWith('/stop'))).toBe(true);
    expect(resultOf(events)).toMatchObject({ ok: false, error: 'the run was stopped' });
  });

  it('the ceiling stops a run that outlives its budget and reports a timeout', async () => {
    gw.setScript(() => [{ type: 'hang' }]);
    const handle = await runOnGateway(options({ killGraceSeconds: 0 }), input({}, 0.2), scope, { connection: 'managed' });
    const events = await collect(handle.events);
    expect(resultOf(events)).toMatchObject({ ok: false, failure: 'timeout' });
    expect(gw.calls.some((c) => c.path.endsWith('/stop'))).toBe(true);
  });
});

describe('a run that cannot start says why, with the right category', () => {
  it('a gateway nobody listens on is unreachable', async () => {
    const dead = await startFakeHermesGateway({ profiles: {} });
    const url = dead.url;
    await dead.close();
    const handle = await runOnGateway(options({ resolve: async () => ({ baseUrl: url, apiKey: KEY, kind: 'managed', agent: 'hermes' }) }), input(), scope, { connection: 'managed' });
    expect(resultOf(await collect(handle.events))).toMatchObject({ ok: false, failure: 'hermes_unreachable', error: expect.stringContaining('unreachable') });
  });

  it('a wrong key is a plain failure that names the connection and never echoes the key', async () => {
    const result = resultOf(await collect((await runOnGateway(options({}, 'wrong-key-0123456789'), input(), scope, { connection: 'managed' })).events));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refused this bot's API key/);
    expect(result.error).not.toContain('wrong-key');
    expect(result.failure).toBeUndefined();
  });

  it('a profile the gateway does not have, and a connection the team does not have', async () => {
    const noProfile = resultOf(await collect((await runOnGateway(options(), input(), scope, { connection: 'host', profile: 'ghost' })).events));
    expect(noProfile.error).toMatch(/no profile "ghost"/);
    const noConn = resultOf(await collect((await runOnGateway(options({ resolve: async () => null }), input(), scope, { connection: 'nowhere', profile: 'p' })).events));
    expect(noConn.error).toMatch(/does not have/);
  });

  it('does not follow a redirect (the address a lead typed is the only place the key goes)', async () => {
    const http = await import('node:http');
    const hop = http.createServer((_req, res) => {
      res.writeHead(302, { location: `${gw.url}/p/mt-coder/v1/runs` });
      res.end();
    });
    await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r));
    const port = (hop.address() as { port: number }).port;
    const result = resultOf(await collect((await runOnGateway(options({ resolve: async () => ({ baseUrl: `http://127.0.0.1:${port}`, apiKey: KEY, kind: 'managed', agent: 'hermes' }) }), input(), scope, { connection: 'managed' })).events));
    hop.close();
    expect(result).toMatchObject({ ok: false, failure: 'hermes_unreachable' });
    expect(gw.calls).toHaveLength(0);
  });
});

describe('sseFrames', () => {
  it('reads data lines across chunk boundaries and skips comments and junk', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(': open\n\nid: 0\ndata: {"event":"a",'));
        c.enqueue(enc.encode('"seq":0}\n\ndata: not json\n\n: keepalive\n\ndata: {"event":"b"}\n\n'));
        c.close();
      },
    });
    const out: Record<string, unknown>[] = [];
    for await (const f of sseFrames(body)) out.push(f);
    expect(out).toEqual([{ event: 'a', seq: 0 }, { event: 'b' }]);
  });
});

describe('a gateway is not trusted to be polite', () => {
  it('a stream that cannot resume (no seq) is replayed from its start without repeating text', async () => {
    const plain = await startFakeHermesGateway({ profiles: { 'mt-coder': { apiKey: KEY } }, omitSeq: true });
    try {
      plain.setScript(() => [{ type: 'delta', text: 'a' }, { type: 'wait', ms: 150 }, { type: 'delta', text: 'b' }, { type: 'finish', output: 'ab' }]);
      plain.dropNextStreams(1);
      const handle = await runOnGateway(options({ resolve: async () => ({ baseUrl: plain.url, apiKey: KEY, kind: 'managed', agent: 'hermes' }) }), input(), scope, { connection: 'managed' });
      const events = await collect(handle.events);
      expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['a', 'b']);
      expect(resultOf(events)).toMatchObject({ ok: true, text: 'ab' });
    } finally {
      await plain.close();
    }
  });

  it('an event larger than the cap fails the run with a clear reason and stops it', async () => {
    gw.setScript(() => [{ type: 'delta', text: 'x'.repeat(MAX_FRAME_BYTES + 10) }, { type: 'hang' }]);
    const events = await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(resultOf(events)).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(gw.calls.some((c) => c.path.endsWith('/stop'))).toBe(true);
  });

  it('readLimitedText refuses a body past its cap', async () => {
    const big = new Response('y'.repeat(100));
    await expect(readLimitedText(big, 50)).rejects.toThrow(/too large/);
    expect(await readLimitedText(new Response('small'), 50)).toBe('small');
  });

  it('a refusal at start repeats the status and not the body', async () => {
    const evil = (await import('node:http')).createServer((_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('SECRET-INTERNAL-BODY 10.0.0.5 db password');
    });
    await new Promise<void>((r) => evil.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(evil.address() as { port: number }).port}`;
    const result = resultOf(await collect((await runOnGateway(options({ resolve: async () => ({ baseUrl: url, apiKey: KEY, kind: 'managed', agent: 'hermes' }) }), input(), scope, { connection: 'managed' })).events));
    evil.close();
    expect(result.error).toContain('status 500');
    expect(result.error).not.toContain('SECRET');
    expect(logs.join('\n')).not.toContain('SECRET');
  });
});

describe('a stale Hermes session of the thread', () => {
  const posts = () => gw.calls.filter((c) => c.method === 'POST' && c.path === '/p/mt-coder/v1/runs');
  const run = async () => collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);

  it('starts again once on a fresh session when the first start fails with unknown_execution before any output', async () => {
    gw.setScript((r) =>
      r.body['session_id'] === `${BOT_ID}:${THREAD}`
        ? [{ type: 'fail', error: 'RuntimeStoreError: unknown_execution' }]
        : [{ type: 'finish', output: 'second answer' }],
    );
    const result = resultOf(await run());
    expect(result).toMatchObject({ ok: true, text: 'second answer' });
    expect(posts()).toHaveLength(2);
    expect((posts()[1]!.body as Record<string, unknown>)['session_id']).toBe(`${BOT_ID}:${THREAD}:r${RUN_ID}`);
    expect(posts()[0]!.idempotencyKey).toBe(RUN_ID);
    expect(posts()[1]!.idempotencyKey).toBe(`${RUN_ID}:fresh`);
    expect(logs.filter((l) => l.includes('was stale (unknown_execution)'))).toHaveLength(1);
  });

  it('starts again on a fresh session when the guard blocked the request before any output (the blocked string is in the session)', async () => {
    gw.setScript((r) =>
      r.body['session_id'] === `${BOT_ID}:${THREAD}`
        ? [{ type: 'fail', error: 'BadRequestError: litellm.BadRequestError: OpenAIException - Content blocked: generic_secret_key pattern detected' }]
        : [{ type: 'finish', output: 'second answer' }],
    );
    expect(resultOf(await run())).toMatchObject({ ok: true, text: 'second answer' });
    expect((posts()[1]!.body as Record<string, unknown>)['session_id']).toBe(`${BOT_ID}:${THREAD}:r${RUN_ID}`);
  });

  it('does not retry another error', async () => {
    gw.setScript(() => [{ type: 'fail', error: 'model fell over' }]);
    expect(resultOf(await run()).ok).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it('does not retry once output has started', async () => {
    gw.setScript(() => [{ type: 'delta', text: 'Hi' }, { type: 'fail', error: 'unknown_execution' }]);
    expect(resultOf(await run()).ok).toBe(false);
    expect(posts()).toHaveLength(1);
  });

  it('retries only once', async () => {
    gw.setScript(() => [{ type: 'fail', error: 'unknown_execution' }]);
    expect(resultOf(await run()).ok).toBe(false);
    expect(posts()).toHaveLength(2);
  });
});
