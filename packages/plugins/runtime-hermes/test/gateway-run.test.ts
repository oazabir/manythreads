/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putSecret, withSystem } from '@manythreads/kernel';
import type { HermesProfilesProvider, JobInfo, PluginContext } from '@manythreads/sdk';
import { ListMessagesResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway, type FakeHermesRun, type FakeRunStep } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { startFakeHindsight, type FakeHindsight } from '../../../../tools/fake-hindsight/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';
import { FAILURE_NOTICE } from '../src/failure-notice.ts';
import { settleEarlierAttempt } from '../src/run-job.ts';

// A bot that is a profile on a Hermes gateway (mode A: a gateway of the customer's own; mode B: the team's pod), end to end: a mention opens a run,
// the run is POSTed to the gateway with the run id as its idempotency key and the thread as its session, and the profile's model calls
// manythreads' tools at the bot's STABLE endpoint (`/api/mcp/bots/<botId>`) with the bot's one token — which is attributed to the bot's open run.
// The gateway is tools/fake-hermes-gateway; its script plays the profile's model, making real tool calls over real HTTP.

const { omar, nadia } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let gw: FakeHermesGateway;
let hindsight: FakeHindsight;
let scratch = '';
let channelId = '';
const savedEnv = { allowed: process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'], hindsight: process.env['MANYTHREADS_HINDSIGHT_URL'], dir: process.env['MANYTHREADS_RUNTIME_DIR'], concurrency: process.env['MANYTHREADS_RUN_CONCURRENCY'] };
const API_KEY = 'gateway-key-0123456789abcdef';

interface LoadedBot {
  botId: string;
  slug: string;
  actorId: string;
  token: string;
}

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const botMd = (name: string, placement: string[], native = 'messages.post, memory.recall, memory.retain'): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    'role: Answers through a Hermes gateway',
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    `  native: [${native}]`,
    'placement:',
    ...placement,
    '---',
    '',
    `# ${name}`,
    '',
    'Soul text.',
    '',
  ].join('\n');

