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

/** One request to the run's endpoint: the path names the run, the bearer header is the credential (and nothing else is). */
const request = async (path: string, token: string | null, body: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${world.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const callRun = (runId: string, token: string | null, body: unknown) => request(`/api/mcp/runs/${runId}`, token, body);
const callRunUrl = (target: { url: string; token: string }, body: unknown) => request(new URL(target.url).pathname, target.token, body);

/** The public mint: a pairing token and nothing else the caller may choose about the run. */
const mintRun = (body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> =>
  world.call(null, 'POST', '/api/mcp/runs', { pairingToken, ...body });

/**
 * A conversation run for a person, opened the only way that is allowed to name an asker: in-process, through the run service
 * (what the router does with `ctx.runs.open`). Its endpoint is the real server's, because the token's hash is in the database.
 */
async function openRunFor(askerActorId: string | null, botId: string = bot.botId): Promise<McpRunMintResponse> {
  const appPool = createAppPool(world.server.db.appUrl);
  const systemPool = createSystemPool(world.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
    const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({ botId, teamId, workspaceId: omar.workspaceId, trigger: askerActorId === null ? 'webhook' : 'conversation', ...(askerActorId === null ? {} : { askerActorId }) });
    return McpRunMintResponse.parse({
      runId: run.runId,
      botId: run.botId,
      url: `${world.server.url}/api/mcp/runs/${run.runId}`,
      token,
      expiresAt: run.expiresAt,
    });
  } finally {
    await appPool.end();
    await systemPool.end();
  }
}

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
    // The loader seats a bot on its team (that one row is what gives it the team's public channels and the board's `post` door).
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, actor.rows[0]!.id, omar.workspaceId]);
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
  await grant('proposals.propose', false);
  await grant('tasks.create', false);
  await world.system((tx) =>
    tx.query(
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, constraints) VALUES ($1, $2, 'tasks.handoff', '{"mayTag":["reviewer"]}')`,
      [teamId, bot.actorId],
    ),
  );
  // A second bot of the team, whom the first may hand cards to (and a third it may not).
  for (const slug of ['reviewer', 'stranger']) {
    await world.system(async (tx) => {
      const b = await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
        [omar.workspaceId, teamId, slug],
      );
      const a = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, b.rows[0]!.id]);
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, a.rows[0]!.id, omar.workspaceId]);
    });
  }

  const minted = await world.call(omar, 'POST', '/api/teams/engineering/bots/mcpgateway/pairing-tokens', {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  pairingToken = (minted.body as { token: string }).token;
});

afterAll(async () => {
  await world?.close();
});

describe('gateway-mcp endpoint', () => {
  it('a pairing token opens one run with no asker, and the URL carries no credential', async () => {
    const res = await mintRun();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const minted = McpRunMintResponse.parse(res.body);
    expect(minted.botId).toBe(bot.botId);
    expect(minted.url).toBe('http://localhost:3000/mcp');
    expect(minted.url).not.toContain(minted.token);
    const row = await world.system(
      async (tx) =>
        (
          await tx.query<{ status: string; trigger_type: string; asker_id: string | null; bot_id: string }>(
            'SELECT status, trigger_type, asker_id, bot_id FROM app.bot_runs WHERE id = $1',
            [minted.runId],
          )
        ).rows[0]!,
    );
    expect(row).toMatchObject({ status: 'running', trigger_type: 'webhook', asker_id: null, bot_id: bot.botId });
  });

  it('a person-run is opened in-process, and it is the person who asked who is recorded', async () => {
    run = await openRunFor(nadia.actorId);
    const row = await world.system(
      async (tx) =>
        (await tx.query<{ trigger_type: string; asker_id: string }>('SELECT trigger_type, asker_id FROM app.bot_runs WHERE id = $1', [run.runId])).rows[0]!,
    );
    expect(row).toMatchObject({ trigger_type: 'conversation', asker_id: nadia.actorId });
  });

  it('the endpoint speaks MCP: initialize, then only the granted tools', async () => {
    const init = await callRunUrl(run, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    expect((init.body as { result: { protocolVersion: string; serverInfo: { name: string } } }).result.protocolVersion).toBe('2024-11-05');
    expect((init.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('manythreads');

    const list = await callRunUrl(run, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
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
    const res = await callRunUrl(run, {
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

  it('a card created by a tool is the board’s own card: the bot writes it in its team, with the route’s row, history and event', async () => {
    const res = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 55,
      method: 'tools/call',
      params: { name: 'tasks.create', arguments: { title: 'Add retry to the upload client', branch: 'fix/upload-retry', kind: 'code', priority: 'high' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError, JSON.stringify(result)).toBeFalsy();
    const answer = JSON.parse(result.content[0]!.text) as { ok: boolean; task: { id: string; teamId: string; title: string; state: string; kind: string; priority: string; createdBy: string } };
    expect(answer.ok).toBe(true);
    expect(answer.task).toMatchObject({
      teamId,
      title: 'Add retry to the upload client',
      state: 'open',
      kind: 'code',
      priority: 'high',
      createdBy: bot.actorId,
    });

    // The route's door wrote the row and its `created` history; the event is what a board reads to redraw.
    const stored = await world.system(async (tx) =>
      (await tx.query<{ created_by: string; branch: string }>('SELECT created_by, branch FROM app.tasks WHERE id = $1::uuid', [answer.task.id])).rows[0],
    );
    expect(stored).toMatchObject({ created_by: bot.actorId, branch: 'fix/upload-retry' });
    const history = await world.system(async (tx) =>
      (await tx.query<{ actor_id: string; type: string }>('SELECT actor_id, type FROM app.task_events WHERE task_id = $1::uuid', [answer.task.id])).rows,
    );
    expect(history).toEqual([{ actor_id: bot.actorId, type: 'created' }]);
    const emitted = await world.system(async (tx) =>
      (await tx.query<{ payload: { taskId: string; creatorId: string } }>("SELECT payload FROM app.events WHERE type = 'tasks.task.created' AND team_id = $1 ORDER BY id DESC LIMIT 1", [teamId])).rows[0],
    );
    expect(emitted?.payload).toMatchObject({ taskId: answer.task.id, creatorId: bot.actorId });
  });

  it('a card a tool creates names its own team and refuses one with no title before anything is written', async () => {
    const before = await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.tasks WHERE team_id = $1', [teamId])).rows[0]!.n);
    const res = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 56,
      method: 'tools/call',
      params: { name: 'tasks.create', arguments: { title: '', branch: 'fix/upload-retry' } },
    });
    // A tool's own refusal is an answer the model can read and retry (the reason is in the content), not a transport failure; it is marked
    // `isError` so the client (and the runtime's log) sees a failed call rather than a success.
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, code: 'invalid_input' });
    const after = await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.tasks WHERE team_id = $1', [teamId])).rows[0]!.n);
    expect(after).toBe(before);
  });

  it('a bot that was handed a card by a person hands it on by tool, naming the bot by slug (live: the slug in toActorId threw, with no reason)', async () => {
    const created = await world.call(omar, 'POST', '/api/teams/engineering/tasks', { title: 'Pad the cents', branch: 'fix/pad-cents', kind: 'code', priority: 'normal' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { task: { id: string } }).task.id;
    const handed = await world.call(omar, 'POST', `/api/teams/engineering/tasks/${id}/handoff`, { toBotSlug: 'mcpgateway', mode: 'bot', note: 'build it' });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    const tool = async (args: Record<string, unknown>) => {
      const res = await callRunUrl(run, { jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'tasks.handoff', arguments: { taskId: id, ...args } } });
      const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
      return { isError: result.isError, answer: JSON.parse(result.content[0]!.text) as { ok: boolean; code?: string; message?: string } };
    };
    const owner = () => world.system(async (tx) => (await tx.query<{ owner: string }>('SELECT a.ref_id::text AS owner FROM app.tasks t JOIN app.actors a ON a.id = t.owner_id WHERE t.id = $1::uuid', [id])).rows[0]?.owner);

    // Refusals say what to do instead, and arrive as failed calls.
    const outside = await tool({ toBotSlug: 'stranger' });
    expect(outside.isError).toBe(true);
    expect(outside.answer).toMatchObject({ ok: false, code: 'forbidden' });
    expect(outside.answer.message).toContain('handover.mayTag');
    const missing = await tool({});
    expect(missing).toMatchObject({ isError: true, answer: { ok: false, code: 'invalid_input' } });
    expect(missing.answer.message).toContain('toBotSlug');
    const unknown = await tool({ toBotSlug: 'nobody' });
    expect(unknown.answer).toMatchObject({ ok: false, code: 'not_found' });
    expect(await owner()).toBe(bot.botId);

    // A slug in the wrong field still works.
    const done = await tool({ toActorId: 'reviewer', note: 'please review' });
    expect(done.isError, JSON.stringify(done)).toBeFalsy();
    expect(done.answer.ok).toBe(true);
    const row = await world.system(async (tx) => (await tx.query<{ slug: string }>('SELECT b.slug FROM app.tasks t JOIN app.actors a ON a.id = t.owner_id JOIN app.bots b ON b.id = a.ref_id WHERE t.id = $1::uuid', [id])).rows[0]);
    expect(row?.slug).toBe('reviewer');
  });

  it('a private note on a handover round-trips through the real host and secret service, and shows up nowhere else', async () => {
    const SECRET = 'pw-Zk4-very-private-9931';
    const created = await world.call(omar, 'POST', '/api/teams/engineering/tasks', { title: 'Private note card', branch: 'fix/private-note', kind: 'other', priority: 'normal' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { task: { id: string } }).task.id;
    expect((await world.call(omar, 'POST', `/api/teams/engineering/tasks/${id}/handoff`, { toBotSlug: 'mcpgateway', mode: 'bot', note: 'go' })).status).toBe(200);
    const reviewer = await world.system(async (tx) => {
      const r = (await tx.query<{ bot_id: string; actor_id: string }>(`SELECT b.id AS bot_id, a.id AS actor_id FROM app.bots b JOIN app.actors a ON a.ref_id = b.id AND a.kind = 'bot' WHERE b.slug = 'reviewer' AND b.team_id = $1`, [teamId])).rows[0]!;
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, constraints) VALUES ($1, $2, 'tasks.private_note', '{}')`, [teamId, r.actor_id]);
      return r;
    });
    const call = async (target: McpRunMintResponse, name: string, args: Record<string, unknown>) => {
      const res = await callRunUrl(target, { jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name, arguments: args } });
      const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
      return { isError: result.isError, answer: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
    };
    const handed = await call(run, 'tasks.handoff', { taskId: id, toBotSlug: 'reviewer', note: 'url and emails', privateNote: SECRET });
    expect(handed.answer, JSON.stringify(handed)).toMatchObject({ ok: true, privateNoteSealed: true });
    expect(JSON.stringify(handed)).not.toContain(SECRET);

    const reviewerRun = await openRunFor(null, reviewer.bot_id);
    const read = await call(reviewerRun, 'tasks.private_note', { taskId: id });
    expect(read.answer, JSON.stringify(read)).toMatchObject({ ok: true, privateNote: SECRET });
    // The giver no longer owns the card and was never the recipient: nothing.
    expect((await call(run, 'tasks.private_note', { taskId: id })).isError).toBe(true);

    // The text is in no message, event, history row or handover row; the secret store holds only ciphertext.
    const leaks = await world.system(async (tx) => {
      const like = `%${SECRET}%`;
      const n = async (sql: string) => (await tx.query<{ n: number }>(sql, [like])).rows[0]!.n;
      return [
        await n('SELECT count(*)::int AS n FROM app.messages WHERE body ILIKE $1 OR body_plain ILIKE $1'),
        await n('SELECT count(*)::int AS n FROM app.events WHERE payload::text ILIKE $1'),
        await n('SELECT count(*)::int AS n FROM app.task_events WHERE data::text ILIKE $1'),
        await n('SELECT count(*)::int AS n FROM app.handoffs WHERE note ILIKE $1'),
        // a byte search: decoding random ciphertext as text fails whenever it holds a 0x00 byte
        await n('SELECT count(*)::int AS n FROM app.secrets WHERE position(convert_to(trim(both \'%\' from $1), \'UTF8\') in ciphertext) > 0'),
      ];
    });
    expect(leaks).toEqual([0, 0, 0, 0, 0]);

    // Completing the card deletes its private notes.
    await world.system(async (tx) => {
      await tx.query(`UPDATE app.tasks SET state = 'done', completed_at = now() WHERE id = $1::uuid`, [id]);
      await tx.query('SELECT app.tasks_drop_private_notes($1::uuid)', [id]);
    });
    const after = await call(reviewerRun, 'tasks.private_note', { taskId: id });
    expect(after.answer, JSON.stringify(after)).toMatchObject({ ok: false, code: 'no_private_note' });
    expect(await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.handoffs WHERE task_id = $1::uuid AND private_note_secret_id IS NOT NULL', [id])).rows[0]!.n)).toBe(0);
  });

  it('a tool with no grant is refused and the denial is audited', async () => {
    const res = await callRunUrl(run, {
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

  it('a grant that needs approval stops before the page is written, and waits in the Approvals inbox', async () => {
    const res = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/mcp-test.md', content: 'never written' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    const answer = JSON.parse(result.content[0]!.text) as { ok: boolean; code: string; approvalId: string };
    expect(answer).toMatchObject({ ok: false, code: 'approval_pending' });
    const written = await world.system(
      async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'pages.page.written'")).rows[0]!.n,
    );
    expect(written).toBe(0);
    // one pending approval of this bot, filed through the approvals plugin's handler, requested by the person who asked the run; the real
    // arguments are in `resume`, the approver sees a preview
    const row = await world.system(
      async (tx) =>
        (
          await tx.query<{ source: string; status: string; tool: string; bot_id: string; requester_id: string; resume: { kind: string; capability: string; args: { path: string } } }>(
            'SELECT source, status, tool, bot_id, requester_id, resume FROM app.approvals WHERE id = $1',
            [answer.approvalId],
          )
        ).rows[0],
    );
    expect(row).toMatchObject({ source: 'grant', status: 'pending', tool: 'pages.write', bot_id: bot.botId, requester_id: nadia.actorId });
    expect(row?.resume).toMatchObject({ kind: 'tool', capability: 'pages.write', args: { path: 'pages/mcp-test.md' } });
    // asking again for the same call is the same approval
    const again = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'pages.write', arguments: { mode: 'create', path: 'pages/mcp-test.md', content: 'never written' } },
    });
    const second = JSON.parse((again.body as { result: { content: Array<{ text: string }> } }).result.content[0]!.text) as { approvalId: string };
    expect(second.approvalId).toBe(answer.approvalId);
  });

  it('a path the bot may never write is refused by the guard, and the handler never runs', async () => {
    const res = await callRunUrl(run, {
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

  it('proposals.propose is how a bot reaches a guarded path: it files a proposal as the bot, and nothing is committed', async () => {
    const list = await callRunUrl(run, { jsonrpc: '2.0', id: 8, method: 'tools/list' });
    expect((list.body as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name)).toContain('proposals.propose');
    const res = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'proposals.propose', arguments: { path: 'TEAM.md', content: '---\nname: Engineering\n---\n\nA bot suggests this.\n', title: 'A bot suggests a purpose' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    const answer = JSON.parse(result.content[0]!.text) as { ok: boolean; proposal?: { id: string; status: string } };
    expect(result.isError, result.content[0]!.text).not.toBe(true);
    expect(answer).toMatchObject({ ok: true, proposal: { status: 'open' } });
    const row = await world.system(async (tx) => (await tx.query<{ author_id: string; author_kind: string }>('SELECT author_id, author_kind FROM app.proposals WHERE id = $1', [answer.proposal!.id])).rows[0]);
    expect(row).toMatchObject({ author_id: bot.actorId, author_kind: 'bot' });
  });

  it('knowledge.search is the knowledge plugin’s tool: with nothing indexed it answers no passages and tells the bot not to guess', async () => {
    const res = await callRunUrl(run, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'knowledge.search', arguments: { query: 'cache' } },
    });
    const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
    expect(result.isError, result.content[0]!.text).not.toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, mode: 'lexical', hits: [], answerOnlyFromKnowledge: false, note: expect.stringContaining('Nothing in the knowledge bases matched') });
  });

  it('knowledge.search finds passages with their citation, only in the bases the bot lists, and says plainly when the bot answers only from them', async () => {
    // Two bases with one indexed document each; the bot lists only the first, strictly. Written as the system (the plugin's own tests upload through the API).
    await world.system(async (tx) => {
      for (const [slug, docName, text] of [
        ['handbook', 'Refund policy.pdf', 'Refunds are paid within 14 days of the request.'],
        ['salaries', 'Pay bands.csv', 'Refunds of expenses are paid with the monthly salary.'],
      ] as const) {
        const base = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_bases (workspace_id, team_id, slug, name) VALUES ($1, $2, $3, $3) RETURNING id`, [omar.workspaceId, teamId, slug])).rows[0]!.id;
        const source = (await tx.query<{ id: string }>(`INSERT INTO app.knowledge_sources (base_id, team_id, kind) VALUES ($1, $2, 'upload') RETURNING id`, [base, teamId])).rows[0]!.id;
        const doc = (await tx.query<{ id: string }>(
          `INSERT INTO app.knowledge_documents (base_id, team_id, source_id, name, slug, kind, size, sha256, version, status, repo_path, chunk_count)
           VALUES ($1, $2, $3, $4, $5, 'text', 10, repeat('a', 64), 2, 'indexed', $6, 1) RETURNING id`,
          [base, teamId, source, docName, docName.toLowerCase().replace(/[^a-z]+/g, '-'), `knowledge/${slug}/${docName.toLowerCase().replace(/[^a-z]+/g, '-')}.md`],
        )).rows[0]!.id;
        await tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, section, char_start, char_end) VALUES ($1, $2, $3, 0, 2, $4, 'Money', 0, $5)`, [doc, base, teamId, text, text.length]);
        // an older version of the first document's passage, kept for citations: never searched
        if (slug === 'handbook') await tx.query(`INSERT INTO app.knowledge_chunks (document_id, base_id, team_id, ordinal, version, text, section, char_start, char_end) VALUES ($1, $2, $3, 0, 1, 'Refunds are paid within 7 days.', 'Money', 0, 30)`, [doc, base, teamId]);
      }
    });
    const search = async (target: McpRunMintResponse, args: Record<string, unknown>) => {
      const res = await callRunUrl(target, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'knowledge.search', arguments: args } });
      const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
      expect(result.isError, result.content[0]!.text).not.toBe(true);
      return JSON.parse(result.content[0]!.text) as { ok: boolean; answerOnlyFromKnowledge: boolean; note: string; hits: Array<{ base: string; document: string; version: number; citation: string; text: string; file: string }> };
    };

    // no list on the bot: every base of its team
    const open = await openRunFor(nadia.actorId);
    const all = await search(open, { query: 'refunds paid' });
    expect(all.hits.map((h) => h.base).sort()).toEqual(['handbook', 'salaries']);
    expect(all.answerOnlyFromKnowledge).toBe(false);
    const handbook = all.hits.find((h) => h.base === 'handbook')!;
    expect(handbook).toMatchObject({ document: 'Refund policy.pdf', version: 2, citation: 'Refund policy.pdf, version 2, Money', file: 'knowledge/handbook/refund-policy-pdf.md' });
    expect(handbook.text).toContain('14 days');

    // the bot lists one base, strictly (what the loader writes from BOT.md)
    await world.system((tx) => tx.query(`UPDATE app.bots SET knowledge = '[{"base":"handbook","answer_only_from":true}]'::jsonb WHERE id = $1`, [bot.botId]));
    const scoped = await openRunFor(nadia.actorId);
    const mine = await search(scoped, { query: 'refunds paid' });
    expect(mine.hits.map((h) => h.base)).toEqual(['handbook']);
    expect(mine.answerOnlyFromKnowledge).toBe(true);
    expect(mine.note).toContain('only from these passages');
    // asking for another base, or another team, does not widen it
    expect((await search(scoped, { query: 'refunds paid', base: 'salaries' })).hits).toEqual([]);
    const none = await search(scoped, { query: 'weather in Lisbon' });
    expect(none.hits).toEqual([]);
    expect(none.note).toContain('say plainly that you cannot answer');
    const wrongTeam = await search(scoped, { query: 'refunds', teamId: '00000000-0000-7000-8000-000000000001' });
    expect(wrongTeam).toMatchObject({ ok: false, code: 'other_team' });

    // the run's log names the document and version, and the converted page a citation can open
    const logged = await world.system(async (tx) =>
      (await tx.query<{ source_type: string; source_ref: string }>('SELECT source_type, source_ref FROM app.run_source_log WHERE run_id = $1 ORDER BY seq', [scoped.runId])).rows,
    );
    expect(logged).toEqual(expect.arrayContaining([{ source_type: 'knowledge', source_ref: 'handbook/Refund policy.pdf v2' }, { source_type: 'page', source_ref: 'knowledge/handbook/refund-policy-pdf.md' }]));
    expect(JSON.stringify(logged)).not.toContain('salaries');

    // the gate on posting, as the answer plugin asks the database: strict and nothing read from the bases yet, then strict and a base was read
    const gateOf = (runId: string) =>
      world.system(async (tx) => {
        await tx.query(`SELECT set_config('app.run_id', $1, true), set_config('app.actor_id', $2, true)`, [runId, bot.actorId]);
        return (await tx.query<{ g: unknown }>('SELECT app.answer_knowledge_gate() AS g')).rows[0]!.g;
      });
    expect(await gateOf(scoped.runId)).toMatchObject({ strict: true, used: true });
    expect(await gateOf((await openRunFor(nadia.actorId)).runId)).toMatchObject({ strict: true, used: false });
    await world.system((tx) => tx.query(`UPDATE app.bots SET knowledge = NULL WHERE id = $1`, [bot.botId]));
  });

  it('the one address /mcp: a run token opens that run, a bot token opens the bot, anything else is one 401', async () => {
    const viaRun = await request('/mcp', run.token, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(viaRun.status, JSON.stringify(viaRun.body)).toBe(200);
    expect((viaRun.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('manythreads');

    const viaBot = await request('/mcp', pairingToken, { jsonrpc: '2.0', id: 2, method: 'initialize' });
    expect(viaBot.status, JSON.stringify(viaBot.body)).toBe(200);
    expect((viaBot.body as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('manythreads');

    const forged = await request('/mcp', 'forged-token-0123', { jsonrpc: '2.0', id: 3, method: 'initialize' });
    expect(forged.status).toBe(401);
    const none = await request('/mcp', null, { jsonrpc: '2.0', id: 4, method: 'initialize' });
    expect(none.status).toBe(401);
  });

  it('/mcp bounds an authenticated run at 600 calls a minute, per run', async () => {
    const minted = McpRunMintResponse.parse((await mintRun()).body);
    const other = McpRunMintResponse.parse((await mintRun()).body);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    let limited = -1;
    for (let i = 0; i < 601; i++) {
      const r = await request('/mcp', minted.token, ping);
      if (r.status === 429) {
        limited = i;
        break;
      }
    }
    expect(limited).toBe(600);
    // Another run is not affected by this one's burst.
    expect((await request('/mcp', other.token, ping)).status).toBe(200);
  });

  it('a forged pairing token cannot open a run', async () => {
    const res = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: 'forged' });
    expect(res.status).toBe(401);
  });

  it('a pairing-token holder cannot choose the asker or the trigger: the public mint refuses both', async () => {
    const before = await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_runs WHERE bot_id = $1', [bot.botId])).rows[0]!.n);
    // A teammate's actor id (a real asker would let the run read as them), and a trigger that unlocks person:* scopes.
    for (const forged of [
      { trigger: 'conversation', askerActorId: nadia.actorId },
      { askerActorId: nadia.actorId },
      { trigger: 'mention' },
    ]) {
      const res = await mintRun(forged);
      expect(res.status, JSON.stringify(forged)).toBe(400);
    }
    const after = await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_runs WHERE bot_id = $1', [bot.botId])).rows[0]!.n);
    expect(after).toBe(before); // nothing was opened on the way
  });

  it('the token lives in the Authorization header only: not in the path, not for another run, not absent', async () => {
    const other = McpRunMintResponse.parse((await mintRun()).body);
    const tools = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    expect((await callRun(other.runId, other.token, tools)).status).toBe(200);
    // the old shape: the token as the path segment
    expect((await callRun(other.token, other.token, tools)).status).toBe(401);
    expect((await callRun(other.token, null, tools)).status).toBe(401);
    // no header, a malformed one, and one run's token against another run's URL
    expect((await callRun(other.runId, null, tools)).status).toBe(401);
    expect((await callRun(run.runId, other.token, tools)).status).toBe(401);
    expect((await callRun(other.runId, run.token, tools)).status).toBe(401);
    const res = await fetch(`${world.server.url}/api/mcp/runs/${other.runId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${other.token}` },
      body: JSON.stringify(tools),
    });
    expect(res.status).toBe(401);
  });

  it('a forged, expired or closed run token is one 401 for all three', async () => {
    expect((await callRun(run.runId, 'forged', { jsonrpc: '2.0', id: 7, method: 'tools/list' })).status).toBe(401);

    const stale = await mintRun();
    const staleRun = McpRunMintResponse.parse(stale.body);
    // Move the whole row into the past: the CHECK (`expires_at > created_at`) refuses to end a live token in place.
    await world.system((tx) =>
      tx.query("UPDATE app.mcp_run_tokens SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
        hash(staleRun.token),
      ]),
    );
    expect((await callRunUrl(staleRun, { jsonrpc: '2.0', id: 8, method: 'tools/list' })).status).toBe(401);

    const closed = await request(`${new URL(run.url).pathname}/close`, run.token, { status: 'done' });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body).toEqual({ ok: true, closed: true });
    expect((await callRunUrl(run, { jsonrpc: '2.0', id: 9, method: 'tools/list' })).status).toBe(401);
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

  it('parallel source-log appends of one run take consecutive positions (no max(seq)+1 race)', async () => {
    const appPool = createAppPool(world.server.db.appUrl, 12);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
      const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
      const opened = await service.open({ botId: bot.botId, teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });
      // Each append is a transaction of its own, as a model's parallel tool calls are: without the per-run lock they all read the
      // same maximum and all but one die on the (run_id, seq) key.
      const seqs = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.asBot(opened.run, (tx) => service.logSource(tx, { sourceType: 'page', sourceRef: `pages/parallel-${i}.md`, scope: 'team' })),
        ),
      );
      expect([...seqs].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      const stored = await world.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.run_source_log WHERE run_id = $1', [opened.run.runId])).rows[0]!.n);
      expect(stored).toBe(10);
      await service.close(opened.run.runId, 'done');
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
