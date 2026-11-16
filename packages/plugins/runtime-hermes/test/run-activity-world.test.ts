/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunActivityResponse, ListThreadRunsResponse, ListMessagesResponse } from '@manythreads/shared';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startFakeHermesGateway, type FakeHermesGateway, type FakeRunStep } from '../../../../tools/fake-hermes-gateway/src/server.ts';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// P25-06, P25-07 and P25-08 end to end: a mention runs through a Hermes gateway that sends the bridge's activity frames; the run leaves its folded
// view and its lines; the routes answer them (with `canStop` per caller); a person can hold a watch lease on the thread; and Stop works for the asker, the
// lead, and by the database flag alone (what another replica of the server would write).

const { omar, nadia, rafi } = personas;
vi.setConfig({ testTimeout: 180_000 });

let w: RepoWorld;
let gw: FakeHermesGateway;
let scratch = '';
let channelId = '';
let botId = '';
let botActorId = '';
const savedEnv = { allowed: process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'], dir: process.env['MANYTHREADS_RUNTIME_DIR'] };
const API_KEY = 'gateway-key-0123456789abcdef';

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const BOT_MD = [
  '---',
  'schema: 1',
  'name: act-bot',
  'role: Answers through a Hermes gateway',
  'kind: agent',
  'runtime: hermes',
  'model:',
  '  aliases: [smart]',
  'triggers:',
  '  - type: mention',
  'capabilities:',
  '  native: [messages.post]',
  'placement:',
  '  gateway:',
  '    connection: host',
  '    profile: act-bot',
  '---',
  '',
  '# act-bot',
  '',
  'Soul text.',
  '',
].join('\n');

const post = async (who: typeof nadia, body: string): Promise<string> => {
  const res = await w.call(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
};

const runOfThread = (rootId: string) =>
  until(
    async () =>
      (await w.system(async (tx) => (await tx.query<{ id: string; status: string }>(`SELECT r.id, r.status FROM app.bot_runs r JOIN app.run_view v ON v.run_id = r.id WHERE r.bot_id = $1 AND v.thread_root_id = $2 ORDER BY r.started_at DESC LIMIT 1`, [botId, rootId])).rows[0])) ?? null,
    30_000,
    'the run to open',
  );

const closedRunOf = (rootId: string) =>
  until(async () => {
    const run = await w.system(async (tx) => (await tx.query<{ id: string; status: string }>(`SELECT r.id, r.status FROM app.bot_runs r JOIN app.run_view v ON v.run_id = r.id WHERE r.bot_id = $1 AND v.thread_root_id = $2 ORDER BY r.started_at DESC LIMIT 1`, [botId, rootId])).rows[0]);
    return run && run.status !== 'running' ? run : null;
  }, 40_000, 'the run to close');

const viewOf = (runId: string) =>
  w.system(async (tx) => (await tx.query<any>(`SELECT * FROM app.run_view WHERE run_id = $1`, [runId])).rows[0] ?? null);

const replyBodies = async (rootId: string): Promise<string[]> => {
  const res = await w.call(nadia, 'GET', `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body)
    .items.filter((m) => m.authorId === botActorId)
    .map((m) => m.body);
};

const work = (end: FakeRunStep): FakeRunStep[] => [
  { type: 'frame', event: 'tool.started', fields: { tool: 'read_file', step_id: 's1', title: 'Read the readme', paths: ['README.md'], kind: 'read' } },
  { type: 'frame', event: 'tool.completed', fields: { tool: 'read_file', step_id: 's1', duration: 0.2 } },
  { type: 'frame', event: 'plan.update', fields: { entries: [{ content: 'Look around', status: 'completed' }, { content: 'Write the answer', status: 'in_progress' }] } },
  { type: 'frame', event: 'agent.update', fields: { agent_id: 'a1', name: 'Reviewer', status: 'working', steps: 2 } },
  end,
];

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-activity-'));
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_HERMES_ALLOWED_HOSTS'] = '127.0.0.1';
  gw = await startFakeHermesGateway({ profiles: {} });
  gw.setProfile('act-bot', { apiKey: API_KEY });
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`)).rows[0]?.id ?? '');
  expect(channelId).not.toBe('');
  // the team's connection to the fake gateway (a workspace admin's adoption is what the platform does; the row is what the run reads)
  const { putSecret, withSystem } = await import('@manythreads/kernel');
  const secretId = await withSystem((tx) => putSecret(tx, API_KEY), { pool: w.server.pools.system, workspaceId: omar.workspaceId as never });
  await w.system((tx) =>
    tx.query(
      `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id)
       SELECT t.workspace_id, t.id, 'host', 'external', 'hermes', $1, $2::uuid FROM app.teams t WHERE t.slug = 'engineering'`,
      [gw.url, secretId],
    ),
  );
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/act-bot/BOT.md', content: BOT_MD }], 'Add act-bot');
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  botId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'act-bot' AND status = 'active'`)).rows[0]?.id ?? null), 20_000, 'the loader');
  botActorId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [botId])).rows[0]?.id ?? null), 5_000, 'the actor');
}, 180_000);

afterAll(async () => {
  await w?.close();
  await gw?.close();
  for (const [name, value] of [['MANYTHREADS_HERMES_ALLOWED_HOSTS', savedEnv.allowed], ['MANYTHREADS_RUNTIME_DIR', savedEnv.dir]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('what a run kept, and who reads it (P25-06)', () => {
  it('a finished thread run leaves its view and its lines; the routes answer them with canStop per caller', async () => {
    gw.setScript(() => work({ type: 'finish', output: 'All done.' }));
    const rootId = await post(nadia, '@act-bot look around');
    const run = await closedRunOf(rootId);
    expect(run.status).toBe('done');

    const view = await until(async () => {
      const v = await viewOf(run.id);
      return v && v.ended_at !== null ? v : null;
    }, 10_000, 'the view to be closed');
    expect(view).toMatchObject({ state: 'done', thread_root_id: rootId, channel_id: channelId, conversation: false, asker_id: nadia.actorId, bot_name: 'act-bot' });
    expect(view.counts).toMatchObject({ steps: 1 });
    expect(view.plan).toHaveLength(2);
    const kinds = await w.system(async (tx) => (await tx.query<{ kind: string }>(`SELECT kind FROM app.run_activity WHERE run_id = $1 ORDER BY seq`, [run.id])).rows.map((r) => r.kind));
    expect(kinds).toEqual(expect.arrayContaining(['tool', 'tool_result', 'plan', 'agent']));
    // never what a tool was given or returned
    const raw = JSON.stringify(await w.system(async (tx) => (await tx.query(`SELECT payload FROM app.run_activity WHERE run_id = $1`, [run.id])).rows));
    expect(raw).not.toContain('Soul text');

    const list = await w.call(nadia, 'GET', `/api/threads/${rootId}/runs`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const runs = ListThreadRunsResponse.parse(list.body).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: run.id, state: 'done', channelId, threadRootId: rootId, askerActorId: nadia.actorId, conversation: false, canStop: false });
    expect(runs[0]!.endedAt).not.toBeNull();

    const act = await w.call(rafi, 'GET', `/api/runs/${run.id}/activity?after=-1`);
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    const parsed = RunActivityResponse.parse(act.body);
    expect(parsed.run.runId).toBe(run.id);
    expect(parsed.items.map((i) => i.payload.kind)).toEqual(expect.arrayContaining(['tool', 'plan']));
    expect(parsed.items.map((i) => i.seq)).toEqual([...parsed.items.map((i) => i.seq)].sort((a, b) => a - b));
    expect(parsed.hasMore).toBe(false);
    // `after` keeps only the later lines
    const lastSeq = parsed.items[parsed.items.length - 1]!.seq;
    const tail = RunActivityResponse.parse((await w.call(rafi, 'GET', `/api/runs/${run.id}/activity?after=${lastSeq}`)).body);
    expect(tail.items).toEqual([]);

    // a run that is not there, or a bad id, is a plain 404/400
    expect((await w.call(rafi, 'GET', `/api/runs/00000000-0000-4000-8000-000000000000/activity`)).status).toBe(404);
    expect((await w.call(rafi, 'GET', `/api/runs/not-an-id/activity`)).status).toBe(400);
  });
});

const LEASE_A = '00000000-0000-4000-8000-0000000a0001';
const LEASE_B = '00000000-0000-4000-8000-0000000a0002';
const leaseRows = (rootId: string): Promise<number> => w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.thread_watchers WHERE root_id = $1`, [rootId])).rows.length);

