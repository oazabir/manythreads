import { randomUUID } from 'node:crypto';
import {
  ClaimTaskResponse,
  CompleteTaskResponse,
  CreateTaskResponse,
  HandoffTaskResponse,
  ListTaskEventsResponse,
  ListTasksResponse,
  MoveTaskResponse,
  UpdateTaskResponse,
  DeployResponse,
} from '@manythreads/shared';
import {
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  createPersonas,
  ownerSql,
  personas,
  startTestServer,
  type Persona,
  type TestServer,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { nadia, rafi, priya, omar, sameera } = personas;
const TEAM = TEAM_IDS.Engineering;

let server: TestServer;
let coder: { botId: string; actorId: string };
let reviewer: { botId: string; actorId: string };

/** A bot with its actor and team membership, as the loader would leave it (a direct insert: the loader itself is tested elsewhere). */
async function makeBot(slug: string, mayTag: string[] = []): Promise<{ botId: string; actorId: string }> {
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
  if (mayTag.length > 0) {
    await ownerSql(
      server.db.ownerUrl,
      `INSERT INTO app.capability_grants (team_id, actor_id, capability, constraints) VALUES ($1, $2, 'tasks.handoff', $3::jsonb)`,
      [TEAM, actorId, JSON.stringify({ mayTag })],
    );
  }
  return { botId, actorId };
}

const call = async (who: Persona | { kind: 'bot'; actorId: string } | null, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = {};
  if (who && 'actorId' in who && 'kind' in who) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'bot', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID });
  else if (who) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: (who as Persona).actorId, workspaceId: KAHF_WORKSPACE_ID });
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};

const asBot = (bot: { actorId: string }) => ({ kind: 'bot' as const, actorId: bot.actorId });

/** The one message of an error response (`{ error: { code, message } }`), for an assertion that reads like the refusal. */
const messageOf = (body: Record<string, unknown> | null): string => String((body?.['error'] as { message?: unknown } | undefined)?.message ?? '');

