/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunActivityResponse, ListThreadRunsResponse, ListMessagesResponse } from '@manythreads/shared';
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

describe('the watch lease (P25-07)', () => {
  it('a reader of the thread holds a lease that is renewed, and ends it; a thread nobody can read is a 404', async () => {
    const rootId = await post(nadia, 'plain message, no bot');
    const put = await w.call<{ expiresAt: string }>(rafi, 'PUT', `/api/threads/${rootId}/watch`, {});
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const first = Date.parse(put.body.expiresAt);
    expect(first).toBeGreaterThan(Date.now());
    expect(first).toBeLessThan(Date.now() + 61_000);
    const again = await w.call<{ expiresAt: string }>(rafi, 'PUT', `/api/threads/${rootId}/watch`, {});
    expect(again.status).toBe(200);
    expect(Date.parse(again.body.expiresAt)).toBeGreaterThanOrEqual(first);
    expect(await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.thread_watchers WHERE root_id = $1`, [rootId])).rows.length)).toBe(1);
    expect((await w.call(rafi, 'DELETE', `/api/threads/${rootId}/watch`)).status).toBe(200);
    expect(await w.system(async (tx) => (await tx.query(`SELECT 1 FROM app.thread_watchers WHERE root_id = $1`, [rootId])).rows.length)).toBe(0);
    expect((await w.call(rafi, 'PUT', `/api/threads/00000000-0000-4000-8000-000000000000/watch`, {})).status).toBe(404);
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