describe('the watch lease (P25-07)', () => {
  it('a reader of the thread holds a lease that is renewed, and ends it; a thread nobody can read is a 404', async () => {
    const rootId = await post(nadia, 'plain message, no bot');
    const put = await w.call<{ expiresAt: string }>(rafi, 'PUT', `/api/threads/${rootId}/watch/${LEASE_A}`, {});
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const first = Date.parse(put.body.expiresAt);
    expect(first).toBeGreaterThan(Date.now());
    expect(first).toBeLessThan(Date.now() + 61_000);
    const again = await w.call<{ expiresAt: string }>(rafi, 'PUT', `/api/threads/${rootId}/watch/${LEASE_A}`, {});
    expect(again.status).toBe(200);
    expect(Date.parse(again.body.expiresAt)).toBeGreaterThanOrEqual(first);
    expect(await leaseRows(rootId)).toBe(1);
    expect((await w.call(rafi, 'DELETE', `/api/threads/${rootId}/watch/${LEASE_A}`)).status).toBe(200);
    expect(await leaseRows(rootId)).toBe(0);
    expect((await w.call(rafi, 'PUT', `/api/threads/00000000-0000-4000-8000-000000000000/watch/${LEASE_A}`, {})).status).toBe(404);
    expect((await w.call(rafi, 'PUT', `/api/threads/${rootId}/watch/not-a-uuid`, {})).status).toBe(400);
  });

  it('two tabs of one person hold two leases; closing one leaves the other', async () => {
    const rootId = await post(nadia, 'a thread open in two tabs');
    expect((await w.call(rafi, 'PUT', `/api/threads/${rootId}/watch/${LEASE_A}`, {})).status).toBe(200);
    expect((await w.call(rafi, 'PUT', `/api/threads/${rootId}/watch/${LEASE_B}`, {})).status).toBe(200);
    expect(await leaseRows(rootId)).toBe(2);
    expect((await w.call(rafi, 'DELETE', `/api/threads/${rootId}/watch/${LEASE_A}`)).status).toBe(200);
    expect(await leaseRows(rootId)).toBe(1);
    expect((await w.call(rafi, 'DELETE', `/api/threads/${rootId}/watch/${LEASE_B}`)).status).toBe(200);
  });

  it('a person holds at most 50 open leases (the 51st is a 429) and a renewal is never refused for it', async () => {
    const rootId = await post(nadia, 'a thread with too many tabs');
    const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.thread_watchers (root_id, person_id, lease_id, channel_id, expires_at)
         SELECT $1, $2, gen_random_uuid(), $3, now() + interval '1 minute' FROM generate_series(1, 50)`,
        [rootId, personas.omar.personId, channelId],
      ),
    );
    const refused = await w.call(omar, 'PUT', `/api/threads/${rootId}/watch/${id(51)}`, {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(429);
    const held = await w.system(async (tx) => (await tx.query<{ lease_id: string }>(`SELECT lease_id FROM app.thread_watchers WHERE person_id = $1 LIMIT 1`, [personas.omar.personId])).rows[0]!.lease_id);
    expect((await w.call(omar, 'PUT', `/api/threads/${rootId}/watch/${held}`, {})).status).toBe(200);
    await w.system((tx) => tx.query(`DELETE FROM app.thread_watchers WHERE person_id = $1`, [personas.omar.personId]));
  });
});

describe('the channel\'s active runs and who is pushed to (reviews H1, M1)', () => {
  let listener: pg.Client;
  const seen: Array<{ personId: string; type: string; payload: Record<string, any> }> = [];

  beforeAll(async () => {
    listener = new pg.Client({ connectionString: w.server.db.systemUrl });
    await listener.connect();
    listener.on('notification', (m) => {
      if (m.payload) seen.push(JSON.parse(m.payload));
    });
    await listener.query('LISTEN manythreads_realtime');
  });
  afterAll(async () => {
    await listener?.end();
  });

  const to = (type: string, runId: string): string[] => seen.filter((m) => m.type === type && m.payload['runId'] === runId).map((m) => m.personId);

  it('lists the runs that are going in a channel while they go, and not after; run.activity goes to the people who hold a lease and run.started to every reader', async () => {
    gw.setScript(() => work({ type: 'hang', ms: 60_000 }));
    const rootId = await post(nadia, '@act-bot who is looking');
    expect((await w.call(rafi, 'PUT', `/api/threads/${rootId}/watch/${LEASE_A}`, {})).status).toBe(200);
    const open = await runOfThread(rootId);
    await until(async () => (await viewOf(open.id))?.counts?.steps >= 1, 20_000, 'the first line');
    await until(async () => (to('run.activity', open.id).length > 0 ? true : null), 10_000, 'a run.activity push');

    const active = await w.call<{ runs: Array<{ runId: string; threadRootId: string }> }>(rafi, 'GET', `/api/channels/${channelId}/active-runs`);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    expect(active.body.runs.map((r) => r.runId)).toContain(open.id);
    expect(active.body.runs.find((r) => r.runId === open.id)).toMatchObject({ threadRootId: rootId });
    // somebody who cannot read the channel sees nothing of it
    const outsider = await w.call<{ runs: unknown[] }>(personas.lena, 'GET', `/api/channels/${channelId}/active-runs`);
    expect(outsider.status === 200 ? outsider.body.runs : []).toEqual([]);

    // the steps went to the one who holds a lease; the chip to everybody who reads the channel
    expect(new Set(to('run.activity', open.id))).toEqual(new Set([rafi.personId]));
    expect(to('run.started', open.id).length).toBeGreaterThan(1);
    expect(to('run.started', open.id)).toEqual(expect.arrayContaining([rafi.personId, nadia.personId, omar.personId]));

    // a person who has left the team stops being pushed to at once, with their lease still alive (the membership is put back at the end)
    const owner = new pg.Client({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    const memberships = (await owner.query(`SELECT * FROM app.team_members WHERE actor_id = $1`, [rafi.actorId])).rows;
    await owner.query(`DELETE FROM app.team_members WHERE actor_id = $1`, [rafi.actorId]);
    let after: string[] = [];
    try {
      expect((await w.call(omar, 'PUT', `/api/threads/${rootId}/watch/${LEASE_B}`, {})).status).toBe(200);
      // the audience is reused for a few seconds
      await new Promise((r) => setTimeout(r, 3500));
      const before = seen.length;
      // the end of the run is one more push to the watchers that are left
      await w.call(omar, 'POST', `/api/runs/${open.id}/stop`, {});
      await closedRunOf(rootId);
      await until(async () => (seen.slice(before).some((m) => m.type === 'run.activity' && m.payload['runId'] === open.id) ? true : null), 15_000, 'the push after the change');
      after = seen.slice(before).filter((m) => m.type === 'run.activity' && m.payload['runId'] === open.id).map((m) => m.personId);
    } finally {
      await owner.query(`INSERT INTO app.team_members SELECT * FROM json_populate_recordset(NULL::app.team_members, $1::json)`, [JSON.stringify(memberships)]);
      await owner.end();
    }
    expect(after).not.toContain(rafi.personId);
    expect(after).toContain(omar.personId);
    // and the run is over for the list
    const done = await w.call<{ runs: Array<{ runId: string }> }>(omar, 'GET', `/api/channels/${channelId}/active-runs`);
    expect(done.body.runs.map((r) => r.runId)).not.toContain(open.id);
    await w.system((tx) => tx.query(`DELETE FROM app.thread_watchers WHERE root_id = $1`, [rootId]));
  });
});

describe('the channel lease: one lease for the whole channel (P29-02)', () => {
  const CH_LEASE = '00000000-0000-4000-8000-0000000c0a01';
  let listener: pg.Client;
  const seen: Array<{ personId: string; type: string; payload: Record<string, any> }> = [];
  beforeAll(async () => {
    listener = new pg.Client({ connectionString: w.server.db.systemUrl });
    await listener.connect();
    listener.on('notification', (m) => {
      if (m.payload) seen.push(JSON.parse(m.payload));
    });
    await listener.query('LISTEN manythreads_realtime');
  });
  afterAll(async () => {
    await listener?.end();
  });

  it('a lease renews and ends; a channel nobody can read is a 404; a bot is refused; a guest with no grant is a 404', async () => {
    const put = await w.call<{ expiresAt: string }>(rafi, 'PUT', `/api/channels/${channelId}/watch/${CH_LEASE}`, {});
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(Date.parse(put.body.expiresAt)).toBeGreaterThan(Date.now() + 30_000);
    expect((await w.call(rafi, 'PUT', `/api/channels/${channelId}/watch/${CH_LEASE}`, {})).status).toBe(200);
    expect(await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.channel_watchers WHERE channel_id = $1`, [channelId])).rows.length)).toBe(1);
    expect((await w.call(rafi, 'PUT', `/api/channels/00000000-0000-4000-8000-000000000000/watch/${CH_LEASE}`, {})).status).toBe(404);
    expect((await w.call(rafi, 'PUT', `/api/channels/${channelId}/watch/not-a-uuid`, {})).status).toBe(400);
    expect((await w.call(personas.lena, 'PUT', `/api/channels/${channelId}/watch/${CH_LEASE}`, {})).status).toBe(404);
    expect((await w.call(rafi, 'DELETE', `/api/channels/${channelId}/watch/${CH_LEASE}`)).status).toBe(200);
    expect(await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.channel_watchers WHERE channel_id = $1`, [channelId])).rows.length)).toBe(0);
  });

  it('the ninth open channel of one person is a 429; a renewal is not', async () => {
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.channel_watchers (channel_id, person_id, lease_id, expires_at)
         SELECT $1, $2, ('00000000-0000-4000-8000-0000000c1' || lpad(g::text, 3, '0'))::uuid, now() + interval '1 minute' FROM generate_series(1, 8) g`,
        [channelId, personas.omar.personId],
      ),
    );
    const refused = await w.call(omar, 'PUT', `/api/channels/${channelId}/watch/${CH_LEASE}`, {});
    expect(refused.status).toBe(429);
    expect((await w.call(omar, 'PUT', `/api/channels/${channelId}/watch/00000000-0000-4000-8000-0000000c1001`, {})).status).toBe(200);
    await w.system((tx) => tx.query(`DELETE FROM app.channel_watchers WHERE person_id = $1`, [personas.omar.personId]));
  });

  it('a person with the channel open is sent the folded state of its runs; the channel read carries the head of a going run and, after it ends, the head in `recent`', async () => {
    gw.setScript(() => work({ type: 'hang', ms: 60_000 }));
    expect((await w.call(nadia, 'PUT', `/api/channels/${channelId}/watch/${CH_LEASE}`, {})).status).toBe(200);
    const rootId = await post(nadia, '@act-bot a run for the channel lease');
    const open = await runOfThread(rootId);
    await until(async () => (await viewOf(open.id))?.counts?.steps >= 1, 20_000, 'the first line');
    await until(async () => (seen.some((m) => m.type === 'run.activity' && m.payload['runId'] === open.id) ? true : null), 10_000, 'a run.activity push');
    // only the person who holds the channel lease was sent it (no thread lease exists)
    expect(new Set(seen.filter((m) => m.type === 'run.activity' && m.payload['runId'] === open.id).map((m) => m.personId))).toEqual(new Set([nadia.personId]));

    const active = await w.call<{ runs: Array<{ runId: string; head?: { state: string; canStop?: boolean } }>; recent?: Array<{ runId: string }> }>(rafi, 'GET', `/api/channels/${channelId}/active-runs`);
    expect(active.status, JSON.stringify(active.body)).toBe(200);
    const going = active.body.runs.find((r) => r.runId === open.id);
    expect(going?.head).toMatchObject({ state: 'working' });
    expect(active.body.recent ?? []).not.toContainEqual(expect.objectContaining({ runId: open.id }));

    await w.call(omar, 'POST', `/api/runs/${open.id}/stop`, {});
    await closedRunOf(rootId);
    const done = await w.call<{ runs: Array<{ runId: string }>; recent?: Array<{ runId: string; state: string }> }>(rafi, 'GET', `/api/channels/${channelId}/active-runs`);
    expect(done.body.runs.map((r) => r.runId)).not.toContain(open.id);
    expect(done.body.recent?.find((r) => r.runId === open.id)).toMatchObject({ state: 'stopped' });
    await w.call(nadia, 'DELETE', `/api/channels/${channelId}/watch/${CH_LEASE}`);
  });
});

