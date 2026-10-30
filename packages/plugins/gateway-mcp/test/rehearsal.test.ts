import { createHash } from 'node:crypto';
import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { McpRunMintResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// The rehearsal hold-back at the gateway (PLAN P7-11): a run the router opened as a rehearsal makes no write. The tool the bot calls is answered "not done",
// one line of what it aimed at is kept (never the text), nothing waits in the Approvals inbox, and the reply (answer.post) and every read still work. The same
// call on a normal run really writes, so the hold-back is the run's own flag and nothing else.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

let world: World;
let teamId: string;
let devChannelId: string;
let bot: { botId: string; actorId: string };

const request = async (path: string, token: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${world.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

async function openRun(rehearsal: boolean, trigger: 'conversation' | 'webhook' = 'conversation'): Promise<McpRunMintResponse> {
  const appPool = createAppPool(world.server.db.appUrl);
  const systemPool = createSystemPool(world.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
    const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
    const { run, token } = await service.open({
      botId: bot.botId,
      teamId,
      workspaceId: omar.workspaceId,
      trigger,
      ...(trigger === 'conversation' ? { askerActorId: nadia.actorId } : {}),
      ...(rehearsal ? { rehearsal: true } : {}),
    });
    return McpRunMintResponse.parse({ runId: run.runId, botId: run.botId, url: `${world.server.url}/api/mcp/runs/${run.runId}`, token, expiresAt: run.expiresAt });
  } finally {
    await appPool.end();
    await systemPool.end();
  }
}

const call = async (run: McpRunMintResponse, name: string, args: Record<string, unknown>) => {
  const res = await request(new URL(run.url).pathname, run.token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const result = (res.body as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { isError: result.isError === true, answer: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
};

const count = (sql: string, params: unknown[] = []): Promise<number> =>
  world.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM (${sql}) q`, params)).rows[0]!.n);

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  devChannelId = await world.channelId('engineering', 'dev');
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  bot = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'rehearsed', 'agent', 'rules', 'team', repeat('c', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId]);
    await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [teamId, actor.rows[0]!.id, omar.workspaceId]);
    return { botId, actorId: actor.rows[0]!.id };
  });
  const grant = (capability: string, needsApproval: boolean) =>
    world.system((tx) =>
      tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, $4, '{}')`, [teamId, bot.actorId, capability, needsApproval]),
    );
  await grant('messages.search', false);
  await grant('messages.post', false);
  await grant('tasks.create', false);
  await grant('pages.write', true);
  await grant('answer.post', false);
});

afterAll(async () => {
  await world?.close();
});

describe('rehearsal hold-back', () => {
  it('a write in a rehearsal makes no change, is answered "not done", and one line of what it aimed at is kept', async () => {
    const run = await openRun(true);
    const before = await count("SELECT 1 FROM app.messages WHERE body = 'rehearsal hello'");
    const res = await call(run, 'messages.post', { channelId: devChannelId, body: 'rehearsal hello' });
    expect(res.isError).toBe(false);
    expect(res.answer).toMatchObject({ ok: true, rehearsal: true, done: false });
    expect(String(res.answer.message)).toContain('NOT done');
    expect(await count("SELECT 1 FROM app.messages WHERE body = 'rehearsal hello'")).toBe(before);

    const lines = await world.system(async (tx) =>
      (await tx.query<{ seq: number; capability: string; target: string | null; would_wait: boolean }>('SELECT seq, capability, target, would_wait FROM app.rehearsal_intercepts WHERE run_id = $1 ORDER BY seq', [run.runId])).rows,
    );
    expect(lines).toEqual([{ seq: 0, capability: 'messages.post', target: devChannelId, would_wait: false }]);
    // the text the call would have written is not kept anywhere in the line
    expect(JSON.stringify(lines)).not.toContain('rehearsal hello');
  });

  it('a card is not created, and a second held-back write takes the next position', async () => {
    const run = await openRun(true);
    const before = await count('SELECT 1 FROM app.tasks');
    const res = await call(run, 'tasks.create', { title: 'Never made', branch: 'fix/never' });
    expect(res.answer).toMatchObject({ rehearsal: true, done: false });
    await call(run, 'messages.post', { channelId: devChannelId, body: 'second' });
    expect(await count('SELECT 1 FROM app.tasks')).toBe(before);
    const seqs = await world.system(async (tx) => (await tx.query<{ seq: number; capability: string }>('SELECT seq, capability FROM app.rehearsal_intercepts WHERE run_id = $1 ORDER BY seq', [run.runId])).rows);
    expect(seqs.map((r) => `${r.seq}:${r.capability}`)).toEqual(['0:tasks.create', '1:messages.post']);
  });

  it('a grant that needs approval waits for nobody in a rehearsal: no approval is filed, and the line says it would have waited', async () => {
    const run = await openRun(true);
    const before = await count('SELECT 1 FROM app.approvals');
    const res = await call(run, 'pages.write', { mode: 'create', path: 'pages/rehearsal.md', content: 'never written' });
    expect(res.answer).toMatchObject({ ok: true, rehearsal: true, done: false });
    expect(await count('SELECT 1 FROM app.approvals')).toBe(before);
    const line = await world.system(async (tx) => (await tx.query<{ would_wait: boolean; target: string | null }>('SELECT would_wait, target FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).rows[0]);
    expect(line).toEqual({ would_wait: true, target: 'pages/rehearsal.md' });
  });

  it('a tool the bot has no grant for is still refused as before, and is not listed as held back', async () => {
    const run = await openRun(true);
    const res = await call(run, 'tasks.claim', { taskId: '00000000-0000-7000-8000-000000000001' });
    expect(res.isError).toBe(true);
    expect(res.answer).toMatchObject({ ok: false });
    expect(res.answer).not.toHaveProperty('rehearsal');
    expect(await count('SELECT 1 FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).toBe(0);
  });

  it('reads run as usual in a rehearsal, and the reply (answer.post) is not held back', async () => {
    const run = await openRun(true);
    const read = await call(run, 'messages.search', { query: 'anything at all' });
    expect(read.isError).toBe(false);
    expect(read.answer).not.toHaveProperty('rehearsal');
    const reply = await call(run, 'answer.post', { body: 'Here is the answer.', citations: [] });
    expect(reply.answer).not.toHaveProperty('rehearsal');
    expect(await count('SELECT 1 FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).toBe(0);
  });

  it('a reply that would wait for a person files no card in a rehearsal: it is held back like a write, and the line says it would have waited', async () => {
    const setApproval = (needs: boolean) =>
      world.system((tx) => tx.query("UPDATE app.capability_grants SET needs_approval = $2 WHERE actor_id = $1 AND capability = 'answer.post'", [bot.actorId, needs]));
    await setApproval(true);
    try {
      const run = await openRun(true);
      const before = await count('SELECT 1 FROM app.approvals');
      const res = await call(run, 'answer.post', { body: 'An answer that would wait.', citations: [] });
      expect(res.answer).toMatchObject({ ok: true, rehearsal: true, done: false });
      expect(await count('SELECT 1 FROM app.approvals')).toBe(before);
      expect(await count("SELECT 1 FROM app.messages WHERE body = 'An answer that would wait.'")).toBe(0);
      const line = await world.system(async (tx) => (await tx.query<{ capability: string; would_wait: boolean }>('SELECT capability, would_wait FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).rows[0]);
      expect(line).toEqual({ capability: 'answer.post', would_wait: true });
    } finally {
      await setApproval(false);
    }
  });

  it('the same write on a normal run really happens', async () => {
    const run = await openRun(false);
    const res = await call(run, 'messages.post', { channelId: devChannelId, body: 'a real message' });
    expect(res.isError, JSON.stringify(res.answer)).toBe(false);
    expect(res.answer).not.toHaveProperty('rehearsal');
    expect(await count("SELECT 1 FROM app.messages WHERE body = 'a real message'")).toBe(1);
    expect(await count('SELECT 1 FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).toBe(0);
  });

  it('nothing a caller sends switches a run into or out of a rehearsal: an argument named rehearsal changes nothing', async () => {
    const normal = await openRun(false);
    const res = await call(normal, 'messages.post', { channelId: devChannelId, body: 'still real', rehearsal: true });
    // the tool's input is strict, so the stray argument is refused by validation; either way the call was not "held back" and no line was kept
    expect(res.answer).not.toHaveProperty('rehearsal');
    expect(await count('SELECT 1 FROM app.rehearsal_intercepts WHERE run_id = $1', [normal.runId])).toBe(0);
    const held = await openRun(true);
    const res2 = await call(held, 'messages.post', { channelId: devChannelId, body: 'still held', rehearsal: false });
    expect(res2.answer).toMatchObject({ rehearsal: true, done: false });
    expect(await count("SELECT 1 FROM app.messages WHERE body = 'still held'")).toBe(0);
  });

  it('only a conversation run can be a rehearsal (the table refuses any other)', async () => {
    await expect(openRun(true, 'webhook')).rejects.toThrow();
  });
});

describe('app.rehearsal_intercept_append', () => {
  it('refuses a run that is not a live rehearsal, so a normal run cannot write a "not done" line', async () => {
    const normal = await openRun(false);
    const hash = createHash('sha256').update(normal.token, 'utf8').digest();
    const appPool = createAppPool(world.server.db.appUrl);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const service = createRunService({ pool: appPool, systemPool, registry: new CapabilityRegistry(), broker: new CapabilityBroker({ registry: new CapabilityRegistry(), grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
      const handle = await service.resolve(hash);
      expect(handle).not.toBeNull();
      await expect(service.asBot(handle!, (tx) => service.logIntercept(tx, { capability: 'messages.post', target: null, wouldWait: false }))).rejects.toThrow(/live rehearsal/);
    } finally {
      await appPool.end();
      await systemPool.end();
    }
  });

  it('keeps at most 200 lines a run but still answers positions', async () => {
    const run = await openRun(true);
    const appPool = createAppPool(world.server.db.appUrl);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const service = createRunService({ pool: appPool, systemPool, registry: new CapabilityRegistry(), broker: new CapabilityBroker({ registry: new CapabilityRegistry(), grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
      const handle = await service.resolve(createHash('sha256').update(run.token, 'utf8').digest());
      for (let i = 0; i < 202; i += 1) {
        await service.asBot(handle!, (tx) => service.logIntercept(tx, { capability: 'messages.post', target: `t${i}`, wouldWait: false }));
      }
    } finally {
      await appPool.end();
      await systemPool.end();
    }
    expect(await count('SELECT 1 FROM app.rehearsal_intercepts WHERE run_id = $1', [run.runId])).toBe(200);
  });
});
