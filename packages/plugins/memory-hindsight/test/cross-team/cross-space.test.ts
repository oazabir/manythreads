import { CapabilityBroker, CapabilityRegistry, createAppPool, createDbGrantSource, createRunService, createSystemPool } from '@manythreads/kernel';
import { McpRunMintResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHindsight, type FakeHindsight } from '../../../../../tools/fake-hindsight/src/server.ts';
import { createWorld, ensureChannels, personas, type World } from '../../../channels/test/world.ts';

// `pnpm test:memory-cross-team`, the cross-SPACE half (P20-05, P20-08, D10): a person's own memory bank is read and written by a bot only inside that
// person's private conversation with it, only when the person allowed that bot, and never by anyone else's run, a team channel run, or a forged argument.
// Real server, database, MCP endpoint and run service; the engine is tools/fake-hindsight, which records which bank every request named.

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

const TEAM = 'engineering';
const NADIA_SECRET = 'Nadia keeps her passport in the green folder';
const TEAM_FACT = 'The Basilisk migration freezes writes on Friday evening';

let world: World;
let fake: FakeHindsight;
let bank = { team: '', nadia: '', rafi: '' };
let bot: { botId: string; actorId: string; teamId: string; pairingToken: string };

interface Target {
  runId: string;
  url: string;
  token: string;
}