/** Commit a BOT.md, wait for the loader, mint the bot's token, and tell the fake gateway where this profile's MCP server is. */
async function loadBot(slug: string, placement: string[], profile?: string): Promise<LoadedBot> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: botMd(slug, placement) }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  const botId = await until(
    () => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = $1 AND status = 'active'`, [slug])).rows[0]?.id ?? null),
    20_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null), 5_000, `the actor of ${slug}`);
  const minted = await w.call<{ token: string }>(omar, 'POST', `/api/teams/engineering/bots/${slug}/pairing-tokens`, {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const token = minted.body.token;
  if (profile !== undefined) gw.setProfile(profile, { apiKey: API_KEY, mcp: { url: `${w.server.url}/api/mcp/bots/${botId}`, token } });
  return { botId, slug, actorId, token };
}

const post = async (body: string): Promise<string> => {
  const res = await w.call(nadia, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};

const messagesBy = async (rootId: string, authorId: string): Promise<{ id: string; body: string; meta?: unknown }[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items.filter((m) => m.authorId === authorId);
};

const runsOf = (botId: string) =>
  w.system(async (tx) => (await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null }>(`SELECT id, status, trigger_type, asker_id FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id`, [botId])).rows);

const closedRun = (botId: string) =>
  until(async () => {
    const rows = await runsOf(botId);
    const last = rows[rows.length - 1];
    return last && last.status !== 'running' ? last : null;
  }, 30_000, 'the run to close');

/** A JSON-RPC call at a bot's stable endpoint. */
async function rpc(botId: string, token: string | null, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${w.server.url}/api/mcp/bots/${botId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const toolAnswer = (body: any): { isError: boolean; answer: any } => ({ isError: body.result?.isError === true, answer: JSON.parse(body.result.content[0].text) });

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-gateway-'));
  hindsight = await startFakeHindsight();
  process.env['MANYTHREADS_HINDSIGHT_URL'] = hindsight.url;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_RUN_CONCURRENCY'] = '4';
  // the fake gateway listens on loopback, which the outbound guard refuses unless the operator lists it
  process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = '127.0.0.1';
  gw = await startFakeHermesGateway({ profiles: {} });
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`)).rows[0]?.id ?? '');
  expect(channelId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await w?.close();
  await gw?.close();
  await hindsight?.close();
  for (const [name, value] of [['MANYTHREADS_HERMES_ALLOWED_HOSTS', savedEnv.allowed], ['MANYTHREADS_HINDSIGHT_URL', savedEnv.hindsight], ['MANYTHREADS_RUNTIME_DIR', savedEnv.dir], ['MANYTHREADS_RUN_CONCURRENCY', savedEnv.concurrency]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('Hermes connections (the lead’s routes)', () => {
  let connectionId = '';

  it('a lead adds a gateway; the key is never returned, and a member cannot see or change any of it', async () => {
    const created = await w.call<{ connection: Record<string, unknown> }>(omar, 'POST', '/api/teams/engineering/hermes/connections', { name: 'host', baseUrl: gw.url, apiKey: API_KEY });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    connectionId = created.body.connection['id'] as string;
    expect(created.body.connection).toMatchObject({ name: 'host', kind: 'external', baseUrl: gw.url, hasApiKey: true, status: 'unknown' });
    expect(JSON.stringify(created.body)).not.toContain(API_KEY);

    const listed = await w.call(omar, 'GET', '/api/teams/engineering/hermes/connections');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(API_KEY);
    expect((listed.body as { items: unknown[] }).items).toHaveLength(1);

    // the key is stored encrypted, not in the row
    const row = await w.system(async (tx) => (await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.hermes_connections WHERE id = $1', [connectionId])).rows[0]);
    expect(row?.secret_id).toBeTruthy();

    // a plain member of the team: no list, no create, no test, no delete
    expect((await w.call(nadia, 'GET', '/api/teams/engineering/hermes/connections')).status).toBe(403);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/hermes/connections', { name: 'mine', baseUrl: gw.url, apiKey: API_KEY })).status).toBe(403);
    expect((await w.call(nadia, 'POST', `/api/teams/engineering/hermes/connections/${connectionId}/test`, {})).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/teams/engineering/hermes/connections/${connectionId}`)).status).toBe(403);
    // a lead of another team sees nothing of this one
    expect((await w.call(omar, 'GET', '/api/teams/customer-support/hermes/connections')).status).toBe(200);
    expect(((await w.call(omar, 'GET', '/api/teams/customer-support/hermes/connections')).body as { items: unknown[] }).items).toHaveLength(0);
    expect((await w.call(omar, 'POST', `/api/teams/customer-support/hermes/connections/${connectionId}/test`, {})).status).toBe(404);
  });

  it('refuses the reserved name, an address with a credential in it, and a key that is too short', async () => {
    const bad = (body: unknown) => w.call(omar, 'POST', '/api/teams/engineering/hermes/connections', body);
    expect((await bad({ name: 'managed', baseUrl: gw.url, apiKey: API_KEY })).status).toBe(400);
    expect((await bad({ name: 'x1', baseUrl: 'http://user:pw@10.0.0.1:8642', apiKey: API_KEY })).status).toBe(400);
    expect((await bad({ name: 'x2', baseUrl: 'ftp://10.0.0.1', apiKey: API_KEY })).status).toBe(400);
    expect((await bad({ name: 'x3', baseUrl: gw.url, apiKey: 'short' })).status).toBe(400);
    expect((await bad({ name: 'host', baseUrl: gw.url, apiKey: API_KEY })).status).toBe(409);

    // with no allow list the addresses a lead may not point this server at are refused when saved (and again at every request)
    const listed = process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
    delete process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'];
    try {
      for (const url of ['http://169.254.169.254/latest', 'http://127.0.0.1:8642', 'http://localhost:8642', 'http://manythreads-postgres:5432', 'http://kubernetes.default.svc']) {
        const r = await bad({ name: 'evil', baseUrl: url, apiKey: API_KEY });
        expect(r.status, url).toBe(400);
      }
    } finally {
      process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = listed;
    }
  });

  it('tests the connection against the profile: reachable, a wrong key, a profile that is not there, a dead address', async () => {
    gw.setProfile('probe-profile', { apiKey: API_KEY });
    const ok = await w.call<Record<string, unknown>>(omar, 'POST', `/api/teams/engineering/hermes/connections/${connectionId}/test`, { profile: 'probe-profile' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, error: null, tools: null, manythreadsTools: null });
    const listed = await w.call<{ items: { status: string; lastCheckedAt: string | null }[] }>(omar, 'GET', '/api/teams/engineering/hermes/connections');
    expect(listed.body.items[0]).toMatchObject({ status: 'ok' });
    expect(listed.body.items[0]!.lastCheckedAt).not.toBeNull();

    const ghost = await w.call<{ ok: boolean; error: string }>(omar, 'POST', `/api/teams/engineering/hermes/connections/${connectionId}/test`, { profile: 'ghost' });
    expect(ghost.body).toMatchObject({ ok: false });
    expect(ghost.body.error).toContain('did not answer as a Hermes gateway for that profile');

    // a key change goes back to "unknown" until the next test, and a wrong key is named as such
    const rekeyed = await w.call<{ connection: { status: string } }>(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${connectionId}`, { apiKey: 'a-different-key-0123456789' });
    expect(rekeyed.status).toBe(200);
    expect(rekeyed.body.connection.status).toBe('unknown');
    const wrong = await w.call<{ ok: boolean; error: string }>(omar, 'POST', `/api/teams/engineering/hermes/connections/${connectionId}/test`, { profile: 'probe-profile' });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.error).toContain('refused the API key');
    expect(JSON.stringify(wrong.body)).not.toContain('a-different-key');

    // put the right key back, then point it at a dead address
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${connectionId}`, { apiKey: API_KEY })).status).toBe(200);
    const dead = await startFakeHermesGateway({ profiles: {} });
    const deadUrl = dead.url;
    await dead.close();
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${connectionId}`, { baseUrl: deadUrl })).status).toBe(200);
    const down = await w.call<{ ok: boolean; error: string }>(omar, 'POST', `/api/teams/engineering/hermes/connections/${connectionId}/test`, { profile: 'probe-profile' });
    expect(down.body.ok).toBe(false);
    expect(down.body.error).toContain('did not answer');
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${connectionId}`, { baseUrl: gw.url })).status).toBe(200);
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${connectionId}`, {})).status).toBe(400);
  });

  it('removes a connection and its secret, and writes the events that say so', async () => {
    const made = await w.call<{ connection: { id: string } }>(omar, 'POST', '/api/teams/engineering/hermes/connections', { name: 'scratch', baseUrl: gw.url, apiKey: API_KEY });
    const id = made.body.connection.id;
    const secret = await w.system(async (tx) => (await tx.query<{ secret_id: string }>('SELECT secret_id FROM app.hermes_connections WHERE id = $1', [id])).rows[0]!.secret_id);
    expect((await w.call(omar, 'DELETE', `/api/teams/engineering/hermes/connections/${id}`)).status).toBe(200);
    expect((await w.call(omar, 'DELETE', `/api/teams/engineering/hermes/connections/${id}`)).status).toBe(404);
    await until(async () => (await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.secrets WHERE id = $1', [secret])).rows.length)) === 0, 10_000, 'the secret to be removed');
    const types = await w.system(async (tx) => (await tx.query<{ type: string }>(`SELECT DISTINCT type FROM app.events WHERE type LIKE 'hermes.connection.%'`)).rows.map((r) => r.type));
    expect(types.sort()).toEqual(['hermes.connection.created', 'hermes.connection.deleted', 'hermes.connection.tested', 'hermes.connection.updated']);
  });
});

