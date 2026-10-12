import { createHash } from 'node:crypto';
import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import type { CapabilityHandler } from '@manythreads/sdk';
import { McpRunMintResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// The gateway against a real database and the real server: a pairing token opens one run, the endpoint speaks MCP,
// a read lands its hits in `run_source_log`, and every refusal (no grant, approval needed, forged, expired, ended
// token) is checked where it happens. The last block drives `ctx.runs` itself, because two of its promises — that a
// read runs as the *asking person* and a write as the *bot*, both with `app.run_id` set — are what the whole design
// stands on and no HTTP assertion can see directly.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: World;
let teamId: string;
let devChannelId: string;
let bot: { botId: string; actorId: string };
let pairingToken: string;
let run: McpRunMintResponse;

const hash = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

const callRun = (token: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  world.call(null, 'POST', `/api/mcp/runs/${token}`, body);

const callRunUrl = (url: string, body: unknown): Promise<{ status: number; body: unknown }> =>
  world.call(null, 'POST', new URL(url).pathname, body);

const mintRun = (body: Record<string, unknown>): Promise<{ status: number; body: unknown }> =>
  world.call(null, 'POST', '/api/mcp/runs', { pairingToken, ...body });

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  devChannelId = await world.channelId('engineering', 'dev');
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);

  // A message whose words the search below can find (the match is word similarity, not substring).
  const posted = await world.call(nadia, 'POST', `/api/channels/${devChannelId}/messages`, {
    channelId: devChannelId,
    body: 'The cache TTL decision: three hundred seconds on the read path.',
    threadRootId: null,
  });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);

  bot = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'mcpgateway', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(
      "INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id",
      [omar.workspaceId, botId],
    );
    return { botId, actorId: actor.rows[0]!.id };
  });

  // The allowlist the loader will compile from BOT.md one day; the broker reads the same table.
  const grant = (capability: string, needsApproval: boolean) =>
    world.system((tx) =>
      tx.query(
        `INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints)
         VALUES ($1, $2, $3, $4, '{}') ON CONFLICT (actor_id, capability) DO UPDATE SET needs_approval = EXCLUDED.needs_approval`,
        [teamId, bot.actorId, capability, needsApproval],
      ),
    );
  await grant('messages.search', false);
  await grant('knowledge.search', false);
  await grant('pages.write', true);

  const minted = await world.call(omar, 'POST', '/api/teams/engineering/bots/mcpgateway/pairing-tokens', {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  pairingToken = (minted.body as { token: string }).token;
});

afterAll(async () => {
  await world?.close();
});

