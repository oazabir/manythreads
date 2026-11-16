import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type World } from '../../channels/test/world.ts';

// P10-01: the setup checklist's own state through the real server. What it proves: only admins read or change it, a mark takes only the kind its
// step allows and can be taken back, the first goal is recorded once, the checklist cannot be put away before that goal, and each change writes
// one event with ids and short codes only.

const { omar, nadia, priya } = personas;
vi.setConfig({ testTimeout: 60_000 });

interface StateBody {
  state: {
    marks: Array<{ step: string; kind: string; refId: string | null }>;
    launch: { teamId: string; channelId: string; at: string; messageId: string | null } | null;
    dismissedAt: string | null;
  };
}

let world: World;
let teamId = '';
const channelId = '11111111-1111-4111-8111-111111111111';

const get = (who = omar) => world.call<StateBody>(who, 'GET', '/api/workspace/onboarding');
let since = new Date(0);
/** The events of this type written during the current test (the event log is append-only, so tests count from a mark instead of clearing it). */
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND occurred_at >= $2 ORDER BY id`, [type, since]))).rows.map((r) => r.payload);

const SHA = 'a'.repeat(64);

/** A runner row as the Runners page would leave it (ready, on, the place bots run), for the proof's checks. */
async function makeRunner(over: Partial<{ name: string; kind: string; enabled: boolean; status: string; isDefault: boolean }> = {}): Promise<string> {
  const v = { name: 'hermes', kind: 'hermes_pod', enabled: true, status: 'ready', isDefault: true, ...over };
  return world.system(async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, is_default, status) VALUES ($1, $2, $2, $3, $4, $5, $6) RETURNING id`,
        [omar.workspaceId, v.name, v.kind, v.enabled, v.isDefault, v.status],
      )
    ).rows[0]!.id,
  );
}

/**
 * What the Test action leaves when a bot answered the admin's real question: the question (his own message and a rehearsal row), the run that finished,
 * and a reply in the thread from somebody else. `answered: false` leaves a question the run has not finished.
 */
async function leaveTestAnswer(opts: { answered?: boolean; reply?: boolean } = {}): Promise<void> {
  const answered = opts.answered ?? true;
  await ensureChannels(world);
  const dev = await world.channelId('engineering', 'dev');
  const q = await world.call<{ id: string }>(omar, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'Say hello', threadRootId: null });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  if (opts.reply ?? answered) {
    const a = await world.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'Hello', threadRootId: q.body.id });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
  }
  await world.system(async (tx) => {
    const bot = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'brain-' || substr(md5(random()::text), 1, 6), 'agent', 'hermes', 'team', $3, 'active') RETURNING id`,
        [omar.workspaceId, teamId, SHA],
      )
    ).rows[0]!.id;
    await tx.query('INSERT INTO app.rehearsal_questions (message_id, workspace_id, team_id, bot_id, asked_by) VALUES ($1, $2, $3, $4, $5)', [
      q.body.id,
      omar.workspaceId,
      teamId,
      bot,
      omar.actorId,
    ]);
    await tx.query(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status, rehearsal, reply_root_id, ended_at)
       VALUES ($1, $2, $3, 'conversation', $4, $5, true, $6, CASE WHEN $5 = 'done' THEN now() END)`,
      [omar.workspaceId, bot, teamId, omar.actorId, answered ? 'done' : 'running', q.body.id],
    );
  });
}