describe('mode A: a bot placed on the customer’s gateway', () => {
  let bot: LoadedBot;

  it('a mention runs on the gateway and the profile’s tool calls at the bot endpoint are attributed to the open run', async () => {
    bot = await loadBot('ext-bot', ['  gateway:', '    connection: host', '    profile: ext-bot'], 'ext-bot');
    let observed: { ok: boolean; status: number; body: any } | undefined;
    gw.setScript((run: FakeHermesRun): FakeRunStep[] => [
      { type: 'tool', name: 'terminal' },
      { type: 'mcp', tool: 'messages.post', args: { channelId, body: 'Posted by the profile through the bot endpoint.' }, onResult: (r) => (observed = r) },
      { type: 'finish', output: `final text for ${String(run.body['input']).slice(0, 12)}` },
    ]);

    const rootId = await post('@ext-bot what changed?');
    const run = await closedRun(bot.botId);
    expect(run).toMatchObject({ status: 'done', trigger_type: 'mention', asker_id: nadia.actorId });

    // The gateway got exactly one run: the run's id is the idempotency key, the thread is the session, and the profile's own key authorised it.
    expect(gw.runs.filter((r) => r.profile === 'ext-bot')).toHaveLength(1);
    const call = gw.calls.find((c) => c.profile === 'ext-bot' && c.method === 'POST' && c.path.endsWith('/v1/runs'))!;
    expect(call).toMatchObject({ authorized: true, idempotencyKey: run.id });
    expect(call.body).toEqual({ input: 'Nadia in #dev:\n\n@ext-bot what changed?', session_id: `${bot.botId}:${rootId}` });

    // The tool call came over HTTP with the bot's token and was posted as the bot, into the run's thread, stamped with THIS run's id.
    expect(observed?.ok, JSON.stringify(observed)).toBe(true);
    const posted = await messagesBy(rootId, bot.actorId);
    expect(posted.map((m) => m.body)).toEqual(['Posted by the profile through the bot endpoint.']);
    expect(await w.system(async (tx) => (await tx.query<{ run_id: string }>(`SELECT meta ->> 'runId' AS run_id FROM app.messages WHERE id = $1`, [posted[0]!.id])).rows[0]?.run_id)).toBe(run.id);
  });

  it('a profile that posts nothing itself has its final text posted as the reply', async () => {
    gw.setScript(() => [{ type: 'delta', text: 'The answer ' }, { type: 'finish', output: 'The answer is 42.' }]);
    const before = (await runsOf(bot.botId)).length;
    const rootId = await post('@ext-bot what is the answer?');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the reply');
    expect(reply.body).toBe('The answer is 42.');
    await until(async () => (await runsOf(bot.botId)).length === before + 1 && (await closedRun(bot.botId)).status === 'done', 15_000, 'the run to be done');
  });

  it('a gateway that is down says so in the thread, in the fixed words, and the run fails', async () => {
    const dead = await startFakeHermesGateway({ profiles: {} });
    const deadUrl = dead.url;
    await dead.close();
    const listed = await w.call<{ items: { id: string; name: string }[] }>(omar, 'GET', '/api/teams/engineering/hermes/connections');
    const id = listed.body.items.find((c) => c.name === 'host')!.id;
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${id}`, { baseUrl: deadUrl })).status).toBe(200);
    try {
      const rootId = await post('@ext-bot are you there?');
      const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 15_000, 'the failure notice').catch((e) => {
        console.log('DEBUG', JSON.stringify(w.server.logs.filter((l) => /runtime-hermes/.test(l)).slice(-8)), JSON.stringify(gw.calls.slice(-3)));
        throw e;
      });
      expect(notice.body).toBe(FAILURE_NOTICE.hermes_unreachable);
      expect(notice.body).not.toContain(deadUrl);
      expect(await closedRun(bot.botId)).toMatchObject({ status: 'failed' });
    } finally {
      expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${id}`, { baseUrl: gw.url })).status).toBe(200);
    }
  });

  it('a gateway that refuses the key fails the run without echoing it; the notice is the generic one', async () => {
    const listed = await w.call<{ items: { id: string; name: string }[] }>(omar, 'GET', '/api/teams/engineering/hermes/connections');
    const id = listed.body.items.find((c) => c.name === 'host')!.id;
    expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${id}`, { apiKey: 'not-the-gateway-key-0123' })).status).toBe(200);
    try {
      const rootId = await post('@ext-bot try again');
      const notice = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the failure notice');
      expect(notice.body).toBe(FAILURE_NOTICE.other);
    } finally {
      expect((await w.call(omar, 'PATCH', `/api/teams/engineering/hermes/connections/${id}`, { apiKey: API_KEY })).status).toBe(200);
    }
  });
});

describe('the bot’s stable MCP endpoint', () => {
  let bot: LoadedBot;
  let other: LoadedBot;

  it('lists and initialises with no run open, but a tool call says no conversation is waiting', async () => {
    bot = await loadBot('stable-bot', ['  gateway:', '    connection: host', '    profile: stable-bot'], 'stable-bot');
    other = await loadBot('other-bot', ['  gateway:', '    connection: host', '    profile: other-bot'], 'other-bot');
    const init = await rpc(bot.botId, bot.token, 'initialize', {});
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo).toBeTruthy();
    const list = await rpc(bot.botId, bot.token, 'tools/list');
    expect(list.status).toBe(200);
    expect((list.body.result.tools as { name: string }[]).map((t) => t.name)).toEqual(expect.arrayContaining(['messages.post', 'memory.recall', 'memory.retain']));
    const call = await rpc(bot.botId, bot.token, 'tools/call', { name: 'memory.recall', arguments: { query: 'anything' } });
    expect(call.status).toBe(200);
    const { isError, answer } = toolAnswer(call.body);
    expect(isError).toBe(true);
    expect(answer).toMatchObject({ ok: false, code: 'no_open_run' });
    expect(answer.message).toContain('No conversation is waiting for this bot');
  });

  it('answers the same 401 to no token, a wrong token, another bot’s token, and a revoked one', async () => {
    const wrong = await rpc(bot.botId, 'not-a-token-0123456789', 'tools/list');
    const none = await rpc(bot.botId, null, 'tools/list');
    const theirs = await rpc(bot.botId, other.token, 'tools/list');
    const wrongUrl = await rpc(other.botId, bot.token, 'tools/list');
    for (const r of [wrong, none, theirs, wrongUrl]) {
      expect(r.status).toBe(401);
    }
    expect(new Set([wrong, none, theirs, wrongUrl].map((r) => JSON.stringify(r.body))).size).toBe(1);

    // rotate: the old token stops working in the same step the new one starts
    const rotated = await w.call<{ token: string; revoked: number }>(omar, 'POST', '/api/teams/engineering/bots/other-bot/pairing-tokens/rotate', {});
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(201);
    expect(rotated.body.revoked).toBe(1);
    expect((await rpc(other.botId, other.token, 'tools/list')).status).toBe(401);
    expect((await rpc(other.botId, rotated.body.token, 'tools/list')).status).toBe(200);
    // …and a plain member cannot rotate
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/bots/other-bot/pairing-tokens/rotate', {})).status).toBe(403);
    // revoke ends it
    expect((await w.call(omar, 'DELETE', '/api/teams/engineering/bots/other-bot/pairing-tokens')).status).toBe(200);
    expect((await rpc(other.botId, rotated.body.token, 'tools/list')).status).toBe(401);
  });

  it('a gateway-mode bot recalls, in another thread, a fact it retained earlier (memory works through the bot endpoint)', async () => {
    const FACT = 'The Basilisk migration freezes writes on Friday evening';
    let retained: { ok: boolean; status: number; body: any } | undefined;
    let recalled: { ok: boolean; status: number; body: any } | undefined;
    gw.setScript((run: FakeHermesRun): FakeRunStep[] => {
      const input = String(run.body['input']);
      if (input.includes('REMEMBER')) {
        return [{ type: 'mcp', tool: 'memory.retain', args: { content: FACT, context: 'migration plan' }, onResult: (r) => (retained = r) }, { type: 'finish', output: 'Noted.' }];
      }
      return [{ type: 'mcp', tool: 'memory.recall', args: { query: 'Basilisk migration freezes writes' }, onResult: (r) => (recalled = r) }, { type: 'finish', output: 'Looked it up.' }];
    });

    const first = await post('@stable-bot REMEMBER the freeze window');
    await until(async () => (await messagesBy(first, bot.actorId))[0], 30_000, 'the first reply');
    expect(retained?.ok, JSON.stringify(retained)).toBe(true);

    // a different thread, a new run, a new Hermes session — the fact comes from the team’s memory, not from the session
    const second = await post('@stable-bot what is the freeze window?');
    await until(async () => (await messagesBy(second, bot.actorId))[0], 30_000, 'the second reply');
    expect(recalled?.ok, JSON.stringify(recalled)).toBe(true);
    const { answer } = toolAnswer(recalled!.body);
    const texts = ((answer.data as { facts?: { text: string }[] } | undefined)?.facts ?? []).map((f) => f.text);
    expect(texts).toContain(FACT);
    const sessions = gw.runs.filter((r) => r.profile === 'stable-bot').map((r) => (r.body as { session_id: string }).session_id);
    expect(sessions).toEqual([`${bot.botId}:${first}`, `${bot.botId}:${second}`]);
  });
});

describe('one open run per bot, several bots at once', () => {
  it('two messages to the same bot are served one after the other; different bots overlap', async () => {
    const a = await loadBot('serial-a', ['  gateway:', '    connection: host', '    profile: serial-a'], 'serial-a');
    const b = await loadBot('serial-b', ['  gateway:', '    connection: host', '    profile: serial-b'], 'serial-b');
    const live = new Map<string, number>();
    const peak = new Map<string, number>();
    let overall = 0;
    let overallPeak = 0;
    gw.setScript((run: FakeHermesRun): FakeRunStep[] => {
      const key = run.profile;
      live.set(key, (live.get(key) ?? 0) + 1);
      peak.set(key, Math.max(peak.get(key) ?? 0, live.get(key)!));
      overall += 1;
      overallPeak = Math.max(overallPeak, overall);
      return [
        { type: 'wait', ms: 1200 },
        {
          type: 'mcp',
          tool: 'messages.post',
          args: { channelId, body: `done ${String(run.body['input']).split('\n').pop()}` },
          onResult: () => {
            live.set(key, live.get(key)! - 1);
            overall -= 1;
          },
        },
        { type: 'finish', output: 'ok' },
      ];
    });
    const roots = [await post('@serial-a one'), await post('@serial-a two'), await post('@serial-b three')];
    await until(async () => (await messagesBy(roots[0]!, a.actorId)).length > 0 && (await messagesBy(roots[1]!, a.actorId)).length > 0 && (await messagesBy(roots[2]!, b.actorId)).length > 0, 60_000, 'all three replies');
    expect(peak.get('serial-a')).toBe(1);
    expect(peak.get('serial-b')).toBe(1);
    // serial-b ran while serial-a was busy: the queue is no longer one job at a time for the whole workspace
    expect(overallPeak).toBeGreaterThanOrEqual(2);
    // each message was answered by exactly one run, in the thread it came from (the bot endpoint attributed each call to the right open run)
    expect(await messagesBy(roots[0]!, a.actorId)).toHaveLength(1);
    expect((await messagesBy(roots[0]!, a.actorId))[0]!.body).toContain('one');
    expect((await messagesBy(roots[1]!, a.actorId))[0]!.body).toContain('two');
    const runs = await runsOf(a.botId);
    expect(runs.map((r) => r.status)).toEqual(['done', 'done']);
  });
});

describe('mode B: the team’s own pod (profiles for a controller)', () => {
  it('renders the managed bot’s profile and credentials, stable across calls, and a hand-made revoke is kept until re-enabled; the pod’s gateway serves a run with the bot’s own key', async () => {
    const provider = w.server.host.registries.providers['hermes.profiles'].list()[0]!.value as HermesProfilesProvider;
    expect(provider.id).toBe('hermes.profiles');
    const teamId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`)).rows[0]!.id);
    const changes: string[] = [];
    const stop = provider.onChange((c) => changes.push(c.teamId));

    // The pod is registered; no bot is placed on it yet.
    await provider.setManagedGateway(teamId, { baseUrl: gw.url });
    expect(await provider.profilesForTeam(teamId)).toEqual([]);

    const bot = await loadBot('pod-bot', ['  gateway:', '    connection: managed']);
    await until(async () => changes.length > 0, 15_000, 'the profiles-changed notice');
    stop();
    expect(changes.every((t) => t === teamId)).toBe(true);
    expect(await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.events WHERE type = 'hermes.profiles.changed' AND payload ->> 'teamId' = $1`, [teamId])).rows.length)).toBeGreaterThan(0);

    // Without an LLM key the bot cannot call a model: no half profile is rendered.
    expect((await provider.profilesForTeam(teamId)).map((p) => p.botId)).not.toContain(bot.botId);

    // The gateway-llm plugin mints the key when a LiteLLM is configured; here the row it would have written is written directly.
    const workspaceId = omar.workspaceId;
    const secretId = await withSystem((tx) => putSecret(tx, 'sk-virtual-key-of-pod-bot'), { pool: w.server.pools.system, workspaceId: workspaceId as never });
    await w.system((tx) => tx.query(`INSERT INTO app.llm_keys (bot_id, workspace_id, secret_id, key_prefix) VALUES ($1, $2, $3, 'sk-test1234')`, [bot.botId, workspaceId, secretId]));

    const [spec] = await provider.profilesForTeam(teamId);
    expect(spec).toMatchObject({ profile: 'mt-pod-bot', botId: bot.botId });
    expect(Object.keys(spec!.files).sort()).toEqual(['.env.template', 'SOUL.md', 'config.yaml']);
    expect(spec!.files['config.yaml']).toContain(`/api/mcp/bots/${bot.botId}`);
    expect(spec!.files['config.yaml']).toContain('"off"');
    expect(spec!.secrets.LLM_KEY).toBe('sk-virtual-key-of-pod-bot');
    expect(spec!.secrets.API_SERVER_KEY).toMatch(/^mtk_/);
    for (const secret of Object.values(spec!.secrets)) expect(spec!.files['config.yaml']).not.toContain(secret);
    // the MCP token works at the bot endpoint
    expect((await rpc(bot.botId, spec!.secrets.MCP_TOKEN, 'tools/list')).status).toBe(200);
    // stable: the same credentials the second time
    expect((await provider.profilesForTeam(teamId))[0]!.secrets).toEqual(spec!.secrets);

    // the pod serves the run: requests carry the bot's own profile key, and the profile’s MCP calls carry its token
    gw.setProfile('mt-pod-bot', { apiKey: spec!.secrets.API_SERVER_KEY, mcp: { url: `${w.server.url}/api/mcp/bots/${bot.botId}`, token: spec!.secrets.MCP_TOKEN } });
    gw.setScript(() => [{ type: 'finish', output: 'Answered by the pod.' }]);
    const rootId = await post('@pod-bot hello from the pod');
    const reply = await until(async () => (await messagesBy(rootId, bot.actorId))[0], 30_000, 'the pod reply');
    expect(reply.body).toBe('Answered by the pod.');
    expect(gw.calls.find((c) => c.path === '/p/mt-pod-bot/v1/runs' && c.method === 'POST')).toMatchObject({ authorized: true });

    // a lead revokes the bot's tokens by hand: that is a decision, not a fault. The platform does not undo it: the old token is dead, no new one is
    // minted, the bot drops out of the pod's profile set, and only an explicit re-enable brings it back with a fresh token.
    expect((await w.call(omar, 'DELETE', '/api/teams/engineering/bots/pod-bot/pairing-tokens')).status).toBe(200);
    expect((await rpc(bot.botId, spec!.secrets.MCP_TOKEN, 'tools/list')).status).toBe(401);
    expect((await provider.profilesForTeam(teamId)).map((p) => p.botId)).not.toContain(bot.botId);
    expect((await provider.profilesForTeam(teamId)).map((p) => p.botId)).not.toContain(bot.botId);
    expect(await w.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE bot_id = $1 AND revoked_at IS NULL`, [bot.botId])).rows[0]!.n)).toBe(0);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/bots/pod-bot/hermes/reenable', {})).status).toBe(403);
    expect((await w.call(omar, 'POST', '/api/teams/engineering/bots/pod-bot/hermes/reenable', {})).status).toBe(200);
    const [healed] = await provider.profilesForTeam(teamId);
    expect(healed!.secrets.MCP_TOKEN).not.toBe(spec!.secrets.MCP_TOKEN);
    expect(healed!.secrets.API_SERVER_KEY).toBe(spec!.secrets.API_SERVER_KEY);
    expect((await rpc(bot.botId, healed!.secrets.MCP_TOKEN, 'tools/list')).status).toBe(200);
    expect(await w.system(async (tx) => (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM app.bot_pairing_tokens WHERE bot_id = $1 AND revoked_at IS NULL`, [bot.botId])).rows[0]!.n)).toBe(1);
  });
});

describe('which run a call at the bot endpoint belongs to', () => {
  let bot: LoadedBot;
  const insertJobRun = async (jobId: string): Promise<string> =>
    w.system(async (tx) => {
      const teamId = (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bots WHERE id = $1', [bot.botId])).rows[0]!.team_id;
      const run = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, job_id) VALUES ($1, $2, $3, 'mention', $4, 'running', $5) RETURNING id`,
          [omar.workspaceId, bot.botId, teamId, nadia.actorId, jobId],
        )
      ).rows[0]!;
      await tx.query(`INSERT INTO app.mcp_run_tokens (run_id, bot_id, token_hash, expires_at) VALUES ($1, $2, sha256(gen_random_uuid()::text::bytea), now() + interval '10 minutes')`, [run.id, bot.botId]);
      return run.id;
    });
  const closeRuns = (): Promise<unknown> => w.system((tx) => tx.query(`UPDATE app.bot_runs SET status = 'failed', ended_at = now() WHERE bot_id = $1 AND status = 'running'`, [bot.botId]));
  const answerOf = async (): Promise<{ isError: boolean; answer: any }> => toolAnswer((await rpc(bot.botId, bot.token, 'tools/call', { name: 'memory.recall', arguments: { query: 'anything' } })).body);

  it('ignores a run that no queue job opened (an approval’s re-run, a public mint) and fails closed when two job runs are open', async () => {
    bot = await loadBot('which-run', ['  gateway:', '    connection: host', '    profile: which-run'], 'which-run');
    // a run opened the public way (no job): the bot endpoint does not attribute a call to it
    const minted = await w.call<{ runId: string }>(null, 'POST', '/api/mcp/runs', { pairingToken: bot.token });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect((await answerOf()).answer).toMatchObject({ code: 'no_open_run' });

    // one job run open next to it: that one is the bot's open run
    await insertJobRun('00000000-0000-7000-8000-00000000aa01');
    const one = await answerOf();
    expect(one.answer.code).not.toBe('no_open_run');
    expect(one.answer.code).not.toBe('ambiguous_run');

    // two job runs open at once: no call is attributed to either
    await insertJobRun('00000000-0000-7000-8000-00000000aa02');
    expect((await answerOf()).answer).toMatchObject({ ok: false, code: 'ambiguous_run' });
    await closeRuns();
  });
});

