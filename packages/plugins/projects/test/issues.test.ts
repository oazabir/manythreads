import { randomUUID } from 'node:crypto';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startFakeGithub, startFakeK8s, startTestServer, type FakeGithub, type FakeK8s, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P35-04: a GitHub issue labelled `manythreads` becomes a thread in the project's channel and wakes the team's Engineer there; the issue is told once when
// the thread's card opens a pull request and once when it is merged. A real server and database; GitHub and Kubernetes (the token's Secret) are doubles.

const { omar } = personas;
const TEAM = TEAM_IDS.Engineering;
const TOKEN = 'github_pat_IssueTestToken0123456789abcdef'; // secret-scan:ignore (a fake token of the local GitHub double)
const ORIGIN = 'https://github.com/acme/widgets';
const ENV = ['MANYTHREADS_HERMES_PODS_TEST_K8S_URL', 'MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW', 'MANYTHREADS_TEST_GITHUB_API'];
const saved: Record<string, string | undefined> = {};

let server: TestServer;
let gh: FakeGithub;
let k8s: FakeK8s;
let projectId = '';
let channelId = '';
let engineerId = '';

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: omar.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
}

const passes = (): number => server.logs.filter((l) => /projects issues:/.test((JSON.parse(l) as { msg?: string }).msg ?? '')).length;
/** Runs the sync job once and waits for it to have logged (it logs only when it did something; `want` lines more than before). */
async function sync(want: number): Promise<void> {
  const before = passes();
  await ownerSql(server.db.ownerUrl, `SELECT (app.enqueue_job('projects.issue-sync', '{}'::jsonb, NULL, NULL)).id`);
  await ownerSql(server.db.ownerUrl, `SELECT pg_notify('manythreads_jobs', 'projects.issue-sync')`);
  const deadline = Date.now() + 20_000;
  while (passes() < before + want && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
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
  // the team's Engineer (its triggers do not matter: the issue's event wakes it by name)
  const botId = randomUUID();
  engineerId = botId;
  await ownerSql(server.db.ownerUrl, `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, $3, 'engineer', 'Engineer', 'agent', 'hermes', 'team', $4, 'active')`, [botId, KAHF_WORKSPACE_ID, TEAM, 'a'.repeat(64)]);
  const botActor = randomUUID();
  await ownerSql(server.db.ownerUrl, `INSERT INTO app.actors (id, kind, workspace_id, ref_id) VALUES ($1, 'bot', $2, $3)`, [botActor, KAHF_WORKSPACE_ID, botId]);
  await ownerSql(server.db.ownerUrl, `INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [TEAM, botActor, KAHF_WORKSPACE_ID]);
  const ch = await call('POST', '/api/teams/engineering/channels', { name: 'widgets' });
  expect(ch.status, ch.text).toBe(201);
  channelId = (ch.body['channel'] as { id: string }).id;
  const made = await call('POST', '/api/teams/engineering/projects', { name: 'widgets', repoUrl: ORIGIN, channelId });
  expect(made.status, made.text).toBe(201);
  projectId = (made.body['project'] as { id: string }).id;
  const set = await call('PUT', `/api/teams/engineering/projects/${projectId}/push-credential`, { username: 'octocat', token: TOKEN });
  expect(set.status, set.text).toBe(200);
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

describe('an issue given to the bots', () => {
  it('becomes one thread in the project channel and wakes the Engineer there; an unlabelled issue and a pull request do not', async () => {
    gh.issues.set(7, { number: 7, title: 'The widget list forgets its sort', body: 'Sort by name, reload: the list is unsorted.', state: 'open', labels: ['manythreads', 'bug'], comments: [] });
    gh.issues.set(8, { number: 8, title: 'Not for the bots', body: '', state: 'open', labels: ['bug'], comments: [] });
    gh.issues.set(9, { number: 9, title: 'A pull request', body: '', state: 'open', labels: ['manythreads'], pullRequest: true, comments: [] });
    await sync(1);
    const rows = await ownerSql<{ number: number; root_message_id: string | null }>(server.db.ownerUrl, 'SELECT number, root_message_id FROM app.project_issues WHERE project_id = $1', [projectId]);
    expect(rows.map((r) => r.number)).toEqual([7]);
    const root = rows[0]!.root_message_id!;
    const msg = (await ownerSql<{ channel_id: string; body: string; thread_root_id: string | null }>(server.db.ownerUrl, 'SELECT channel_id, body, thread_root_id FROM app.messages WHERE id = $1', [root]))[0]!;
    expect(msg).toMatchObject({ channel_id: channelId, thread_root_id: null });
    expect(msg.body).toContain('GitHub issue #7 of widgets: The widget list forgets its sort');
    expect(msg.body).toContain('https://github.com/acme/widgets/issues/7');
    // the Engineer is woken in that thread, on behalf of the person who connected the project
    await expect
      .poll(async () => (await ownerSql<{ payload: Record<string, unknown> }>(server.db.ownerUrl, "SELECT payload FROM app.jobs WHERE queue = 'runtime-hermes.run' AND payload->>'botId' = $1", [engineerId]))[0]?.payload, { timeout: 10_000 })
      .toMatchObject({ replyRootId: root, channelId, trigger: 'mention', askerActorId: omar.actorId });

    // a second pass takes nothing again
    await sync(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect((await ownerSql(server.db.ownerUrl, 'SELECT 1 FROM app.project_issues WHERE project_id = $1', [projectId])).length).toBe(1);
  });

  it('tells the issue once when the thread’s card opens a pull request, and once when it is merged', async () => {
    const root = (await ownerSql<{ root_message_id: string }>(server.db.ownerUrl, 'SELECT root_message_id FROM app.project_issues WHERE number = 7'))[0]!.root_message_id;
    const task = randomUUID();
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.tasks (id, workspace_id, team_id, title, kind, branch, thread_root_id, created_by, state, tested_sha,
                              pull_request_project, pull_request_number, pull_request_url, pull_request_state, pull_request_origin, pull_request_head_ref, pull_request_head_sha, pull_request_base_ref)
       VALUES ($1, $2, $3, 'Fix the sort', 'code', $4, $5, $6, 'waiting_on_person', $7, 'widgets', 31, $8, 'open', $9, $4, $7, 'main')`,
      [task, KAHF_WORKSPACE_ID, TEAM, `card-${task.slice(0, 8)}`, root, omar.actorId, 'b'.repeat(40), `${ORIGIN}/pull/31`, ORIGIN],
    );
    await sync(0);
    await expect.poll(() => gh.issues.get(7)!.comments.length, { timeout: 10_000 }).toBe(1);
    expect(gh.issues.get(7)!.comments[0]).toContain('Pull request #31');
    await sync(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(gh.issues.get(7)!.comments).toHaveLength(1);
    await ownerSql(server.db.ownerUrl, `UPDATE app.tasks SET pull_request_state = 'merged', state = 'done', completed_at = now() WHERE id = $1`, [task]);
    await sync(0);
    await expect.poll(() => gh.issues.get(7)!.comments.length, { timeout: 10_000 }).toBe(2);
    expect(gh.issues.get(7)!.comments[1]).toContain('merged in pull request #31');
    expect((await ownerSql<{ state: string }>(server.db.ownerUrl, 'SELECT state FROM app.project_issues WHERE number = 7'))[0]!.state).toBe('done');
    expect(server.logs.join('\n')).not.toContain(TOKEN);
  });
});