async function call(target: Target, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; answer: Record<string, unknown> }> {
  const res = await fetch(`${world.server.url}${new URL(target.url).pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const result = ((await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } }).result;
  return { isError: result.isError === true, answer: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

/** A run of the team's bot with an asking person, opened the way the router opens one. */
async function openAs(asker: { actorId: string } | null, trigger: string, channelId?: string): Promise<Target> {
  const appPool = createAppPool(world.server.db.appUrl);
  const systemPool = createSystemPool(world.server.db.systemUrl, 2);
  try {
    const registry = new CapabilityRegistry();
    const service = createRunService({ pool: appPool, systemPool, registry, broker: new CapabilityBroker({ registry, grants: createDbGrantSource({ pool: systemPool }) }), handlers: new Map() });
    const { run, token } = await service.open({
      botId: bot.botId,
      teamId: bot.teamId,
      workspaceId: omar.workspaceId,
      trigger,
      ...(asker ? { askerActorId: asker.actorId } : {}),
      ...(channelId ? { channelId } : {}),
    });
    return { runId: run.runId, url: `${world.server.url}/api/mcp/runs/${run.runId}`, token };
  } finally {
    await appPool.end();
    await systemPool.end();
  }
}

const facts = (answer: Record<string, unknown>): Array<{ text: string; space?: string }> => (answer['data'] as { facts?: Array<{ text: string; space?: string }> } | undefined)?.facts ?? [];
const consent = (person: typeof nadia, allowed: boolean) => world.call(person, 'PUT', `/api/me/bot-consents/${bot.botId}`, { allowed });

beforeAll(async () => {
  fake = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = fake.url;
  world = await createWorld();
  await ensureChannels(world);
  const ws = await world.system(async (tx) => (await tx.query<{ slug: string }>('SELECT slug FROM app.workspaces LIMIT 1')).rows[0]!.slug);
  bank = { team: `team:${ws}:${TEAM}`, nadia: `person:${ws}:${nadia.personId}`, rafi: `person:${ws}:${rafi.personId}` };
  const teamId = await world.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [TEAM])).rows[0]!.id);
  const made = await world.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'space-bot', 'Space bot', 'Remembers', 'agent', 'rules', 'team', repeat('d', 64), 'active') RETURNING id`,
      [omar.workspaceId, teamId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id", [omar.workspaceId, botId]);
    for (const capability of ['memory.recall', 'memory.retain', 'personal.read']) {
      await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability, needs_approval, constraints) VALUES ($1, $2, $3, false, '{}')`, [teamId, actor.rows[0]!.id, capability]);
    }
    return { botId, actorId: actor.rows[0]!.id };
  });
  const minted = await world.call(omar, 'POST', `/api/teams/${TEAM}/bots/space-bot/pairing-tokens`, {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  bot = { ...made, teamId, pairingToken: (minted.body as { token: string }).token };
  // the team's own fact, through a public-channel run
  const open = await world.call(null, 'POST', '/api/mcp/runs', { pairingToken: bot.pairingToken });
  const minted2 = McpRunMintResponse.parse(open.body);
  expect((await call({ runId: minted2.runId, url: minted2.url, token: minted2.token }, 'memory.retain', { content: TEAM_FACT })).answer).toMatchObject({ ok: true, bank: bank.team });
});

afterAll(async () => {
  delete process.env['MANYTHREADS_HINDSIGHT_URL'];
  await world?.close();
  await fake?.close();
});

describe('a person\'s own memory bank', () => {
  it('is not used until the person allows the bot: a private conversation still reads and writes the team side only, as before', async () => {
    const run = await openAs(nadia, 'conversation');
    const before = fake.state.calls.length;
    const recalled = await call(run, 'memory.recall', { query: 'passport green folder' });
    expect(recalled.answer).toMatchObject({ ok: true, bank: bank.team });
    expect(recalled.answer).not.toHaveProperty('personBank');
    // a private conversation may not add to the team's memory
    expect((await call(run, 'memory.retain', { content: NADIA_SECRET })).answer).toMatchObject({ ok: false, code: 'retain_refused' });
    expect(new Set(fake.state.calls.slice(before).map((c) => c.bank))).toEqual(new Set([bank.team]));
    expect(fake.state.banks.has(bank.nadia)).toBe(false);
  });

  it('takes what is said in the conversation once the person allows the bot, and nothing reaches the team\'s bank', async () => {
    expect((await consent(nadia, true)).status).toBe(200);
    const run = await openAs(nadia, 'conversation');
    const teamBefore = fake.state.banks.get(bank.team)!.map((f) => f.text);
    const out = await call(run, 'memory.retain', { content: NADIA_SECRET });
    expect(out.answer).toMatchObject({ ok: true, bank: bank.nadia });
    expect(fake.state.banks.get(bank.nadia)!.map((f) => f.text)).toEqual([NADIA_SECRET]);
    expect(fake.state.banks.get(bank.team)!.map((f) => f.text)).toEqual(teamBefore);
    // the retain log is the team's record: it never names the person's bank
    const logged = await world.system(async (tx) => (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.memory_retain_log WHERE bank LIKE 'person:%'`)).rows[0]!.n);
    expect(logged).toBe('0');
  });

  it('is read beside the team\'s, every fact tagged with the space it came from, and the run files a person-scoped source', async () => {
    const run = await openAs(nadia, 'conversation');
    const out = await call(run, 'memory.recall', { query: 'passport Basilisk migration green folder freezes' });
    expect(out.answer).toMatchObject({ ok: true, bank: bank.team, personBank: bank.nadia });
    const spaces = Object.fromEntries(facts(out.answer).map((f) => [f.text, f.space]));
    expect(spaces[NADIA_SECRET]).toBe(`person:${nadia.personId}`);
    expect(spaces[TEAM_FACT]).toMatch(/^team:/);
    const lines = await world.system(async (tx) => (await tx.query<{ source_ref: string; scope: string }>('SELECT source_ref, scope FROM app.run_source_log WHERE run_id = $1 ORDER BY seq', [run.runId])).rows);
    expect(lines).toEqual(expect.arrayContaining([{ source_ref: `bank:${bank.nadia}`, scope: 'person' }]));
  });

  it('is never read by another person\'s run of the same bot, nor by a team channel run of Nadia\'s, nor a run with no asker', async () => {
    const others = [
      await openAs(rafi, 'conversation'),
      await openAs(nadia, 'mention', await world.channelId(TEAM, 'dev')),
      await openAs(null, 'webhook'),
    ];
    for (const run of others) {
      const before = fake.state.calls.length;
      const out = await call(run, 'memory.recall', { query: 'passport green folder' });
      expect(out.answer, run.runId).toMatchObject({ ok: true, bank: bank.team });
      expect(out.answer).not.toHaveProperty('personBank');
      expect(JSON.stringify(out.answer)).not.toContain('passport');
      expect(new Set(fake.state.calls.slice(before).map((c) => c.bank)).has(bank.nadia)).toBe(false);
    }
  });

  it('cannot be named by a bot: a forged bank key is refused, a forged space key is dropped by the gateway, and the bank is untouched either way', async () => {
    const run = await openAs(rafi, 'conversation');
    const before = fake.state.calls.length;
    for (const key of ['bank', 'bankId', 'team', 'workspace']) {
      expect((await call(run, 'memory.recall', { query: 'passport', [key]: bank.nadia })).answer, key).toMatchObject({ ok: false, code: 'bank_not_allowed' });
      expect((await call(run, 'memory.retain', { content: 'planted', [key]: bank.nadia })).answer, key).toMatchObject({ ok: false, code: 'bank_not_allowed' });
    }
    // keys that would name a person or a space never reach the tool: the gateway removes them, and the run's own spaces apply
    for (const key of ['person', 'personId', 'ownerPersonId', 'space', 'spaces']) {
      const out = await call(run, 'memory.recall', { query: 'passport', [key]: key === 'spaces' ? [bank.nadia] : bank.nadia });
      if (out.answer['ok'] === true) expect(JSON.stringify(out.answer), key).not.toContain('passport');
    }
    expect(fake.state.calls.slice(before).filter((c) => c.bank === bank.nadia)).toEqual([]);
    expect(fake.state.banks.get(bank.nadia)!.map((f) => f.text)).toEqual([NADIA_SECRET]);
  });

  it('is closed again on the next call when the person withdraws their yes', async () => {
    expect((await consent(nadia, false)).status).toBe(200);
    const run = await openAs(nadia, 'conversation');
    const before = fake.state.calls.length;
    const out = await call(run, 'memory.recall', { query: 'passport green folder' });
    expect(out.answer).not.toHaveProperty('personBank');
    expect(JSON.stringify(out.answer)).not.toContain('passport');
    expect(fake.state.calls.slice(before).some((c) => c.bank === bank.nadia)).toBe(false);
  });
});
