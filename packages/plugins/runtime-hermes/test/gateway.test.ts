import { AgentBridgeRunExtension, parseBotMd } from '@manythreads/shared';
import { setTraceBridge, type BotRuntimeEvent, type BotRuntimeInput, type BotRuntimeScope, type SpanAttributes, type TraceBridge } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { GatewayRefused, MAX_FRAME_BYTES, profileFor, readLimitedText, runOnGateway, sessionIdFor, sseFrames, type GatewayRuntimeOptions } from '../src/gateway.ts';
import { withOutputStyle } from '../src/output-style.ts';

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

describe('a shared Claude Code runner (P19-07)', () => {
  const claude = (): GatewayRuntimeOptions =>
    options({ resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'external' as const, agent: 'claude-code' as const, claudeRunner: 'shared-claude' }) });
  const run = async () => resultOf(await collect((await runOnGateway(claude(), input(), scope, { connection: 'shared-claude', profile: 'mt-coder' })).events));

  it('marks a finished run with the runner, its seconds and the CLI cost, for the run job to count', async () => {
    gw.setScript(() => [{ type: 'finish', output: 'done', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cost: 0.02 } }]);
    const r = await run();
    expect(r).toMatchObject({ ok: true, viaClaude: { runner: 'shared-claude', cost: 0.02 } });
    expect(r.viaClaude?.failure).toBeUndefined();
  });

  it('turns a plan limit into one plain line with the reset time, and asks for the pause', async () => {
    gw.setScript(() => [{ type: 'fail', error: 'Claude AI usage limit reached|1900000000', extra: { reason: 'plan_limit', resets_at: 1900000000000 } }]);
    const r = await run();
    expect(r).toMatchObject({ ok: false, failure: 'runner_refused', viaClaude: { failure: 'plan_limit', resetsAt: '2030-03-17T17:46:40.000Z' } });
    expect(r.error).toBe("The Claude plan's limit was reached; it resets at 17:46 UTC.");
    expect(r.refusal).toMatchObject({ runner: 'shared-claude', reason: 'plan_limit' });
  });

  it('turns a refused sign-in into a line for the thread and no retry', async () => {
    gw.setScript(() => [{ type: 'fail', error: 'API Error: 401', extra: { reason: 'needs_sign_in' } }]);
    const r = await run();
    expect(r).toMatchObject({ ok: false, failure: 'runner_refused', viaClaude: { failure: 'needs_sign_in' } });
    expect(r.error).toMatch(/upload a new sign-in file/);
    expect(gw.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/runs'))).toHaveLength(1);
  });

  it('adds nothing for a target that is not a Claude runner', async () => {
    gw.setScript(() => [{ type: 'finish', output: 'done' }]);
    const r = resultOf(await collect((await runOnGateway(options({ resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'external' as const, agent: 'claude-code' as const }) }), input(), scope, { connection: 'host', profile: 'mt-coder' })).events));
    expect(r.viaClaude).toBeUndefined();
  });
});

