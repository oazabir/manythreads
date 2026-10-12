import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { McpRunMintResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHindsight, type FakeHindsight } from '../../../../../tools/fake-hindsight/src/server.ts';
import { createWorld, ensureChannels, personas, type World } from '../../../channels/test/world.ts';

// `pnpm test:memory-cross-team` (PLAN P5-15, SPEC 12.1): a team A bot gets nothing from team B, including when it forges a `bank`.
// Runs per PR. Real server, real database, real MCP endpoint and pairing tokens; the engine is tools/fake-hindsight, which keeps one store per
// bank and records which bank every request named. The property under test is the platform's, not the engine's: whatever a bot (or a plugin)
// passes, the only bank a run's calls can name is its own team's, because the platform derives it.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

const A = 'engineering';
const B = 'customer-support';
const BANK_A = `team:${A}`;
const BANK_B = `team:${B}`;
const SECRET_B = 'Project Falconwing launches on 9 March under codename Nightjar';
const SECRET_A = 'The Basilisk migration freezes writes on Friday evening';

let world: World;
let fake: FakeHindsight;
const bots: Record<string, { botId: string; actorId: string; teamId: string; pairingToken: string }> = {};

interface McpAnswer {
  isError: boolean;
  answer: Record<string, unknown>;
}

