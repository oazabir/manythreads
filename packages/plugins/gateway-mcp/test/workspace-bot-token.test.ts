import { createHash } from 'node:crypto';
import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// P20-LV: the workspace Brain (a bot of scope `workspace`, no team) holds a pairing token on a Hermes profile like any bot. Before this, nothing could mint one (the database
// function answered "no such bot" for a bot with no team), so the profile on the host gateway kept the token of the retired team Brain and every Brain run ended with a 401 at
// the tool address. The token must work at `/mcp`, and it must not let its holder act as a team: it acts only inside the one run that is open, in that run's team.

const { omar, nadia, sameera } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: World;
let engineeringId: string;
let marketingId: string;
let brain: { botId: string; actorId: string };
let token = '';

const request = async (path: string, bearer: string | null, body: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${world.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const rpc = (bearer: string | null, method: string, params?: unknown, id = 1) => request('/mcp', bearer, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const toolResult = (body: unknown): { isError?: boolean; payload: Record<string, unknown> } => {
  const result = (body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { ...(result.isError === undefined ? {} : { isError: result.isError }), payload: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
};

/**
 * A run of the Brain in `teamId`, opened in-process like the router does. It is a `drop` run only because that is the one jobless run the bot's own address takes as the bot's open
 * run (a router run has a job). Its token is not the profile's: the profile holds only the bot's pairing token.
 */
async function openBrainRun(teamId: string): Promise<string> {
  const appPool = createAppPool(world.server.db.appUrl);
  const systemPool = createSystemPool(world.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
    const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
    const { run } = await service.open({ botId: brain.botId, teamId, workspaceId: omar.workspaceId, trigger: 'drop' });
    return run.runId;
  } finally {
    await appPool.end();
    await systemPool.end();
  }
}

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  const team = (slug: string): Promise<string> => world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0]!.id);
  engineeringId = await team('engineering');
  marketingId = await team('marketing');
  brain = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, scope)
       VALUES ($1, NULL, 'brain', 'Brain', 'Remembers', 'agent', 'hermes', 'workspace', repeat('b', 64), 'active', 'workspace') RETURNING id`,
      [omar.workspaceId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, botId]);
    const actorId = actor.rows[0]!.id;
    for (const t of [engineeringId, marketingId]) {
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [t, actorId, omar.workspaceId]);
    }
    // the loader writes a workspace bot's grants with the workspace id in the team column
    for (const capability of ['messages.search', 'messages.post']) {
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')`, [omar.workspaceId, actorId, capability]);
    }
    return { botId, actorId };
  });
}, 240_000);

afterAll(async () => {
  await world?.close();
});

describe('a pairing token for the workspace Brain', () => {
  it('is minted by a workspace admin through any team of the workspace, and by nobody else', async () => {
    // a lead of Engineering manages that team, not the workspace: the Brain belongs to no team, so only an admin pairs it
    expect((await world.call(nadia, 'POST', '/api/teams/engineering/bots/brain/pairing-tokens', {})).status).toBe(403);
    expect((await world.call(sameera, 'POST', '/api/teams/engineering/bots/brain/pairing-tokens', {})).status).toBe(403);
    const minted = await world.call<{ token: string }>(omar, 'POST', '/api/teams/engineering/bots/brain/pairing-tokens', {});
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    token = minted.body.token;
    expect(token.length).toBeGreaterThan(20);
    const stored = await world.system(async (tx) =>
      (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE bot_id = $1 AND revoked_at IS NULL AND token_hash = $2', [brain.botId, createHash('sha256').update(token, 'utf8').digest()])).rows[0]!.n,
    );
    expect(stored).toBe(1);
  });

  it('is accepted at the one tool address: initialize and the tool list answer, where a made-up token is one 401', async () => {
    const init = await rpc(token, 'initialize');
    expect(init.status, JSON.stringify(init.body)).toBe(200);
    const list = await rpc(token, 'tools/list', undefined, 2);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect((await rpc('made-up-token-0123', 'initialize')).status).toBe(401);
  });

  it('acts for nobody while no conversation is open: a call is refused with a plain reason', async () => {
    const called = await rpc(token, 'tools/call', { name: 'messages.search', arguments: { query: 'anything' } }, 3);
    expect(called.status).toBe(200);
    const out = toolResult(called.body);
    expect(out.isError).toBe(true);
    expect(out.payload).toMatchObject({ ok: false, code: 'no_open_run' });
  });

  it('acts inside the one open run and only in that run\'s team: a write that names another team\'s channel is refused', async () => {
    const marketingChannel = await world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.channels WHERE team_id = $1 ORDER BY created_at LIMIT 1', [marketingId])).rows[0]!.id);
    const runId = await openBrainRun(engineeringId);
    try {
      const raw = (await rpc(token, 'tools/call', { name: 'messages.post', arguments: { channelId: marketingChannel, body: 'cross-team' } }, 4)).body;
      const refused = toolResult(raw);
      expect(refused.isError).toBe(true);
      expect(refused.payload).toMatchObject({ ok: false, code: 'other_space' });
      // in the run's own team the same tool goes through
      const devChannel = await world.channelId('engineering', 'dev');
      const own = toolResult((await rpc(token, 'tools/call', { name: 'messages.post', arguments: { channelId: devChannel, body: 'own-team' } }, 5)).body);
      expect(own.isError, JSON.stringify(own.payload)).toBeUndefined();
      expect(own.payload).toMatchObject({ ok: true });
      const posted = await world.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.messages WHERE channel_id = $1 AND body_plain = 'cross-team'`, [marketingChannel])).rows[0]!.n);
      expect(posted).toBe(0);
    } finally {
      await world.system((tx) => tx.query(`UPDATE app.bot_runs SET status = 'done', ended_at = now() WHERE id = $1`, [runId]));
    }
  });

  it('stops working when a workspace admin revokes it', async () => {
    const revoked = await world.call<{ revoked: number }>(omar, 'DELETE', '/api/teams/engineering/bots/brain/pairing-tokens');
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(1);
    expect((await rpc(token, 'initialize')).status).toBe(401);
    // and a lead who is not an admin cannot revoke it either
    expect((await world.call(nadia, 'DELETE', '/api/teams/engineering/bots/brain/pairing-tokens')).status).toBe(403);
  });
});