describe('what a run carries to the gateway', () => {
  const external = (agent: 'hermes' | 'claude-code' | 'codex') => ({ resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'external' as const, agent }) });
  const bodyOf = (): Record<string, unknown> => gw.calls.find((c) => c.method === 'POST' && c.path === '/p/mt-coder/v1/runs')!.body as Record<string, unknown>;

  it('sends the definition body as instructions on every connection, the team’s own pod included (a pod’s SOUL.md is frozen per thread, instructions are not)', async () => {
    await collect((await runOnGateway(options(external('hermes')), input(), scope, { connection: 'host', profile: 'mt-coder' })).events);
    expect(bodyOf()['instructions']).toBe(withOutputStyle('soul'));
    gw.calls.length = 0;
    await collect((await runOnGateway(options(), input(), scope, { connection: 'managed' })).events);
    expect(bodyOf()['instructions']).toBe(withOutputStyle('soul'));
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
    expect(post.body).toEqual({ input: 'Nadia in #dev:\n\n@coder what changed?', instructions: withOutputStyle('soul'), session_id: `${BOT_ID}:${THREAD}` });

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

describe('the trace parent of a run (P10-10)', () => {
  const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  const spans: Array<{ name: string; attributes: SpanAttributes }> = [];
  const stub: TraceBridge = {
    span: (name, attributes, fn) => {
      spans.push({ name, attributes });
      return fn();
    },
    root: (_name, _attributes, fn) => fn(),
    request: () => undefined,
    headers: () => ({ traceparent: TRACEPARENT }),
    traceId: () => undefined,
  };
  afterEach(() => {
    setTraceBridge(null);
    spans.length = 0;
  });

  /** Runs one short run and returns the headers of every call it made. */
  const headersOfRun = async (over: Partial<GatewayRuntimeOptions> & { guarded?: boolean }): Promise<Array<Record<string, string>>> => {
    const seen: Array<Record<string, string>> = [];
    const spy: typeof fetch = (url, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return fetch(url, init);
    };
    gw.setScript(() => [{ type: 'finish', output: 'ok', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }]);
    const { guarded, ...rest } = over;
    const handle = await runOnGateway(
      options({ fetch: spy, resolve: async () => ({ baseUrl: gw.url, apiKey: KEY, kind: 'managed', agent: 'hermes', ...(guarded === undefined ? {} : { guarded }) }), ...rest }),
      input(),
      scope,
      { connection: 'managed' },
    );
    await collect(handle.events);
    return seen;
  };

  it('with tracing on, the platform\'s own gateway gets the trace parent on the start and on the stream, and the start is a span of ids only', async () => {
    setTraceBridge(stub);
    const seen = await headersOfRun({});
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) expect(h['traceparent']).toBe(TRACEPARENT);
    const start = spans.find((x) => x.name === 'hermes.run.start')!;
    expect(start.attributes).toMatchObject({ 'mt.hermes.agent': 'hermes', 'mt.run_id': RUN_ID, 'mt.bot_id': BOT_ID });
    expect(JSON.stringify(start.attributes)).not.toMatch(/Nadia|what changed|soul/);
  });

  it('an address a team lead typed (guarded) never gets the trace parent', async () => {
    setTraceBridge(stub);
    const seen = await headersOfRun({ guarded: true });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) expect(h).not.toHaveProperty('traceparent');
  });

  it('with tracing off no call carries it', async () => {
    const seen = await headersOfRun({});
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const h of seen) expect(h).not.toHaveProperty('traceparent');
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

describe('a runner that refuses the run (P19-03)', () => {
  const LINE = 'This bot runs on Main Hermes, which an admin has switched off.';

  it("ends the run with the runner's own sentence and the typed refusal, and makes no call to any gateway", async () => {
    const handle = await runOnGateway(
      options({
        resolve: async () => {
          throw new GatewayRefused(LINE, { runner: 'main', reason: 'disabled' });
        },
      }),
      input(),
      scope,
      { connection: 'main' },
    );
    const result = resultOf(await collect(handle.events));
    expect(result).toMatchObject({ ok: false, failure: 'runner_refused', refusal: { runner: 'main', reason: 'disabled', line: LINE } });
    expect(gw.calls).toEqual([]);
  });

  it("names the profile by the runner's rule when the BOT.md names none", async () => {
    gw.setScript(() => [{ type: 'finish', output: 'ok' }]);
    const handle = await runOnGateway(
      options({ resolve: async () => ({ baseUrl: gw.url, apiKey: 'other-key-0123456789', kind: 'managed', agent: 'hermes', profileRule: 'custom' }) }),
      input(),
      scope,
      { connection: 'main' },
    );
    expect(resultOf(await collect(handle.events))).toMatchObject({ ok: true });
    expect(gw.calls.some((c) => c.method === 'POST' && c.path === '/p/custom/v1/runs')).toBe(true);
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

describe('a run that stops to ask a person (P24-02)', () => {
  const askAndFinish = (answered: Array<{ choice: string; steered: string[] }>) => () =>
    [
      { type: 'delta' as const, text: 'Let me look. ' },
      { type: 'approval' as const, command: 'rm -rf build', description: 'delete files recursively', onAnswer: (a: { choice: string; steered: string[] }) => void answered.push(a) },
      { type: 'finish' as const, output: 'done' },
    ];

  it('surfaces the question as an event and goes on only when it is answered', async () => {
    const answered: Array<{ choice: string; steered: string[] }> = [];
    gw.setScript(askAndFinish(answered));
    const handle = await runOnGateway(options(), input(), scope, { connection: 'managed' });
    const seen: BotRuntimeEvent[] = [];
    for await (const event of handle.events) {
      seen.push(event);
      if (event.type === 'approval') {
        expect(event).toMatchObject({ command: 'rm -rf build', description: 'delete files recursively', choices: ['once', 'session', 'deny'] });
        expect(answered).toHaveLength(0); // the program is still waiting
        expect(await event.answer('once', 'yes, in the build folder only')).toBe(true);
      }
    }
    expect(answered).toEqual([{ choice: 'once', steered: ['The person allowed that command and wrote: yes, in the build folder only'] }]);
    expect(resultOf(seen)).toMatchObject({ ok: true, text: 'done' });
  });

  it('tells the program "deny" with what the person wrote', async () => {
    const answered: Array<{ choice: string; steered: string[] }> = [];
    gw.setScript(askAndFinish(answered));
    const handle = await runOnGateway(options(), input(), scope, { connection: 'managed' });
    for await (const event of handle.events) if (event.type === 'approval') await event.answer('deny', 'not that folder');
    expect(answered).toEqual([{ choice: 'deny', steered: ['The person declined that command and wrote: not that folder'] }]);
  });

  it('does not count the wait against the run\'s time limit', async () => {
    gw.setScript(askAndFinish([]));
    // a one-second budget with a one-second grace: the person takes three seconds, and the run is still not stopped
    const handle = await runOnGateway(options(), input({}, 1), scope, { connection: 'managed' });
    const seen: BotRuntimeEvent[] = [];
    for await (const event of handle.events) {
      seen.push(event);
      if (event.type === 'approval') {
        await new Promise((r) => setTimeout(r, 3000));
        await event.answer('once');
      }
    }
    expect(resultOf(seen)).toMatchObject({ ok: true });
  }, 15_000);
});