beforeAll(async () => {
  world = await createWorld();
  teamId = await world.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`)).rows[0]!.id);
}, 120_000);

afterAll(async () => {
  await world?.close();
});

// Every test starts from a fresh install.
beforeEach(async () => {
  await world.system(async (tx) => {
    await tx.query('DELETE FROM app.onboarding_marks');
    await tx.query('DELETE FROM app.onboarding_state');
    await tx.query('DELETE FROM app.rehearsal_questions');
    await tx.query('DELETE FROM app.bot_runs');
    await tx.query('DELETE FROM app.bot_runners');
  });
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
});

describe('seedFinishedSetup', () => {
  it('puts the seeded workspace away for the e2e servers, and createPersonas alone leaves a fresh install (the live demo seed uses it)', async () => {
    const { createPersonas, seedFinishedSetup } = await import('@manythreads/test-utils');
    await createPersonas(world.server.db);
    expect((await get()).body.state).toEqual({ marks: [], launch: null, dismissedAt: null, dismissedBy: null });
    await seedFinishedSetup(world.server.db);
    await seedFinishedSetup(world.server.db);
    const res = await get();
    expect(res.body.state.dismissedAt).not.toBeNull();
    expect(res.body.state.launch).not.toBeNull();
  });
});

describe('GET /api/workspace/onboarding', () => {
  it('reads as empty on a fresh install', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.state).toEqual({ marks: [], launch: null, dismissedAt: null, dismissedBy: null });
  });

  it('is for owners and admins only', async () => {
    expect((await get(nadia)).status).toBe(403);
    expect((await get(priya)).status).toBe(403);
    expect((await world.call(null, 'GET', '/api/workspace/onboarding')).status).toBe(401);
  });
});

describe('marks', () => {
  it('sets aside an optional step, confirms password-only sign-in, and takes either back', async () => {
    const skipped = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped' });
    expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
    const acked = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/signin', { kind: 'acknowledged' });
    expect(acked.body.state.marks.map((m) => `${m.step}:${m.kind}`).sort()).toEqual(['code:skipped', 'signin:acknowledged']);

    const cleared = await world.call<StateBody>(omar, 'DELETE', '/api/workspace/onboarding/marks/code');
    expect(cleared.body.state.marks.map((m) => m.step)).toEqual(['signin']);
    expect((await events('onboarding.step.marked')).map((e) => [e['step'], e['kind']])).toEqual([
      ['code', 'skipped'],
      ['signin', 'acknowledged'],
      ['code', null],
    ]);
  });

  it('writes one event per real change: repeating a mark or clearing nothing is silent', async () => {
    for (let i = 0; i < 3; i++) await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/servers', { kind: 'skipped' });
    await world.call(omar, 'DELETE', '/api/workspace/onboarding/marks/infrastructure');
    expect(await events('onboarding.step.marked')).toHaveLength(1);
  });

  it('takes only the kind a step allows, and only steps that are decisions', async () => {
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/signin', { kind: 'skipped' })).status).toBe(409);
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'acknowledged' })).status).toBe(409);
    // models, teams and bots are facts: they cannot be marked, so they cannot be skipped around
    for (const step of ['models', 'teams', 'bots', 'launch', 'bootstrap', 'organization']) {
      expect((await world.call(omar, 'PUT', `/api/workspace/onboarding/marks/${step}`, { kind: 'skipped' })).status, step).toBe(400);
    }
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped', extra: 1 })).status).toBe(400);
    expect((await get()).body.state.marks).toEqual([]);
  });

  it('keeps the look as a confirmation, and refuses a set-aside for it', async () => {
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/theme', { kind: 'skipped' })).status).toBe(409);
    const kept = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/theme', { kind: 'acknowledged' });
    expect(kept.body.state.marks).toMatchObject([{ step: 'theme', kind: 'acknowledged', refId: null }]);
    expect((await events('onboarding.step.marked')).map((e) => [e['step'], e['kind']])).toEqual([['theme', 'acknowledged']]);
  });

  it('records a runner that answered a test with its id, and the latest one wins', async () => {
    const one = await makeRunner({ name: 'one' });
    const two = await makeRunner({ name: 'two', isDefault: false });
    await leaveTestAnswer();
    // a proof must say what was checked, and a decision must not
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked' })).status).toBe(409);
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'skipped' })).status).toBe(409);
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped', refId: one })).status).toBe(409);
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: 'nope' })).status).toBe(400);
    await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: one });
    await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: one });
    // the second becomes the place bots run, then it is accepted too
    await world.system(async (tx) => {
      await tx.query('UPDATE app.bot_runners SET is_default = false WHERE id = $1', [one]);
      await tx.query('UPDATE app.bot_runners SET is_default = true WHERE id = $1', [two]);
    });
    const second = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: two });
    expect(second.body.state.marks).toMatchObject([{ step: 'runners', kind: 'checked', refId: two }]);
    // the same proof twice writes one event; a different runner writes another
    expect((await events('onboarding.step.marked')).map((e) => [e['step'], e['kind']])).toEqual([['runners', 'checked'], ['runners', 'checked']]);
    expect((await world.call<StateBody>(omar, 'DELETE', '/api/workspace/onboarding/marks/runners')).body.state.marks).toEqual([]);
  });

  it('refuses a runner proof the server cannot verify: an invented id, a runner that is off or not ready, one nobody asked, one without a real answer', async () => {
    const mark = (refId: string) => world.call<{ error?: { message?: string }; message?: string }>(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId });
    const refused = async (refId: string, why: RegExp): Promise<void> => {
      const res = await mark(refId);
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(why);
      expect((await get()).body.state.marks).toEqual([]);
    };
    await leaveTestAnswer();
    const fresh = async (over: Parameters<typeof makeRunner>[0]): Promise<string> => {
      await world.system((tx) => tx.query('DELETE FROM app.bot_runners WHERE workspace_id = $1', [omar.workspaceId]));
      return makeRunner(over);
    };
    // a well-formed id that is no runner of this workspace
    await refused('33333333-3333-4333-8333-333333333333', /does not exist/);
    // a runner of another workspace reads as none
    const otherWorkspace = await world.system(async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (name, slug) VALUES ('Elsewhere', 'elsewhere') RETURNING id`)).rows[0]!.id;
      return (
        await tx.query<{ id: string }>(`INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, is_default, status) VALUES ($1, 'far', 'far', 'hermes_pod', true, true, 'ready') RETURNING id`, [ws])
      ).rows[0]!.id;
    });
    await refused(otherWorkspace, /does not exist/);
    await refused(await fresh({ name: 'off', enabled: false }), /not switched on and ready/);
    await refused(await fresh({ name: 'starting', status: 'starting' }), /not switched on and ready/);
    await refused(await fresh({ name: 'model', kind: 'llm_gateway' }), /cannot be tried here/);
    await refused(await fresh({ name: 'spare', isDefault: false }), /place bots run/);
  });

  it('refuses a ready runner when no bot has answered a real question: none asked, one still running, one answered by nobody, or the answer is another admin\'s', async () => {
    const mark = (refId: string) => world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId });
    const runner = await makeRunner();
    expect((await mark(runner)).status).toBe(409);
    await leaveTestAnswer({ answered: false });
    expect((await mark(runner)).status).toBe(409);
    await world.system((tx) => tx.query('DELETE FROM app.rehearsal_questions'));
    await leaveTestAnswer({ reply: false });
    expect((await mark(runner)).status).toBe(409);
    // a question another person asked does not count for this admin
    await world.system((tx) => tx.query('DELETE FROM app.bot_runs'));
    await world.system((tx) => tx.query('DELETE FROM app.rehearsal_questions'));
    await leaveTestAnswer();
    await world.system((tx) => tx.query('UPDATE app.rehearsal_questions SET asked_by = $1', [nadia.actorId]));
    expect((await mark(runner)).status).toBe(409);
    expect((await get()).body.state.marks).toEqual([]);
  });

  it('starts the first delivery with the thread it watches, or sets it aside', async () => {
    const root = '55555555-5555-4555-8555-555555555555';
    const started = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/delivery', { kind: 'started', refId: root });
    expect(started.body.state.marks).toMatchObject([{ step: 'delivery', kind: 'started', refId: root }]);
    await world.call(omar, 'DELETE', '/api/workspace/onboarding/marks/delivery');
    const aside = await world.call<StateBody>(omar, 'PUT', '/api/workspace/onboarding/marks/delivery', { kind: 'skipped' });
    expect(aside.body.state.marks).toMatchObject([{ step: 'delivery', kind: 'skipped', refId: null }]);
  });

  it('is for admins only', async () => {
    expect((await world.call(nadia, 'PUT', '/api/workspace/onboarding/marks/code', { kind: 'skipped' })).status).toBe(403);
    expect((await world.call(nadia, 'DELETE', '/api/workspace/onboarding/marks/code')).status).toBe(403);
  });
});