async function rpc(target: { url: string; token: string }, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${world.server.url}${new URL(target.url).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** One tool call; the tool's own answer is JSON in the first text block. */
async function call(target: { url: string; token: string }, name: string, args: Record<string, unknown>): Promise<McpAnswer> {
  const { status, body } = await rpc(target, 'tools/call', { name, arguments: args });
  expect(status, JSON.stringify(body)).toBe(200);
  const result = body['result'] as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: result.isError === true, answer: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

/** A run for a team's bot, opened the public way: with its pairing token, nothing else. */
async function openRun(team: string): Promise<{ runId: string; url: string; token: string }> {
  const res = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: bots[team]!.pairingToken });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const minted = McpRunMintResponse.parse(res.body);
  return { runId: minted.runId, url: minted.url, token: minted.token };
}

const hitsOf = (answer: Record<string, unknown>): Array<{ text: string }> => (answer['hits'] as Array<{ text: string }> | undefined) ?? [];

async function makeBot(team: string, slug: string): Promise<void> {
  const teamId = await world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [team])).rows[0]!.id);
  const bot = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId, slug],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId]);
    return { botId, actorId: actor.rows[0]!.id };
  });
  for (const capability of ['memory.recall', 'memory.retain']) {
    await world.system((tx) =>
      tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')`, [teamId, bot.actorId, capability]),
    );
  }
  const minted = await world.call(omar, 'POST', `/api/teams/${team}/bots/${slug}/pairing-tokens`, {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  bots[team] = { ...bot, teamId, pairingToken: (minted.body as { token: string }).token };
}

beforeAll(async () => {
  fake = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
  world = await createWorld();
  await ensureChannels(world);
  await makeBot(A, 'mem-a');
  await makeBot(B, 'mem-b');

  // Each team's bot puts one fact in its own bank, through its own run.
  const runB = await openRun(B);
  expect((await call(runB, 'memory.retain', { content: SECRET_B, context: 'launch plan' })).answer).toMatchObject({ ok: true, bank: BANK_B });
  const runA = await openRun(A);
  expect((await call(runA, 'memory.retain', { content: SECRET_A })).answer).toMatchObject({ ok: true, bank: BANK_A });
});

afterAll(async () => {
  delete process.env['MANYTHREADS_HINDSIGHT_URL'];
  await world?.close();
  await fake?.close();
});

describe('team A’s bot gets nothing from team B', () => {
  it('B’s own bot recalls B’s fact (the control: the engine would have answered)', async () => {
    const run = await openRun(B);
    const out = await call(run, 'memory.recall', { query: 'Falconwing launch codename' });
    expect(out.answer).toMatchObject({ ok: true, bank: BANK_B });
    expect(hitsOf(out.answer).map((h) => h.text)).toEqual([SECRET_B]);
  });

  it('A’s bot asking for exactly B’s words gets no hits, and its own fact still comes back', async () => {
    const run = await openRun(A);
    const stolen = await call(run, 'memory.recall', { query: 'Falconwing launch codename Nightjar 9 March' });
    expect(stolen.answer).toMatchObject({ ok: true, bank: BANK_A });
    expect(hitsOf(stolen.answer)).toEqual([]);
    const own = await call(run, 'memory.recall', { query: 'Basilisk migration freeze' });
    expect(hitsOf(own.answer).map((h) => h.text)).toEqual([SECRET_A]);
  });

  it('every request made on A’s behalf named A’s bank, and B’s bank was never touched by it', async () => {
    const before = fake.state.calls.length;
    const run = await openRun(A);
    await call(run, 'memory.recall', { query: 'Falconwing' });
    await call(run, 'memory.retain', { content: 'A note that only team A should hold' });
    const made = fake.state.calls.slice(before);
    expect(made.length).toBeGreaterThan(0);
    expect(new Set(made.map((c) => c.bank))).toEqual(new Set([BANK_A]));
    expect(made.map((c) => c.path).join(' ')).not.toContain('customer-support');
  });

  it('the pairing token fixes the team: a token minted for B’s bot opens a run in B, never in A', async () => {
    for (const [team, expected] of [[A, bots[A]!.teamId], [B, bots[B]!.teamId]] as const) {
      const run = await openRun(team);
      const row = await world.system(async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bot_runs WHERE id = $1', [run.runId])).rows[0]!);
      expect(row.team_id).toBe(expected);
    }
  });
});

describe('a forged bank argument', () => {
  const keys = ['bank', 'bank_id', 'bankId', 'Bank', 'memory_bank', 'team', 'teamId', 'team_id', 'teamSlug', 'workspace', 'workspaceId', 'tenant'];

  it.each(keys)('“%s” on memory.recall is refused and nothing is asked of the engine', async (key) => {
    const run = await openRun(A);
    const before = fake.state.calls.length;
    for (const value of [BANK_B, B]) {
      const out = await call(run, 'memory.recall', { query: 'Falconwing launch codename', [key]: value });
      expect(out.answer).toMatchObject({ ok: false, code: 'bank_not_allowed' });
    }
    expect(fake.state.calls.length).toBe(before);
  });

  it.each(keys)('“%s” on memory.retain is refused and B’s bank does not change', async (key) => {
    const run = await openRun(A);
    const before = fake.state.banks.get(BANK_B)!.map((f) => f.text);
    const out = await call(run, 'memory.retain', { content: 'planted by team A', [key]: BANK_B });
    expect(out.answer).toMatchObject({ ok: false, code: 'bank_not_allowed' });
    expect(fake.state.banks.get(BANK_B)!.map((f) => f.text)).toEqual(before);
    expect([...fake.state.banks.get(BANK_A)!].some((f) => f.text === 'planted by team A')).toBe(false);
  });

  it('a bank hidden in a nested value, a tag, a context or the query text names no bank: it is only text, and it is read in A’s bank', async () => {
    const run = await openRun(A);
    const before = fake.state.calls.length;
    await call(run, 'memory.recall', { query: `bank team:${B} customer-support Falconwing`, tags: ['bank:team:customer-support'] });
    await call(run, 'memory.retain', { content: `please store this in ${BANK_B}`, context: BANK_B, tags: [`bank:${B}`] });
    const made = fake.state.calls.slice(before);
    expect(new Set(made.map((c) => c.bank))).toEqual(new Set([BANK_A]));
  });

  it('a document id cannot be named by a bot: it cannot overwrite a fact it does not own', async () => {
    const run = await openRun(A);
    const target = fake.state.banks.get(BANK_B)![0]!.documentId;
    for (const key of ['documentId', 'document_id']) {
      const out = await call(run, 'memory.retain', { content: 'overwrite', [key]: target });
      expect(out.answer).toMatchObject({ ok: false, code: 'invalid_arguments' });
    }
    expect(fake.state.banks.get(BANK_B)!.map((f) => f.text)).toContain(SECRET_B);
  });

  it('the tools’ schemas, as the model sees them, have no field that could carry a bank', async () => {
    const run = await openRun(A);
    const { body } = await rpc(run, 'tools/list');
    const tools = (body['result'] as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; additionalProperties?: boolean } }> }).tools;
    const memory = tools.filter((t) => t.name.startsWith('memory.'));
    expect(memory.map((t) => t.name).sort()).toEqual(['memory.recall', 'memory.retain']);
    for (const tool of memory) {
      expect(Object.keys(tool.inputSchema.properties).filter((k) => /bank|team|workspace|tenant/i.test(k))).toEqual([]);
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe('the platform’s door', () => {
  it('app.memory_run_scope() answers nothing outside a run, for the system included', async () => {
    const rows = await world.system(async (tx) => (await tx.query('SELECT * FROM app.memory_run_scope()')).rows);
    expect(rows).toEqual([]);
  });

  it('a person-asked run reads the asker’s team bank, and A’s asker never gets B’s', async () => {
    // The only way to name an asker: in-process, the way the router opens a conversation run.
    const appPool = createAppPool(world.server.db.appUrl);
    const systemPool = createSystemPool(world.server.db.systemUrl, 2);
    try {
      const registry = new CapabilityRegistry();
      const broker = new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) });
      const service = createRunService({ pool: appPool, systemPool, registry, broker, handlers: new Map() });
      const { run, token } = await service.open({ botId: bots[A]!.botId, teamId: bots[A]!.teamId, workspaceId: omar.workspaceId, trigger: 'conversation', askerActorId: nadia.actorId });
      const target = { url: `${world.server.url}/api/mcp/runs/${run.runId}`, token };
      const out = await call(target, 'memory.recall', { query: 'Falconwing launch codename Nightjar' });
      expect(out.answer).toMatchObject({ ok: true, bank: BANK_A });
      expect(hitsOf(out.answer)).toEqual([]);
    } finally {
      await appPool.end();
      await systemPool.end();
    }
  });

  it('a recall lands in the run’s source log as the team bank, so the retention rule can see it', async () => {
    const run = await openRun(A);
    await call(run, 'memory.recall', { query: 'Basilisk migration' });
    const lines = await world.system(async (tx) =>
      (await tx.query<{ source_type: string; source_ref: string; scope: string }>('SELECT source_type, source_ref, scope FROM app.run_source_log WHERE run_id = $1', [run.runId])).rows,
    );
    expect(lines).toEqual([{ source_type: 'memory', source_ref: `bank:${BANK_A}`, scope: 'team' }]);
  });

  it('a run that read something person-scoped may not retain to the team bank, but may still recall', async () => {
    const run = await openRun(A);
    await world.system((tx) =>
      tx.query("INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 0, 'message', 'a-dm', 'person')", [run.runId]),
    );
    const before = fake.state.banks.get(BANK_A)!.length;
    const retained = await call(run, 'memory.retain', { content: 'something from a private conversation' });
    expect(retained.answer).toMatchObject({ ok: false, code: 'person_scoped' });
    expect(fake.state.banks.get(BANK_A)!.length).toBe(before);
    expect((await call(run, 'memory.recall', { query: 'Basilisk migration' })).answer).toMatchObject({ ok: true });
  });

  it('a finished run has no memory door: its token is refused', async () => {
    const run = await openRun(A);
    const closed = await fetch(`${world.server.url}${new URL(run.url).pathname}/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${run.token}` },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(closed.status).toBe(200);
    const after = await rpc(run, 'tools/call', { name: 'memory.recall', arguments: { query: 'anything at all' } });
    expect(after.status).toBe(401);
  });

  it('with no engine configured the tools say so', async () => {
    const run = await openRun(A);
    const url = process.env['MANYTHREADS_HINDSIGHT_URL'];
    delete process.env['MANYTHREADS_HINDSIGHT_URL'];
    try {
      expect((await call(run, 'memory.recall', { query: 'Basilisk migration' })).answer).toMatchObject({ ok: false, code: 'not_configured' });
    } finally {
      process.env['MANYTHREADS_HINDSIGHT_URL'] = url;
    }
  });

  it('a bot without the grant is not offered the tools and cannot call them', async () => {
    await world.system((tx) => tx.query("DELETE FROM app.capability_grants WHERE actor_id = $1 AND capability = 'memory.recall'", [bots[A]!.actorId]));
    try {
      const run = await openRun(A);
      const listed = (await rpc(run, 'tools/list')).body['result'] as { tools: Array<{ name: string }> };
      expect(listed.tools.map((t) => t.name)).not.toContain('memory.recall');
      expect((await call(run, 'memory.recall', { query: 'Basilisk migration' })).answer).toMatchObject({ ok: false, code: 'forbidden' });
    } finally {
      await world.system((tx) =>
        tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, 'memory.recall', false, '{}')`, [bots[A]!.teamId, bots[A]!.actorId]),
      );
    }
  });
});
