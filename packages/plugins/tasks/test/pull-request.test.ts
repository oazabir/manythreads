import { randomUUID } from 'node:crypto';
import { withActor } from '@manythreads/kernel';
import { ListProjectsResponse, ListTaskEventsResponse, Project, GetTaskResponse } from '@manythreads/shared';
import {
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  createPersonas,
  ownerSql,
  personas,
  startFakeGithub,
  startFakeK8s,
  startTestServer,
  type FakeGithub,
  type FakeK8s,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Publishing as a pull request, end to end on a real server and database: a lead sets a project's GitHub token (it goes to "the Secret" of a fake
// Kubernetes API and nowhere else), the bot that tested a card records the pull request it opened, and a job that reads the pull request on a fake
// GitHub finishes the card when a person merges it, or sends it back when it is closed.

const { omar, nadia } = personas;
const TEAM = TEAM_IDS.Engineering;
const TOKEN = 'github_pat_TestTokenValue0123456789abcdef';
// the pods namespace defaults to "manythreads-bots"; the fake keys its Secrets by <namespace>/<name>
const SECRET_KEY = 'manythreads-bots/hermes-engineering-push';
const ORIGIN = 'https://github.com/acme/widgets';
const SHA = 'a'.repeat(40);
/** What the Secret holds for a project (base64 of a JSON document: the token and the address it was issued for). */
const docB64 = (token = TOKEN, origin = ORIGIN) => Buffer.from(JSON.stringify({ branch: 'main', origin, setAt: new Date().toISOString(), token })).toString('base64');
const parsedDoc = (b64: string) => JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { token: string; origin: string; branch: string };

let server: TestServer;
let gh: FakeGithub;
let k8s: FakeK8s;
let bot: { botId: string; actorId: string };
let other: { botId: string; actorId: string };
let projectId = '';
const saved: Record<string, string | undefined> = {};
const ENV = ['MANYTHREADS_HERMES_PODS_TEST_K8S_URL', 'MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW', 'MANYTHREADS_TEST_GITHUB_API'];

type Who = { kind: 'person'; actorId: string } | { kind: 'bot'; actorId: string };
const person = (p: { actorId: string }): Who => ({ kind: 'person', actorId: p.actorId });
const asBot = (b: { actorId: string }): Who => ({ kind: 'bot', actorId: b.actorId });
async function call(who: Who, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: who.kind, id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

async function makeBot(slug: string): Promise<{ botId: string; actorId: string }> {
  const botId = randomUUID();
  const actorId = randomUUID();
  await ownerSql(
    server.db.ownerUrl,
    `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, $4, $4, 'agent', 'hermes', 'team', $5, 'active')`,
    [botId, KAHF_WORKSPACE_ID, TEAM, slug, 'a'.repeat(64)],
  );
  await ownerSql(server.db.ownerUrl, `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [actorId, KAHF_WORKSPACE_ID, botId]);
  await ownerSql(server.db.ownerUrl, `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [TEAM, actorId, KAHF_WORKSPACE_ID]);
  return { botId, actorId };
}

/** A code card owned by `bot` (claimed through the route, as a bot would). */
async function ownedCard(title: string): Promise<string> {
  const made = await call(person(nadia), 'POST', '/api/teams/engineering/tasks', { title, branch: 'card-' + randomUUID().slice(0, 8) });
  expect(made.status, made.text).toBe(201);
  const id = (made.body['task'] as { id: string }).id;
  const claimed = await call(asBot(bot), 'POST', `/api/teams/engineering/tasks/${id}/claim`);
  expect(claimed.status, claimed.text).toBe(200);
  return id;
}

/** The door the tool calls once the server has verified the pull request with GitHub (the tool's own checks are in tool-pull-request.test.ts). */
const record = (who: { actorId: string }, task: string, sha: string, project = 'widgets', n = 1, url = `${ORIGIN}/pull/${n}`, origin = ORIGIN, headRef = `card-${task.slice(0, 8)}`, headSha = sha, baseRef = 'main') =>
  withActor(
    { kind: 'bot', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID } as unknown as Parameters<typeof withActor>[0],
    async (tx) =>
      (
        await tx.query<{ o_outcome: string; o_reason: string }>('SELECT * FROM app.tasks_record_pull_request($1::uuid, $2, $3, $4::integer, $5, $6, $7, $8, $9)', [task, sha, project, n, url, origin, headRef, headSha, baseRef])
      ).rows[0]!,
    { pool: server.pools.app },
  );

/** A pull request on the fake GitHub for a card's branch, opened the way `mt-publish` does it; its number. */
async function openPull(taskId: string, headSha = SHA): Promise<number> {
  const r = await fetch(`${gh.url}/repos/acme/widgets/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `PR for ${taskId}`, head: `card-${taskId.slice(0, 8)}`, base: 'main', head_sha: headSha }),
  });
  expect(r.status).toBe(201);
  return ((await r.json()) as { number: number }).number;
}

const card = async (id: string) => GetTaskResponse.parse((await call(person(nadia), 'GET', `/api/teams/engineering/tasks/${id}`)).body).task;
const history = async (id: string) => ListTaskEventsResponse.parse((await call(person(nadia), 'GET', `/api/teams/engineering/tasks/${id}/events`)).body).items;

const summaries = (): number => server.logs.filter((l) => (JSON.parse(l) as { msg?: string }).msg?.startsWith('pull request sync:') && /asked/.test((JSON.parse(l) as { msg: string }).msg)).length;
async function runSync(): Promise<void> {
  const before = summaries();
  await ownerSql(server.db.ownerUrl, `SELECT (app.enqueue_job('tasks.pull-request-sync', '{}'::jsonb, NULL, NULL)).id`);
  await ownerSql(server.db.ownerUrl, `SELECT pg_notify('manythreads_jobs', 'tasks.pull-request-sync')`);
  const deadline = Date.now() + 20_000;
  while (summaries() <= before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  expect(summaries(), 'the sync job ran').toBeGreaterThan(before);
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', repo: 'widgets' });
  k8s = await startFakeK8s();
  process.env['MANYTHREADS_HERMES_PODS_TEST_K8S_URL'] = k8s.url;
  process.env['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW'] = 'https://github.com/acme/';
  process.env['MANYTHREADS_TEST_GITHUB_API'] = gh.url;
  server = await startTestServer();
  await createPersonas(server.db);
  bot = await makeBot('tester-bot');
  other = await makeBot('other-bot');
  const res = await call(person(omar), 'POST', '/api/teams/engineering/projects', { name: 'widgets', repoUrl: 'https://github.com/acme/widgets' });
  expect(res.status, res.text).toBe(201);
  projectId = (res.body['project'] as { id: string }).id;
}, 180_000);

afterAll(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await server?.close();
  await gh?.stop();
  await k8s?.stop();
});

const credPath = () => `/api/teams/engineering/projects/${projectId}/push-credential`;
const dbText = async (): Promise<string> =>
  JSON.stringify([
    await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.projects'),
    await ownerSql(server.db.ownerUrl, 'SELECT payload FROM app.events'),
    await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.tasks'),
    await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.task_events'),
    await ownerSql(server.db.ownerUrl, 'SELECT * FROM app.outbox'),
  ]);

describe('the push credential of a project', () => {
  it('is set by a lead into the pod’s Secret, and is in no response, no row, no event and no log', async () => {
    expect((await call(person(nadia), 'PUT', credPath(), { token: TOKEN })).status).toBe(403);
    expect(k8s.secrets.size).toBe(0);

    const set = await call(person(omar), 'PUT', credPath(), { token: TOKEN });
    expect(set.status, set.text).toBe(200);
    const project = Project.parse((set.body as { project: unknown }).project);
    expect(project.pushCredentialSetAt).not.toBeNull();
    // the token is in the Secret (base64, under the project's name) and nowhere else
    expect(Object.keys(k8s.secrets.get(SECRET_KEY)!.data!)).toEqual(['widgets']);
    expect(parsedDoc(k8s.secrets.get(SECRET_KEY)!.data!['widgets']!)).toMatchObject({ token: TOKEN, origin: ORIGIN, branch: 'main' });
    for (const text of [set.text, (await call(person(omar), 'GET', '/api/teams/engineering/projects')).text, (await call(person(nadia), 'GET', '/api/teams/engineering/projects')).text]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(Buffer.from(TOKEN).toString('base64'));
      expect(text).not.toContain(k8s.secrets.get(SECRET_KEY)!.data!['widgets']!);
    }
    expect(ListProjectsResponse.parse((await call(person(nadia), 'GET', '/api/teams/engineering/projects')).body).items[0]!.pushCredentialSetAt).not.toBeNull();
    const everything = await dbText();
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain(Buffer.from(TOKEN).toString('base64'));
    expect(everything).not.toContain(k8s.secrets.get(SECRET_KEY)!.data!['widgets']!);
    expect(server.logs.join('\n')).not.toContain(TOKEN);
  });

  it('refuses a token of the wrong shape, extra fields and an unknown project', async () => {
    for (const bad of [{ token: 'short' }, { token: 'has a space in it 0123456789' }, { token: TOKEN, extra: 1 }, {}, { token: 'x'.repeat(300) }]) {
      expect((await call(person(omar), 'PUT', credPath(), bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await call(person(omar), 'PUT', `/api/teams/engineering/projects/${randomUUID()}/push-credential`, { token: TOKEN })).status).toBe(404);
  });

  it('does not accept an address this server may not call, and a failing cluster is a 409 that says nothing about the token', async () => {
    const odd = await call(person(omar), 'POST', '/api/teams/engineering/projects', { name: 'elsewhere', repoUrl: 'https://gitlab.example/acme/widgets' });
    const oddId = (odd.body['project'] as { id: string }).id;
    expect((await call(person(omar), 'PUT', `/api/teams/engineering/projects/${oddId}/push-credential`, { token: TOKEN })).status).toBe(400);
    expect(k8s.secrets.get(SECRET_KEY)?.data).not.toHaveProperty('elsewhere');

    k8s.failNext(10);
    const failed = await call(person(omar), 'PUT', credPath(), { token: TOKEN + 'x' });
    k8s.failNext(0);
    expect(failed.status).toBe(409);
    expect(failed.text).not.toContain(TOKEN);
    // the row still says the earlier token is set; nothing half-written
    expect(parsedDoc(k8s.secrets.get(SECRET_KEY)!.data!['widgets']!)).toMatchObject({ token: TOKEN });
    const list = ListProjectsResponse.parse((await call(person(omar), 'GET', '/api/teams/engineering/projects')).body).items;
    expect(list.find((p) => p.name === 'elsewhere')!.pushCredentialSetAt).toBeNull();
  });

  it('is dropped when the project points at another address, and removed with the project', async () => {
    const mk = await call(person(omar), 'POST', '/api/teams/engineering/projects', { name: 'gadgets', repoUrl: 'https://github.com/acme/gadgets' });
    const id = (mk.body['project'] as { id: string }).id;
    expect((await call(person(omar), 'PUT', `/api/teams/engineering/projects/${id}/push-credential`, { token: TOKEN })).status).toBe(200);
    expect(Object.keys(k8s.secrets.get(SECRET_KEY)!.data!).sort()).toEqual(['gadgets', 'widgets']);
    const moved = await call(person(omar), 'PATCH', `/api/teams/engineering/projects/${id}`, { repoUrl: 'https://github.com/acme/gadgets-2' });
    expect(Project.parse((moved.body as { project: unknown }).project).pushCredentialSetAt).toBeNull();
    expect(Object.keys(k8s.secrets.get(SECRET_KEY)!.data!)).toEqual(['widgets']);
    expect((await call(person(omar), 'PUT', `/api/teams/engineering/projects/${id}/push-credential`, { token: TOKEN })).status).toBe(200);
    expect((await call(person(omar), 'DELETE', `/api/teams/engineering/projects/${id}`)).status).toBe(200);
    expect(Object.keys(k8s.secrets.get(SECRET_KEY)!.data!)).toEqual(['widgets']);
  });
});

describe('a token never outlives or outruns its project', () => {
  it('a new project clears an old token of its name, and a project is not removed while its token cannot be', async () => {
    k8s.secrets.get(SECRET_KEY)!.data!['leftover'] = docB64('old-token-0123456789abcdef');
    const made = await call(person(omar), 'POST', '/api/teams/engineering/projects', { name: 'leftover', repoUrl: 'https://github.com/acme/leftover' });
    expect(made.status, made.text).toBe(201);
    expect(k8s.secrets.get(SECRET_KEY)!.data).not.toHaveProperty('leftover');
    const id = (made.body['project'] as { id: string }).id;
    expect((await call(person(omar), 'PUT', `/api/teams/engineering/projects/${id}/push-credential`, { token: TOKEN })).status).toBe(200);
    k8s.failNext(10);
    const refused = await call(person(omar), 'DELETE', `/api/teams/engineering/projects/${id}`);
    k8s.failNext(0);
    expect(refused.status).toBe(409);
    expect(ListProjectsResponse.parse((await call(person(omar), 'GET', '/api/teams/engineering/projects')).body).items.some((p) => p.name === 'leftover')).toBe(true);
    expect((await call(person(omar), 'DELETE', `/api/teams/engineering/projects/${id}`)).status).toBe(200);
    expect(k8s.secrets.get(SECRET_KEY)!.data).not.toHaveProperty('leftover');
  });
});

describe('a card that waits on a pull request', () => {
  const eventsOf = async (type: string, task: string): Promise<number> =>
    (await ownerSql<{ payload: { taskId: string } }>(server.db.ownerUrl, `SELECT payload FROM app.events WHERE type = $1`, [type])).filter((r) => r.payload.taskId === task).length;
  const claimsOf = async (task: string) => ownerSql<{ actor_id: string }>(server.db.ownerUrl, 'SELECT actor_id FROM app.task_claims WHERE task_id = $1 AND released_at IS NULL', [task]);
  const prState = async (task: string) => (await ownerSql<{ s: string | null }>(server.db.ownerUrl, 'SELECT pull_request_state AS s FROM app.tasks WHERE id = $1', [task]))[0]!.s;
  const recorded = async (title: string) => {
    const id = await ownedCard(title);
    const n = await openPull(id);
    expect(await record(bot, id, SHA, 'widgets', n)).toMatchObject({ o_outcome: 'recorded' });
    return { id, n };
  };

  it('records the pull request: the card waits on a person, keeps its owner and loses its claim, and only its owner may record', async () => {
    const id = await ownedCard('Fix the widget');
    const n = await openPull(id);
    const url = `${ORIGIN}/pull/${n}`;
    expect(await record(other, id, SHA, 'widgets', n)).toMatchObject({ o_outcome: 'not_owner' });
    expect(await record(bot, id, 'nothex')).toMatchObject({ o_outcome: 'tested_sha_required' });
    expect(await record(bot, id, 'b'.repeat(40), 'widgets', n, url, ORIGIN, `card-${id.slice(0, 8)}`, SHA)).toMatchObject({ o_outcome: 'sha_mismatch' });
    expect(await record(bot, id, SHA, 'widgets', n, url, ORIGIN, 'card-ffffffff')).toMatchObject({ o_outcome: 'wrong_branch' });
    expect(await record(bot, id, SHA, 'widgets', n, 'http://insecure.example/pull/1')).toMatchObject({ o_outcome: 'invalid_input' });
    expect(await record(bot, id, SHA, 'widgets', n, url, 'http://insecure.example/acme/widgets')).toMatchObject({ o_outcome: 'invalid_input' });
    expect(await record(bot, id, SHA, 'widgets', n, url)).toMatchObject({ o_outcome: 'recorded' });
    expect(await record(bot, id, SHA, 'widgets', n, url)).toMatchObject({ o_outcome: 'already_open' });

    expect(await card(id)).toMatchObject({
      state: 'waiting_on_person',
      ownerId: bot.actorId,
      testedSha: SHA,
      blockerReason: `Pull request #${n} waits for a person to merge it`,
      pullRequest: { project: 'widgets', number: n, url, state: 'open', mergeSha: null },
    });
    expect(await claimsOf(id)).toEqual([]);
    expect((await history(id)).map((e) => e.type)).toContain('pull_request_opened');
  });

  it('is done when the recorded pull request is merged, with the merge commit in its history; a closed one goes back to its owner with a live claim', async () => {
    const merged = await recorded('Merged one');
    const closed = await recorded('Closed one');
    const open = await recorded('Still open');

    await runSync();
    expect((await card(open.id)).state).toBe('waiting_on_person');
    expect((await card(merged.id)).state).toBe('waiting_on_person');
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(gh.calls.every((c) => c.authorized), 'every call carried the project’s token').toBe(true);

    const MERGE_SHA = 'b'.repeat(40);
    gh.merge(merged.n, MERGE_SHA);
    gh.close(closed.n);
    await runSync();

    const done = await card(merged.id);
    expect(done).toMatchObject({ state: 'done', blockerReason: '', pullRequest: { state: 'merged', mergeSha: MERGE_SHA } });
    expect(done.completedAt).not.toBeNull();
    const completed = (await history(merged.id)).find((e) => e.type === 'completed')!;
    expect(completed.data).toMatchObject({ mergeSha: MERGE_SHA, pullRequest: merged.n, testedSha: SHA });
    expect(completed.actorId).toBeNull();
    expect(await eventsOf('tasks.task.completed', merged.id)).toBe(1);

    expect(await card(closed.id)).toMatchObject({
      state: 'in_progress',
      ownerId: bot.actorId,
      blockerReason: `Pull request #${closed.n} was closed without being merged`,
      pullRequest: { state: 'closed', mergeSha: null },
    });
    expect((await claimsOf(closed.id)).map((c) => c.actor_id)).toEqual([bot.actorId]);
    expect((await history(closed.id)).find((e) => e.type === 'pull_request_closed')!.data).toMatchObject({ pullRequest: closed.n });
    expect((await card(open.id)).state).toBe('waiting_on_person');

    // a resolved card is not asked about again
    const asked = gh.calls.length;
    await runSync();
    expect(gh.calls.slice(asked).filter((c) => c.path.endsWith(`/pulls/${merged.n}`) || c.path.endsWith(`/pulls/${closed.n}`))).toEqual([]);
  });

  it('does not finish a card for a merge of another commit than the tested one: it goes back to its owner and says so', async () => {
    const c = await recorded('Moved after the test');
    gh.pulls.get(c.n)!.headSha = 'd'.repeat(40); // more commits were pushed to the branch after it was tested
    gh.merge(c.n, 'e'.repeat(40));
    await runSync();
    const t = await card(c.id);
    expect(t.state).toBe('in_progress');
    expect(t.state).not.toBe('done');
    expect(t.blockerReason).toContain('not at the tested commit');
    expect(await eventsOf('tasks.task.completed', c.id)).toBe(0);
  });

  it('stops following a card that moved on by another door: a person moving it on closes out the tracking, and a later merge changes nothing and adds no second completion', async () => {
    const c = await recorded('Moved on by a person meanwhile');
    const moved = await call(person(omar), 'PATCH', `/api/teams/engineering/tasks/${c.id}`, { state: 'in_progress' });
    expect(moved.status, moved.text).toBe(200);
    expect(await prState(c.id)).toBe('withdrawn');
    const done = await call(asBot(bot), 'POST', `/api/teams/engineering/tasks/${c.id}/complete`, { testedSha: SHA });
    expect(done.status, done.text).toBe(200);
    expect(await eventsOf('tasks.task.completed', c.id)).toBe(1);
    gh.merge(c.n, 'f'.repeat(40));
    await runSync().catch(() => undefined);
    expect((await card(c.id)).state).toBe('done');
    expect(await eventsOf('tasks.task.completed', c.id)).toBe(1);
    // the door itself also refuses to act on a pull request that is not open any more (a closed one never reopens a done card)
    const again = await ownerSql<{ o_outcome: string }>(server.db.ownerUrl, `SELECT * FROM app.tasks_resolve_pull_request($1::uuid, 'closed', NULL, 'late')`, [c.id]);
    expect(again[0]!.o_outcome).toBe('not_open');
    expect((await card(c.id)).state).toBe('done');
  });

  it('does not let a bot finish a card around its open pull request: the merge is the gate (a person still may move it by hand)', async () => {
    const c = await recorded('Bot tries to finish');
    const done = await call(asBot(bot), 'POST', `/api/teams/engineering/tasks/${c.id}/complete`, { testedSha: SHA });
    expect(done.status).toBe(409);
    expect(done.text).toContain('merges it');
    expect((await card(c.id)).state).toBe('waiting_on_person');
    expect(await prState(c.id)).toBe('open');
    // a bot's own board move to done is refused the same way (the door is shared)
    const moved = await withActor(
      { kind: 'bot', id: bot.actorId, workspaceId: KAHF_WORKSPACE_ID } as unknown as Parameters<typeof withActor>[0],
      async (tx) => (await tx.query<{ o_outcome: string }>('SELECT * FROM app.tasks_move($1::uuid, $2)', [c.id, 'done'])).rows[0]!,
      { pool: server.pools.app },
    );
    expect(moved.o_outcome).toBe('waiting_on_merge');
  });

  it('does not finish a card for a merge into another branch than the one recorded', async () => {
    const c = await recorded('Target moved');
    gh.pulls.get(c.n)!.base = 'next'; // retargeted after it was recorded
    gh.merge(c.n, 'e'.repeat(40));
    await runSync();
    const t = await card(c.id);
    expect(t.state).toBe('in_progress');
    expect(t.blockerReason).toContain('no longer the one recorded');
  });

  it('ties the project to the card: the project of the card’s channel, else the project of its first pull request', async () => {
    const ch = await call(person(omar), 'POST', '/api/teams/engineering/channels', { name: 'proj-chan' });
    expect(ch.status, ch.text).toBe(201);
    const channelId = (ch.body['channel'] as { id: string }).id;
    const mk = await call(person(omar), 'POST', '/api/teams/engineering/projects', { name: 'chanproj', repoUrl: 'https://github.com/acme/chanproj', channelId });
    expect(mk.status, mk.text).toBe(201);
    const msg = await call(person(omar), 'POST', `/api/channels/${channelId}/messages`, { channelId, body: 'work item', threadRootId: null });
    expect(msg.status, msg.text).toBe(201);
    const rootId = String(msg.body['id']);
    const id = await ownedCard('In a project channel');
    await ownerSql(server.db.ownerUrl, 'UPDATE app.tasks SET thread_root_id = $2 WHERE id = $1', [id, rootId]);
    expect(await record(bot, id, SHA, 'widgets', 7)).toMatchObject({ o_outcome: 'wrong_project' });
    expect(await record(bot, id, SHA, 'chanproj', 7)).toMatchObject({ o_outcome: 'recorded' });

    // a card with no channel link is bound to the project of its first pull request
    const free = await ownedCard('No channel');
    expect(await record(bot, free, SHA, 'widgets', 8)).toMatchObject({ o_outcome: 'recorded' });
    await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET pull_request_state = 'withdrawn', state = 'in_progress' WHERE id = $1`, [free]);
    expect(await record(bot, free, SHA, 'chanproj', 9)).toMatchObject({ o_outcome: 'wrong_project' });
  });

  it('records only the pull request’s final state when the card is not waiting any more, never reopening or completing it twice', async () => {
    const c = await recorded('Moved by a person');
    // simulate a card that is `done` while its pull request is still marked open (the trigger normally closes the tracking out: break the invariant on purpose)
    await ownerSql(server.db.ownerUrl, `ALTER TABLE app.tasks DISABLE TRIGGER tasks_withdraw_pull_request`);
    try {
      await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET state = 'done', completed_at = now() WHERE id = $1`, [c.id]);
    } finally {
      await ownerSql(server.db.ownerUrl, `ALTER TABLE app.tasks ENABLE TRIGGER tasks_withdraw_pull_request`);
    }
    const out = await ownerSql<{ o_outcome: string }>(server.db.ownerUrl, `SELECT * FROM app.tasks_resolve_pull_request($1::uuid, 'closed', NULL, 'closed late')`, [c.id]);
    expect(out[0]!.o_outcome).toBe('recorded_only');
    expect(await prState(c.id)).toBe('closed');
    expect((await card(c.id)).state).toBe('done');
    expect(await eventsOf('tasks.task.completed', c.id)).toBe(0);
  });

  it('does not use a token that was issued for another address than the one recorded on the card', async () => {
    const c = await recorded('Project moved');
    const key = SECRET_KEY;
    const before = k8s.secrets.get(key)!.data!['widgets']!;
    k8s.secrets.get(key)!.data!['widgets'] = docB64(TOKEN, 'https://github.com/acme/other');
    try {
      gh.merge(c.n, 'c'.repeat(40));
      const asked = gh.calls.length;
      await runSync();
      expect(gh.calls.slice(asked).filter((x) => x.path.endsWith(`/pulls/${c.n}`))).toEqual([]);
      expect((await card(c.id)).state).toBe('waiting_on_person');
    } finally {
      k8s.secrets.get(key)!.data!['widgets'] = before;
    }
  });

  it('backs off a project whose origin answers with a rate limit, and never logs the token', async () => {
    const c = await recorded('Rate limited');
    await ownerSql(server.db.ownerUrl, 'UPDATE app.tasks SET pull_request_checked_at = NULL WHERE id = $1', [c.id]);
    gh.failNext(429, { 'retry-after': '3600' }, 50);
    await runSync();
    const asked = gh.calls.length;
    expect(asked).toBeGreaterThan(0);
    await runSync();
    expect(gh.calls.length, 'a backed-off project is not asked again').toBe(asked);
    expect((await card(c.id)).state).toBe('waiting_on_person');
    expect(server.logs.join('\n')).not.toContain(TOKEN);
    expect(server.logs.join('\n')).toContain('next try in');
    gh.failNext(500, {}, 0);
  });

  it('may be released from the board by a person but not by a bot, while it waits on a person', async () => {
    const c = await recorded('Waiting');
    const byBot = await call(asBot(bot), 'POST', `/api/teams/engineering/tasks/${c.id}/release`);
    expect(byBot.status).toBe(409);
    expect(byBot.text).toContain('waiting_on_person');
    expect((await card(c.id)).state).toBe('waiting_on_person');
    const lead = await call(person(omar), 'POST', `/api/teams/engineering/tasks/${c.id}/release`);
    expect(lead.status, lead.text).toBe(200);
    expect(await card(c.id)).toMatchObject({ state: 'open', ownerId: null });
    expect(await prState(c.id)).toBe('withdrawn');
  });

  it('removing the token deletes the Secret when no project has one left', async () => {
    expect((await call(person(omar), 'DELETE', credPath())).status).toBe(200);
    expect(k8s.secrets.has(SECRET_KEY)).toBe(false);
    expect(Project.parse(((await call(person(omar), 'DELETE', credPath())).body as { project: unknown }).project).pushCredentialSetAt).toBeNull();
    expect(await dbText()).not.toContain(TOKEN);
  });
});