describe('launch and dismiss', () => {
  it('refuses to put the checklist away before the first goal was sent', async () => {
    const res = await world.call<{ code?: string; error?: { code?: string } }>(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(res.status).toBe(409);
    expect((await get()).body.state.dismissedAt).toBeNull();
    expect(await events('onboarding.checklist.dismissed')).toEqual([]);
  });

  it('records the first goal once, and only as ids', async () => {
    const first = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.state.launch).toMatchObject({ teamId, channelId });
    const again = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId: '22222222-2222-4222-8222-222222222222' });
    expect(again.body.state.launch?.channelId).toBe(channelId);
    const logged = await events('onboarding.goal.launched');
    expect(logged).toHaveLength(1);
    const keys = Object.keys(logged[0] ?? {});
    expect(keys).toEqual(expect.arrayContaining(['teamId', 'channelId']));
    for (const key of keys) expect(['at', 'channelId', 'launchedBy', 'schemaVersion', 'teamId', 'type', 'workspaceId']).toContain(key);
  });

  it('remembers the question the wizard watches, and moves it to a later question without a second launch', async () => {
    const q1 = '66666666-6666-4666-8666-666666666666';
    const q2 = '77777777-7777-4777-8777-777777777777';
    const first = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId, messageId: q1 });
    expect(first.body.state.launch?.messageId).toBe(q1);
    const later = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId, messageId: q2 });
    expect(later.body.state.launch).toMatchObject({ channelId, messageId: q2 });
    expect(await events('onboarding.goal.launched')).toHaveLength(1);
  });

  it('refuses to put the checklist away without a working runner, even after the first goal', async () => {
    await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId });
    // no runner mark at all
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(409);
    // a proof, then the runner is switched off: the proof no longer counts
    const runner = await makeRunner();
    await leaveTestAnswer();
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: runner })).status).toBe(200);
    await world.system((tx) => tx.query('UPDATE app.bot_runners SET enabled = false WHERE id = $1', [runner]));
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(409);
    await world.system((tx) => tx.query(`UPDATE app.bot_runners SET enabled = true, status = 'needs_sign_in' WHERE id = $1`, [runner]));
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(409);
    // a proof that points at a runner that was removed
    await world.system((tx) => tx.query('DELETE FROM app.bot_runners WHERE id = $1', [runner]));
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(409);
    expect((await get()).body.state.dismissedAt).toBeNull();
    expect(await events('onboarding.checklist.dismissed')).toEqual([]);
  });

  it('puts the checklist away after the launch and a proven runner, once', async () => {
    const runner = await makeRunner();
    await leaveTestAnswer();
    expect((await world.call(omar, 'PUT', '/api/workspace/onboarding/marks/runners', { kind: 'checked', refId: runner })).status).toBe(200);
    await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId });
    const done = await world.call<StateBody>(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.state.dismissedAt).not.toBeNull();
    await world.call(omar, 'POST', '/api/workspace/onboarding/dismiss');
    expect(await events('onboarding.checklist.dismissed')).toHaveLength(1);
  });

  it('is for admins only, and a malformed body is refused', async () => {
    expect((await world.call(nadia, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId })).status).toBe(403);
    expect((await world.call(nadia, 'POST', '/api/workspace/onboarding/dismiss')).status).toBe(403);
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId: 'nope', channelId })).status).toBe(400);
    expect((await world.call(omar, 'POST', '/api/workspace/onboarding/launch', { teamId, channelId, text: 'hello' })).status).toBe(400);
  });
});