describe('Stop for a thread run (P25-08)', () => {
  it('a member who is neither the asker, the starter, a lead nor an admin is refused; the lead stops it and the reply says who', async () => {
    gw.setScript(() => work({ type: 'hang', ms: 60_000 }));
    const rootId = await post(nadia, '@act-bot take your time');
    const open = await runOfThread(rootId);
    // the run shows as working with some lines, and the head says who may stop
    await until(async () => (await viewOf(open.id))?.counts?.steps >= 1, 20_000, 'the first line');
    const mine = await w.call(nadia, 'GET', `/api/threads/${rootId}/runs`);
    expect(ListThreadRunsResponse.parse(mine.body).runs[0]).toMatchObject({ runId: open.id, canStop: true });
    const theirs = await w.call(rafi, 'GET', `/api/threads/${rootId}/runs`);
    expect(ListThreadRunsResponse.parse(theirs.body).runs[0]).toMatchObject({ runId: open.id, canStop: false });
    const lead = await w.call(omar, 'GET', `/api/threads/${rootId}/runs`);
    expect(ListThreadRunsResponse.parse(lead.body).runs[0]).toMatchObject({ runId: open.id, canStop: true });

    // Rafi, a member of the channel who started nothing, is refused and the run goes on
    const refused = await w.call(rafi, 'POST', `/api/runs/${open.id}/stop`, {});
    expect([403, 404]).toContain(refused.status);
    expect((await viewOf(open.id))?.stop_requested_at ?? null).toBeNull();

    // Omar, the team lead, stops it
    const stopped = await w.call<{ stopped: boolean }>(omar, 'POST', `/api/runs/${open.id}/stop`, {});
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body).toEqual({ stopped: true });
    const closed = await closedRunOf(rootId);
    expect(closed.id).toBe(open.id);
    const view = await until(async () => {
      const v = await viewOf(open.id);
      return v && v.ended_at !== null ? v : null;
    }, 10_000, 'the view to close');
    expect(view).toMatchObject({ state: 'stopped', stopped_by_name: 'Omar', stopped_by_actor: omar.actorId });
    const bodies = await until(async () => {
      const b = await replyBodies(rootId);
      return b.length > 0 ? b : null;
    }, 20_000, 'the reply');
    expect(bodies.join('\n')).toContain('Stopped by Omar');
    // asking again is a plain "nothing to stop"
    const late = await w.call<{ stopped: boolean }>(omar, 'POST', `/api/runs/${open.id}/stop`, {});
    expect(late.status).toBe(200);
    expect(late.body).toEqual({ stopped: false });
  });

  it('the asker stops her own run', async () => {
    gw.setScript(() => work({ type: 'hang', ms: 60_000 }));
    const rootId = await post(nadia, '@act-bot another one');
    const open = await runOfThread(rootId);
    await until(async () => (await viewOf(open.id))?.counts?.steps >= 1, 20_000, 'the first line');
    const res = await w.call<{ stopped: boolean }>(nadia, 'POST', `/api/runs/${open.id}/stop`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ stopped: true });
    await closedRunOf(rootId);
    const view = await until(async () => {
      const v = await viewOf(open.id);
      return v && v.ended_at !== null ? v : null;
    }, 10_000, 'the view to close');
    expect(view).toMatchObject({ state: 'stopped', stopped_by_name: 'Nadia' });
  });

  it('a stop written to the database alone (what another replica does) is seen by the replica that holds the run', async () => {
    gw.setScript(() => work({ type: 'hang', ms: 60_000 }));
    const rootId = await post(nadia, '@act-bot and a third');
    const open = await runOfThread(rootId);
    await until(async () => (await viewOf(open.id))?.counts?.steps >= 1, 20_000, 'the first line');
    await w.system((tx) => tx.query(`UPDATE app.run_view SET stop_requested_at = now(), stopped_by_actor = $2, stopped_by_name = 'Omar', state = 'stopping' WHERE run_id = $1`, [open.id, omar.actorId]));
    const closed = await closedRunOf(rootId);
    expect(closed.id).toBe(open.id);
    const view = await until(async () => {
      const v = await viewOf(open.id);
      return v && v.ended_at !== null ? v : null;
    }, 10_000, 'the view to close');
    expect(view).toMatchObject({ state: 'stopped', stopped_by_name: 'Omar' });
    const bodies = await until(async () => {
      const b = await replyBodies(rootId);
      return b.length > 0 ? b : null;
    }, 20_000, 'the reply');
    expect(bodies.join('\n')).toContain('Stopped by Omar');
  });
});