describe('a retried job and its own earlier run', () => {
  it('only a run that THIS job opened stops the retry; another job’s run in the same thread does not', async () => {
    const bot = await loadBot('retry-bot', ['  gateway:', '    connection: host', '    profile: retry-bot'], 'retry-bot');
    const teamId = await w.system(async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.bots WHERE id = $1', [bot.botId])).rows[0]!.team_id);
    const root = await w.system(async (tx) => (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id);
    const JOB_A = '00000000-0000-7000-8000-00000000bb01';
    const JOB_B = '00000000-0000-7000-8000-00000000bb02';
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, ended_at, reply_root_id, job_id) VALUES ($1, $2, $3, 'mention', $4, 'done', now(), NULL, $5)`,
        [omar.workspaceId, bot.botId, teamId, nadia.actorId, JOB_A],
      ),
    );
    void root;
    const closed: string[] = [];
    const ctx = { runs: { openRunOf: async () => null, close: async (id: string) => void closed.push(id) } } as unknown as PluginContext;
    const log = { info: () => undefined, warn: () => undefined };
    const jobOf = (jobId: string, attempt: number): JobInfo => ({ jobId, attempt, workerId: 'w', log, transaction: (fn) => w.system((tx) => fn(tx as never)) });
    const payload = { botId: bot.botId, replyRootId: root, trigger: 'mention' } as never;
    // job A's own retry: its run exists, so it is not repeated
    expect(await settleEarlierAttempt(ctx, log, jobOf(JOB_A, 2), payload)).toBe(true);
    // job A's first attempt, and job B's retry (B never opened a run; A's run in the same thread is not B's): both go on
    expect(await settleEarlierAttempt(ctx, log, jobOf(JOB_A, 1), payload)).toBe(false);
    expect(await settleEarlierAttempt(ctx, log, jobOf(JOB_B, 2), payload)).toBe(false);
    expect(closed).toEqual([]);
  });
});

describe('failed attempts at the bot endpoint are limited per client address', () => {
  it('answers 429 after a flood of bad tokens, while a good token still works', async () => {
    const bot = await loadBot('limited-bot', ['  gateway:', '    connection: host', '    profile: limited-bot'], 'limited-bot');
    let limited = 0;
    for (let i = 0; i < 75; i += 1) {
      const r = await rpc(bot.botId, `guess-${i}-0123456789abcdef`, 'tools/list');
      if (r.status === 429) limited += 1;
      else expect(r.status).toBe(401);
    }
    expect(limited).toBeGreaterThan(0);
    // an honest caller is counted per bot, not per address, so the good token is not locked out by the flood
    expect((await rpc(bot.botId, bot.token, 'tools/list')).status).toBe(200);
  });
});