describe('gateway-mcp endpoint', () => {
  it('a pairing token opens one run and answers its URL', async () => {
    const res = await mintRun({ trigger: 'conversation', askerActorId: nadia.actorId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    run = McpRunMintResponse.parse(res.body);
    expect(run.botId).toBe(bot.botId);
    expect(run.url).toBe(`http://localhost:3000/api/mcp/runs/${run.token}`);
    const row = await world.system(
      async (tx) =>
        (
          await tx.query<{ status: string; trigger_type: string; asker_id: string; bot_id: string }>(
            'SELECT status, trigger_type, asker_id, bot_id FROM app.bot_runs WHERE id = $1',
            [run.runId],
          )
        ).rows[0]!,
    );
    expect(row).toMatchObject({ status: 'running', trigger_type: 'conversation', asker_id: nadia.actorId, bot_id: bot.botId });
  });

  it('the endpoint speaks MCP: initialize, then only the granted tools', async () => {
    const init = await callRunUrl(run.url, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    expect((init.body as { result: { protocolVersion: string; serverInfo: { name: string } } }).result.protocolVersion).toBe('2024-11-05');
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('manythreads');

    const list = await callRunUrl(run.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (list.body as { result: { tools: Array<{ name: string; description: string }> } }).result.tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('messages.search');
    expect(names).toContain('knowledge.search');
    // A path-guarded mutation is offered at grant level: the path is judged on the call, not on the listing.
    expect(names).toContain('pages.write');
    // the approval flag reaches the model as copy, so it can prefer a path that does not wait for a person
    expect(tools.find((t) => t.name === 'pages.write')?.description).toContain('approval');
    // no grant, so not offered — and asking for it below is refused the same way
    expect(names).not.toContain('files.search');
    expect(names).not.toContain('tasks.read');
  });

  it('a read answers hits and writes them into the run source log', async () => {
    const res = await callRunUrl(run.url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'messages.search', arguments: { query: 'cache TTL decision' } },
    });
    const answer = JSON.parse((res.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { hits: Array<{ id: string }> };
    expect(answer.hits.length).toBeGreaterThan(0);

    const logged = await world.system(
      async (tx) =>
        (await tx.query<{ source_type: string; source_ref: string; scope: string }>('SELECT source_type, source_ref, scope FROM app.run_source_log WHERE run_id = $1 ORDER BY seq', [run.runId])).rows,
    );
    expect(logged.length).toBe(answer.hits.length);
    expect(logged[0]).toMatchObject({ source_type: 'message', source_ref: answer.hits[0]!.id, scope: 'channel' });
  });

  it('a tool with no grant is refused and the denial is audited', async () => {
    const res = await callRunUrl(run.url, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'files.search', arguments: { query: 'anything' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'forbidden' });

    const denials = await world.system(
      async (tx) =>
        (
          await tx.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM app.events
              WHERE type = 'kernel.capability.denied' AND payload->>'capability' = 'files.search' AND payload->>'actorId' = $1`,
            [bot.actorId],
          )
        ).rows[0]!.n,
    );
    expect(denials).toBe(1);
  });

  it('a grant that needs approval stops before the page is written', async () => {
    const res = await callRunUrl(run.url, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/mcp-test.md', content: 'never written' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'approval_required' });
    const written = await world.system(
      async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'pages.page.written'")).rows[0]!.n,
    );
    expect(written).toBe(0);
  });

  it('a path the bot may never write is refused by the guard, and the handler never runs', async () => {
    const res = await callRunUrl(run.url, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'pages.write', arguments: { mode: 'create', path: 'bots/mcpgateway/BOT.md', content: 'nope' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBe(true);
    const answer = JSON.parse(result.content[0]!.text) as { ok: boolean; code: string; message: string };
    expect(answer).toMatchObject({ ok: false, code: 'forbidden' });
    expect(answer.message).toContain('not bot-writable');
  });

  it('knowledge.search answers an empty result and the reason, never invented content', async () => {
    const res = await callRunUrl(run.url, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'knowledge.search', arguments: { query: 'cache' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }> } }).result;
    expect(JSON.parse(result.content[0]!.text)).toEqual({ hits: [], reason: 'no bases configured' });
  });

  it('a forged pairing token cannot open a run', async () => {
    const res = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: 'forged', trigger: 'conversation' });
    expect(res.status).toBe(401);
  });

  it('an asker who is not on the team is refused, with the reason', async () => {
    const res = await mintRun({ trigger: 'conversation', askerActorId: sameera.actorId });
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('validation_failed');
    expect((res.body as { error: { message: string } }).error.message).toContain('not a person of that team');
  });

  it('a forged, expired or closed run token is one 401 for all three', async () => {
    expect((await callRun('forged', { jsonrpc: '2.0', id: 7, method: 'tools/list' })).status).toBe(401);

    const stale = await mintRun({ trigger: 'conversation', askerActorId: nadia.actorId });
    const staleRun = McpRunMintResponse.parse(stale.body);
    // Move the whole row into the past: the CHECK (`expires_at > created_at`) refuses to end a live token in place.
    await world.system((tx) =>
      tx.query("UPDATE app.mcp_run_tokens SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
        hash(staleRun.token),
      ]),
    );
    expect((await callRunUrl(staleRun.url, { jsonrpc: '2.0', id: 8, method: 'tools/list' })).status).toBe(401);

    const closed = await world.call(null, 'POST', `${new URL(run.url).pathname}/close`, { status: 'done' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toEqual({ ok: true, closed: true });
    expect((await callRunUrl(run.url, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status).toBe(401);
    const ended = await world.system(
      async (tx) => (await tx.query<{ status: string; ended_at: Date | null }>('SELECT status, ended_at FROM app.bot_runs WHERE id = $1', [run.runId])).rows[0]!,
    );
    expect(ended.status).toBe('done');
    expect(ended.ended_at).not.toBeNull();
  });
});

describe('ctx.runs service', () => {
  it('reads run as the asking person and writes as the bot, both with app.run_id set', async () => {
    const appPool = createAppPool(world.server.db.appUrl);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      registry.register({ name: 'demo.read', destructive: false, plugin: 'gateway-mcp-test' });
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
      const handler: CapabilityHandler = async (_input, tx) =>
        (await tx.query<{ actor: string; kind: string; run_id: string }>('SELECT app.actor() AS actor, app.actor_kind() AS kind, app.run_id() AS run_id')).rows[0];
      const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map([['demo.read', { plugin: 'gateway-mcp-test', handler }]]) });

      const opened = await service.open({ botId: bot.botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });
      expect(service.catalog()).toEqual([{ name: 'demo.read', destructive: false }]);
      expect(await service.resolve(hash(opened.token))).toMatchObject({ runId: opened.run.runId, askerActorId: nadia.actorId });

      // The broker is asked about the bot, not about whoever the transaction happens to be.
      expect(await service.authorize(opened.run, 'demo.read')).toMatchObject({ allowed: false });
      await world.system((tx) =>
        tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'demo.read') ON CONFLICT DO NOTHING`, [teamId, bot.actorId]),
      );
      expect(await service.authorize(opened.run, 'demo.read')).toMatchObject({ allowed: true, needsApproval: false });

      const asReader = await service.asReader(opened.run, (tx) => service.invoke(tx, 'demo.read', {}));
      expect(asReader).toEqual({ actor: nadia.actorId, kind: 'person', run_id: opened.run.runId });
      const asBot = await service.asBot(opened.run, (tx) => service.invoke(tx, 'demo.read', {}));
      expect(asBot).toEqual({ actor: bot.actorId, kind: 'bot', run_id: opened.run.runId });

      const seq = await service.asBot(opened.run, async (tx) => {
        const first = await service.logSource(tx, { sourceType: 'page', sourceRef: 'pages/x.md', scope: 'team' });
        const second = await service.logSource(tx, { sourceType: 'page', sourceRef: 'pages/y.md', scope: 'team' });
        return [first, second];
      });
      // 0-based: the log keeps read order and the first line of a run is position 0
      expect(seq).toEqual([0, 1]);

      await expect(service.invoke({ query: () => Promise.resolve({ rows: [] }) } as never, 'nothing.implemented', {})).rejects.toThrow('no plugin implements');
      expect(await service.close(opened.run.runId, 'stopped')).toBe(true);
      expect(await service.resolve(hash(opened.token))).toBeNull();
      expect(await service.close(opened.run.runId, 'done')).toBe(false);
    } finally {
      await appPool.end();
      await systemPool.end();
    }
  });

  it('an asker outside the team cannot open a run', async () => {
    const appPool = createAppPool(world.server.db.appUrl);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
      const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
      await expect(
        service.open({ botId: bot.botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: sameera.actorId }),
      ).rejects.toThrow('not a person of that team');
    } finally {
      await appPool.end();
      await systemPool.end();
    }
  });
});