async function createTask(overrides: Record<string, unknown> = {}) {
  const res = await call(nadia, 'POST', '/api/teams/engineering/tasks', {
    title: 'Fix the rota',
    branch: 'fix/rota',
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreateTaskResponse.parse(res.body).task;
}

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  coder = await makeBot('coder', ['reviewer']);
  reviewer = await makeBot('reviewer');
  await makeBot('stranger');
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('tasks API', () => {
  it('creates a card, lists it and reads it back', async () => {
    const task = await createTask({ priority: 'high' });
    expect(task.state).toBe('open');
    expect(task.ownerId).toBeNull();
    const list = ListTasksResponse.parse((await call(nadia, 'GET', '/api/teams/engineering/tasks?kind=code')).body);
    expect(list.items.map((t) => t.id)).toContain(task.id);
    const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
    expect(read.status).toBe(200);
    expect(ListTaskEventsResponse.parse((await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}/events`)).body).items.map((e) => e.type)).toEqual(['created']);
  });

  it('lets one claim win: the second caller gets already_owned and nothing changes', async () => {
    const task = await createTask();
    const [a, b] = await Promise.all([
      call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`),
      call(rafi, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(messageOf(loser.body)).toMatch(/already_owned/);
    const winner = a.status === 200 ? a : b;
    const claimed = ClaimTaskResponse.parse(winner.body);
    expect(claimed.task.ownerId).not.toBeNull();
    expect(claimed.task.state).toBe('in_progress');
    expect(new Date(claimed.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // Exactly one live claim row, and two attempts in the history.
    const live = await ownerSql(server.db.ownerUrl, 'SELECT count(*)::int AS n FROM app.task_claims WHERE task_id = $1 AND released_at IS NULL', [task.id]);
    expect(live[0]?.['n']).toBe(1);
  });

  it('lets the owner claim again: ok, the same single claim row, no second event', async () => {
    const task = await createTask();
    const first = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    expect(first.status).toBe(200);
    const again = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(ClaimTaskResponse.parse(again.body).task.ownerId).toBe(nadia.actorId);
    expect(ClaimTaskResponse.parse(again.body).expiresAt).toBe(ClaimTaskResponse.parse(first.body).expiresAt);
    const claims = await ownerSql(server.db.ownerUrl, 'SELECT count(*)::int AS n FROM app.task_claims WHERE task_id = $1', [task.id]);
    expect(claims[0]?.['n']).toBe(1);
    const events = ListTaskEventsResponse.parse((await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}/events`)).body).items;
    expect(events.filter((e) => e.type === 'claimed')).toHaveLength(1);
    // another person still gets already_owned
    expect((await call(rafi, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`)).status).toBe(409);
  });

  /** `app.tasks_actor_labels` as `asker` (workspace + actor settings set in the same statement, as a request would have them). */
  const labelsAs = (asker: string, ids: string[]) =>
    ownerSql(
      server.db.ownerUrl,
      `SELECT l.o_actor_id, l.o_kind, l.o_slug
         FROM (SELECT set_config('app.workspace_id', $1, true) AS w, set_config('app.actor_id', $2, true) AS a) c,
              LATERAL app.tasks_actor_labels($3::uuid[]) l WHERE c.w <> '' AND c.a <> '' ORDER BY l.o_kind`,
      [KAHF_WORKSPACE_ID, asker, ids],
    );

  it('names actors for the tasks.read tool: a bot by slug, a person by display name', async () => {
    const rows = await labelsAs(reviewer.actorId, [reviewer.actorId, nadia.actorId]);
    expect(rows.map((r) => [r['o_kind'], r['o_slug']])).toEqual([['bot', 'reviewer'], ['person', null]]);
  });

  it('names no actor the caller cannot already see (a member of another team, or one only in a team the caller cannot read)', async () => {
    // Sameera is in Customer support only; nadia and the engineering bots are in Engineering only.
    expect(await labelsAs(sameera.actorId, [nadia.actorId, coder.actorId])).toEqual([]);
    const own = await labelsAs(sameera.actorId, [sameera.actorId, nadia.actorId]);
    expect(own.map((r) => r['o_actor_id'])).toEqual([sameera.actorId]);
    expect(await labelsAs(nadia.actorId, [sameera.actorId])).toEqual([]);
  });

  it('refuses to complete a code card without a tested sha, then accepts one', async () => {
    const task = await createTask();
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const refused = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/complete`, {});
    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toMatch(/tested/);
    const done = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/complete`, { testedSha: 'abcdef1', summary: 'green' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const completed = CompleteTaskResponse.parse(done.body).task;
    expect(completed.state).toBe('done');
    expect(completed.testedSha).toBe('abcdef1');
    expect(completed.completedAt).not.toBeNull();
    const events = ListTaskEventsResponse.parse((await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}/events`)).body).items.map((e) => e.type);
    expect(events).toContain('completed');
  });

  it('blocks a completion whose base moved, with the reason', async () => {
    const task = await createTask();
    await ownerSql(server.db.ownerUrl, 'UPDATE app.tasks SET base_sha = $2 WHERE id = $1', [task.id, 'aaaaaaa']);
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const stale = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/complete`, { testedSha: 'abcdef1', branchHeadSha: 'bbbbbbb' });
    expect(stale.status).toBe(409);
    expect(messageOf(stale.body), JSON.stringify(stale.body)).toMatch(/rebased|behind|base_sha/);
    const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
    expect(String((read.body['task'] as Record<string, unknown>)['blockerReason'])).toContain('base_sha');
  });

  it('moves a card atomically and the old owner cannot act afterwards', async () => {
    const task = await createTask();
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const moved = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/handoff`, { toActorId: coder.actorId, mode: 'bot', note: 'build it' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const parsed = HandoffTaskResponse.parse(moved.body);
    expect(parsed.task.ownerId).toBe(coder.actorId);
    expect(parsed.task.state).toBe('in_progress');
    expect(parsed.task.handoffCount).toBe(1);
    expect(parsed.handoff.fromActorId).toBe(nadia.actorId);
    // The old owner is no longer the owner, so cannot complete it.
    const denied = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/complete`, { testedSha: 'abcdef1' });
    expect(denied.status).toBe(409);
    expect(messageOf(denied.body)).toMatch(/owner/);
    // The new owner can.
    const done = await call(asBot(coder), 'POST', `/api/teams/engineering/tasks/${task.id}/complete`, { testedSha: 'abcdef1' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  });

  it('rejects a bot handoff outside its used mayTag before any effect', async () => {
    const task = await createTask();
    await call(asBot(coder), 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const outside = await call(asBot(coder), 'POST', `/api/teams/engineering/tasks/${task.id}/handoff`, { toBotSlug: 'stranger', mode: 'bot' });
    expect(outside.status).toBe(403);
    expect(messageOf(outside.body)).toMatch(/mayTag/);
    // Nothing moved.
    const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
    expect((read.body['task'] as Record<string, unknown>)['ownerId']).toBe(coder.actorId);
    // A target the file does name is allowed.
    const inside = await call(asBot(coder), 'POST', `/api/teams/engineering/tasks/${task.id}/handoff`, { toBotSlug: 'reviewer', mode: 'bot' });
    expect(inside.status, JSON.stringify(inside.body)).toBe(200);
  });

  describe('the creator of an unowned card', () => {
    const create = async (who: Persona | { kind: 'bot'; actorId: string }) => {
      const res = await call(who, 'POST', '/api/teams/engineering/tasks', { title: 'Split me', branch: 'split/me' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return CreateTaskResponse.parse(res.body).task;
    };
    const hand = (who: Persona | { kind: 'bot'; actorId: string }, id: string, body: Record<string, unknown>) =>
      call(who, 'POST', `/api/teams/engineering/tasks/${id}/handoff`, body);

    it('hands its own unowned card to a mayTag target, and the card moves', async () => {
      const task = await create(asBot(coder));
      const moved = await hand(asBot(coder), task.id, { toBotSlug: 'reviewer', mode: 'bot' });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(HandoffTaskResponse.parse(moved.body).task).toMatchObject({ ownerId: reviewer.actorId, state: 'in_progress', handoffCount: 1 });
    });

    it('a member who did not create the card is refused, and the sentence says who may', async () => {
      const task = await create(asBot(coder));
      const denied = await hand(rafi, task.id, { toActorId: reviewer.actorId, mode: 'bot' });
      expect([403, 409]).toContain(denied.status);
      expect(messageOf(denied.body)).toMatch(/owner, a lead of its team, or its creator/);
      const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
      expect((read.body['task'] as Record<string, unknown>)['ownerId']).toBeNull();
    });

    it('the creator is refused once someone else owns the card', async () => {
      const task = await create(asBot(coder));
      expect((await call(rafi, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`)).status).toBe(200);
      const denied = await hand(asBot(coder), task.id, { toBotSlug: 'reviewer', mode: 'bot' });
      expect([403, 409]).toContain(denied.status);
      expect(messageOf(denied.body)).toMatch(/owner, a lead of its team, or its creator/);
    });

    it('a person who created an unowned card may hand it to a bot of the team or to themselves, never to another person', async () => {
      const task = await create(rafi);
      const toPerson = await hand(rafi, task.id, { toActorId: priya.actorId, mode: 'person' });
      expect([403, 409]).toContain(toPerson.status);
      expect(messageOf(toPerson.body)).toMatch(/yourself or to a bot of this team/);
      const still = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
      expect((still.body['task'] as Record<string, unknown>)['ownerId']).toBeNull();
      const toBot = await hand(rafi, task.id, { toActorId: reviewer.actorId, mode: 'bot' });
      expect(toBot.status, JSON.stringify(toBot.body)).toBe(200);
      const mine = await create(rafi);
      const toSelf = await hand(rafi, mine.id, { toActorId: rafi.actorId, mode: 'bot' });
      expect(toSelf.status, JSON.stringify(toSelf.body)).toBe(200);
    });

    it('a lead may still hand an unowned card to another person', async () => {
      const task = await create(rafi);
      const moved = await hand(omar, task.id, { toActorId: priya.actorId, mode: 'person' });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    });

    it('a bot may always hand a card back to the actor that created it, even when mayTag does not name it', async () => {
      // `worker` may tag only reviewer; the card was created by Nadia (a person) and handed to worker.
      const worker = await makeBot(`worker-${randomUUID().slice(0, 6)}`, ['reviewer']);
      const task = await create(nadia);
      expect((await hand(nadia, task.id, { toActorId: worker.actorId, mode: 'bot' })).status).toBe(200);
      const back = await hand(asBot(worker), task.id, { toActorId: nadia.actorId, mode: 'person', note: 'done' });
      expect(back.status, JSON.stringify(back.body)).toBe(200);
      expect(HandoffTaskResponse.parse(back.body).task).toMatchObject({ ownerId: nadia.actorId, state: 'waiting_on_person' });
    });

    it('still refuses a hand-over to someone who is neither in mayTag nor the creator, and says the card stayed', async () => {
      const worker = await makeBot(`worker-${randomUUID().slice(0, 6)}`, ['reviewer']);
      const task = await create(nadia);
      await hand(nadia, task.id, { toActorId: worker.actorId, mode: 'bot' });
      const refused = await hand(asBot(worker), task.id, { toActorId: coder.actorId, mode: 'bot' });
      expect(refused.status).toBe(403);
      expect(messageOf(refused.body)).toMatch(/not handed over/);
      expect(messageOf(refused.body)).toMatch(/still/);
      const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
      expect((read.body['task'] as Record<string, unknown>)['ownerId']).toBe(worker.actorId);
    });

    it('a bot creator is still bound by mayTag', async () => {
      const task = await create(asBot(coder));
      const outside = await hand(asBot(coder), task.id, { toBotSlug: 'stranger', mode: 'bot' });
      expect(outside.status).toBe(403);
      expect(messageOf(outside.body)).toMatch(/mayTag/);
      const read = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
      expect((read.body['task'] as Record<string, unknown>)['ownerId']).toBeNull();
    });
  });

  it('files a strict handoff in Approvals, refuses the requester, and applies it on approval', async () => {
    const task = await createTask();
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const pending = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/handoff`, {
      toActorId: reviewer.actorId,
      mode: 'bot',
      note: 'strict please',
      strict: true,
    });
    expect(pending.status, JSON.stringify(pending.body)).toBe(202);
    const parsed = HandoffTaskResponse.parse(pending.body);
    expect(parsed.pendingApproval).toBe(true);
    expect(parsed.approvalId).not.toBeNull();
    // The card has not moved yet.
    const before = await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`);
    expect((before.body['task'] as Record<string, unknown>)['ownerId']).toBe(nadia.actorId);
    // The requester can never decide their own request.
    const self = await call(nadia, 'POST', `/api/teams/engineering/approvals/${parsed.approvalId}/approve`, { note: '' });
    expect(self.status).toBe(403);
    // The team's lead can.
    const approved = await call(omar, 'POST', `/api/teams/engineering/approvals/${parsed.approvalId}/approve`, { note: 'go' });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    await expect
      .poll(async () => (await call(nadia, 'GET', `/api/teams/engineering/tasks/${task.id}`)).body['task'] as Record<string, unknown>, { timeout: 10_000 })
      .toMatchObject({ ownerId: reviewer.actorId, state: 'in_progress', handoffCount: 1 });
  });

  it('moves a card on the board only through the rules: a code card needs its tested sha to be done', async () => {
    const boardRes = await call(omar, 'POST', '/api/teams/engineering/boards', { name: 'Engineering' });
    expect(boardRes.status).toBe(201);
    const boardId = String((boardRes.body['board'] as Record<string, unknown>)['id']);
    const task = await createTask();
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    const blocked = await call(nadia, 'POST', `/api/teams/engineering/boards/${boardId}/move`, { taskId: task.id, to: 'done' });
    expect(blocked.status).toBe(409);
    expect(messageOf(blocked.body)).toMatch(/tested/);
    // Record the tested commit, then the drag is allowed.
    const patched = await call(nadia, 'PATCH', `/api/teams/engineering/tasks/${task.id}`, { testedSha: 'abcdef2' });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(UpdateTaskResponse.parse(patched.body).task.testedSha).toBe('abcdef2');
    const moved = await call(nadia, 'POST', `/api/teams/engineering/boards/${boardId}/move`, { taskId: task.id, to: 'done' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(MoveTaskResponse.parse(moved.body).task.state).toBe('done');
    // And an illegal transition is refused: nothing moves out of done.
    const reopen = await call(nadia, 'POST', `/api/teams/engineering/boards/${boardId}/move`, { taskId: task.id, to: 'open' });
    expect(reopen.status).toBe(409);
  });

  it('bounds rework at three, then asks for a person', async () => {
    const task = await createTask({ kind: 'content' });
    await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/claim`);
    // Hand it to a person: the note becomes the reason the card waits.
    const handed = await call(nadia, 'POST', `/api/teams/engineering/tasks/${task.id}/handoff`, { toActorId: priya.actorId, mode: 'person', note: 'please review' });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect(HandoffTaskResponse.parse(handed.body).task.state).toBe('waiting_on_person');
    for (let i = 0; i < 3; i++) {
      const r = await call(priya, 'POST', `/api/teams/engineering/tasks/${task.id}/rework`, { reason: `round ${i}` });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const fourth = await call(priya, 'POST', `/api/teams/engineering/tasks/${task.id}/rework`, { reason: 'again' });
    expect(fourth.status).toBe(409);
    expect(messageOf(fourth.body)).toMatch(/three times|bound/);
  });

  it('makes a protected deploy wait for someone other than the requester, and records it once approved', async () => {
    const envRes = await call(omar, 'POST', '/api/teams/engineering/environments', { name: 'production', protected: true });
    expect(envRes.status, JSON.stringify(envRes.body)).toBe(201);
    const envId = String((envRes.body['environment'] as Record<string, unknown>)['id']);
    const task = await createTask();
    const waiting = await call(nadia, 'POST', `/api/teams/engineering/environments/${envId}/deploy`, { taskId: task.id, summary: 'ship it' });
    expect(waiting.status).toBe(200);
    const parsed = DeployResponse.parse(waiting.body);
    expect(parsed.outcome).toBe('needs_approval');
    expect(parsed.approvalId).not.toBeNull();
    const self = await call(nadia, 'POST', `/api/teams/engineering/approvals/${parsed.approvalId}/approve`, { note: '' });
    expect(self.status).toBe(403);
    const approved = await call(omar, 'POST', `/api/teams/engineering/approvals/${parsed.approvalId}/approve`, { note: 'ok' });
    expect(approved.status).toBe(200);
    await expect
      .poll(async () => (await ownerSql(server.db.ownerUrl, 'SELECT count(*)::int AS n FROM app.deploys WHERE environment_id = $1', [envId]))[0]?.['n'], { timeout: 10_000 })
      .toBe(1);
    // A second deploy would need a fresh approval: the environment is still protected.
    const again = DeployResponse.parse((await call(nadia, 'POST', `/api/teams/engineering/environments/${envId}/deploy`, { taskId: task.id })).body);
    expect(again.outcome).toBe('needs_approval');
  });

  it('refuses a deploy outside the environment window', async () => {
    const tomorrow = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][(new Date().getUTCDay() + 1) % 7] as string;
    const envRes = await call(omar, 'POST', '/api/teams/engineering/environments', {
      name: 'staging',
      windows: [{ days: [tomorrow], from: '00:00', to: '23:59' }],
    });
    expect(envRes.status, JSON.stringify(envRes.body)).toBe(201);
    const envId = String((envRes.body['environment'] as Record<string, unknown>)['id']);
    const res = DeployResponse.parse((await call(nadia, 'POST', `/api/teams/engineering/environments/${envId}/deploy`, {})).body);
    expect(res.outcome).toBe('outside_window');
  });

  it('keeps another team out of Engineering cards', async () => {
    const task = await createTask();
    expect((await call(sameera, 'GET', '/api/teams/engineering/tasks')).status).toBe(403);
    expect((await call(sameera, 'GET', `/api/teams/engineering/tasks/${task.id}`)).status).toBe(403);
    expect((await call(sameera, 'POST', '/api/teams/engineering/tasks', { title: 'x', branch: 'y' })).status).toBe(403);
    // Priya is a member of Engineering, not a lead: she reads but cannot manage environments.
    expect((await call(priya, 'GET', '/api/teams/engineering/tasks')).status).toBe(200);
    expect((await call(priya, 'POST', '/api/teams/engineering/environments', { name: 'nope' })).status).toBe(403);
  });
});
