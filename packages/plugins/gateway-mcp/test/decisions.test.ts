import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { McpRunMintResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// What the tool door and the data check decided is kept, one content-blind line each, so the Workshop can replay it later (PLAN P7-07): the tool, where it aimed, the
// broker's outcome and its reason, and for the data check the names of the rules that fired, never what was found or written.

const { omar, nadia } = personas;
const KEY = `AKIA${'IOSFODNN7EXAMPLE'}`;
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


const lines = (runId: string) =>
  world.system(async (tx) =>
    (await tx.query<{ seq: number; kind: string; subject: string; outcome: string; target: string | null; detail: Record<string, unknown> }>('SELECT seq, kind, subject, outcome, target, detail FROM app.run_decisions WHERE run_id = $1 ORDER BY seq', [runId])).rows,
  );

describe('decisions are kept for the replay', () => {
  it('keeps what the tool door decided: allowed, held for a person, refused', async () => {
    const run = await openRun(false);
    await call(run, 'messages.search', { query: 'anything at all' });
    await call(run, 'tasks.claim', { taskId: '00000000-0000-7000-8000-000000000001' });
    await call(run, 'pages.write', { mode: 'create', path: 'pages/decisions.md', content: 'a page' });
    const kept = (await lines(run.runId)).filter((l) => l.kind === 'tool');
    expect(kept.map((l) => `${l.subject}:${l.outcome}`)).toEqual(['messages.search:allowed', 'tasks.claim:denied', 'pages.write:needs_approval']);
    expect(kept[2]!.detail).toMatchObject({ path: 'pages/decisions.md' });
    expect(typeof kept[1]!.detail['reason']).toBe('string');
  });

  it('keeps no content: not the text of a message, not a page body', async () => {
    const run = await openRun(false);
    await call(run, 'messages.post', { channelId: devChannelId, body: 'a private sentence nobody may copy' });
    await call(run, 'pages.write', { mode: 'create', path: 'pages/private.md', content: 'page body nobody may copy' });
    const text = JSON.stringify(await lines(run.runId));
    expect(text).not.toContain('private sentence');
    expect(text).not.toContain('page body');
  });

  it('keeps a place only if it is shaped like one: a secret-looking path or id the model wrote is not stored', async () => {
    const run = await openRun(false);
    const SECRET = 'sk-live-abcdefghijklmnopqrstuvwx1234';
    await call(run, 'pages.write', { mode: 'create', path: `pages/${SECRET}.md`, content: 'a page' });
    await call(run, 'pages.write', { mode: 'create', path: `a sentence that is not a path ${SECRET}`, content: 'a page' });
    await call(run, 'tasks.claim', { taskId: SECRET });
    await call(run, 'pages.write', { mode: 'create', path: 'pages/fine-name.md', content: 'a page' });
    const kept = (await lines(run.runId)).filter((l) => l.kind === 'tool');
    expect(JSON.stringify(kept)).not.toContain('abcdefghijklmnopqrstuvwx1234');
    expect(JSON.stringify(kept)).not.toContain('a sentence');
    const pagesLines = kept.filter((l) => l.subject === 'pages.write');
    // the two odd ones are marked as kept in part (the replay then never judges them) with no place at all
    expect(pagesLines.slice(0, 2).map((l) => [l.detail['path'] ?? null, l.detail['paths'] ?? null, l.detail['truncated'] ?? null])).toEqual([
      [null, null, true],
      [null, null, true],
    ]);
    // an ordinary path is kept as it is, and is not marked
    expect(pagesLines[2]!.detail).toMatchObject({ path: 'pages/fine-name.md' });
    expect(pagesLines[2]!.detail['truncated']).toBeUndefined();
    expect(pagesLines[2]!.target).toBe('pages/fine-name.md');
    expect(kept.find((l) => l.subject === 'tasks.claim')!.target).toBeNull();
  });

  it('keeps the data check of a call that carried a secret by the names of its rules, never the secret', async () => {
    const run = await openRun(false);
    await call(run, 'messages.post', { channelId: devChannelId, body: `the key is ${KEY}` });
    const kept = await lines(run.runId);
    const guard = kept.find((l) => l.kind === 'guard');
    expect(guard).toMatchObject({ subject: 'mcp' });
    expect(['redact', 'block', 'require_approval']).toContain(guard!.outcome);
    expect(JSON.stringify(kept)).not.toContain(KEY);
    expect(JSON.stringify(kept)).not.toContain('IOSFODNN7EXAMPLE');
  });

  it('is written for the run only: another run has its own lines, and a rehearsal keeps them too', async () => {
    const a = await openRun(false);
    const b = await openRun(true);
    await call(a, 'messages.search', { query: 'one' });
    await call(b, 'messages.search', { query: 'two' });
    expect((await lines(a.runId)).map((l) => l.seq)).toEqual([0]);
    expect((await lines(b.runId)).map((l) => l.seq)).toEqual([0]);
  });
});
