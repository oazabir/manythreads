import { randomUUID } from 'node:crypto';
import {
  ChangeActionItemResponse,
  CreatePersonalRoutineResponse,
  DraftPersonalRoutineResponse,
  ListActionItemsResponse,
  ListPersonalRoutineRunsResponse,
  ListPersonalRoutinesResponse,
  RoutineWorkspaceSettings,
  personalRecipeById,
  recipeToDraft,
  RunPersonalRoutineResponse,
  UpdatePersonalRoutineResponse,
  type PersonalRoutine,
} from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-10 to P20-14, P20-11, P20-12: a person's own routines end to end through the HTTP API and the tick job: set up in words (a proposal, nothing saved), confirm, the
// routine file in the person's own files, run now, the guards (gap, in-flight, month's allowance, quiet hours, a bot that went away) and the action-items list.

const { omar, nadia, sameera, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let server: TestServer;
let botId: string;
let botActorId: string;

const call = async (who: Persona, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: KAHF_WORKSPACE_ID }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> };
};
const messageOf = (body: Record<string, unknown> | null): string => String((body?.['error'] as { message?: unknown } | undefined)?.message ?? '');
const sql = (q: string, params: unknown[] = []) => ownerSql(server.db.ownerUrl, q, params);

/** Run the tick job, then the job that tells owners about stops, once each, and wait until both have finished. */
async function tick(): Promise<void> {
  for (const queue of ['scheduled-jobs.tick', 'scheduled-jobs.tell-stops']) {
    const id = String((await sql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ($1, '{}'::jsonb, now()) RETURNING id`, [queue]))[0]!['id']);
    for (let i = 0; ; i += 1) {
      const state = String((await sql('SELECT state FROM app.jobs WHERE id = $1', [id]))[0]?.['state']);
      if (state === 'done') break;
      if (state === 'dead' || i > 150) throw new Error(`the ${queue} job ended as ${state}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const goodBody = (name: string, extra: Record<string, unknown> = {}) => ({
  confirmed: true,
  name,
  words: `${name} please`,
  botSlug: 'pulse',
  schedule: '0 5 * * 1-5',
  scheduleWords: 'Weekdays at 9:00 AM',
  timeZone: 'Asia/Dubai',
  prompt: 'Write me a short summary of what changed.',
  sources: [],
  outputMode: 'replace',
  ...extra,
});

async function make(who: Persona, name: string, extra: Record<string, unknown> = {}): Promise<PersonalRoutine> {
  const res = await call(who, 'POST', '/api/me/scheduled-jobs', goodBody(name, extra));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CreatePersonalRoutineResponse.parse(res.body).routine;
}

const routineRow = async (id: string) => (await sql('SELECT * FROM app.scheduled_jobs WHERE id = $1', [id]))[0]!;
const runsOf = (id: string) => sql('SELECT * FROM app.scheduled_job_runs WHERE scheduled_job_id = $1 ORDER BY id', [id]);
const due = (id: string) => sql(`UPDATE app.scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  botId = randomUUID();
  await sql(
    `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, 'pulse', 'Pulse', 'Keeps watch', 'agent', 'hermes', 'team', $4, 'active')`,
    [botId, KAHF_WORKSPACE_ID, ENG, 'd'.repeat(64)],
  );
  botActorId = String((await sql(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [KAHF_WORKSPACE_ID, botId]))[0]!['id']);
  // the bot asks to read a person's Personal space, and omar and nadia say yes
  await sql(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [ENG, botActorId]);
  for (const p of [omar, nadia]) await sql(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [p.personId, botId, KAHF_WORKSPACE_ID]);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('setting up in words', () => {
  it('proposes a routine and saves nothing', async () => {
    const before = ListPersonalRoutinesResponse.parse((await call(omar, 'GET', '/api/me/scheduled-jobs')).body).items.length;
    const res = await call(omar, 'POST', '/api/me/scheduled-jobs/draft', { sentence: 'Every weekday at 8am summarise my unread mail', timeZone: 'Asia/Dubai' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const parsed = DraftPersonalRoutineResponse.parse(res.body);
    expect(parsed.draft.schedule).toBe('0 4 * * 1-5'); // 8:00 in Dubai is 04:00 UTC
    expect(parsed.draft.scheduleWords.toLowerCase()).toContain('8');
    expect(parsed.draft.sources).toContain('mail');
    expect(parsed.draft.outputPath.startsWith('Routines/')).toBe(true);
    expect(ListPersonalRoutinesResponse.parse((await call(omar, 'GET', '/api/me/scheduled-jobs')).body).items.length).toBe(before);
  });

  it('refuses a request for a routine that was not confirmed', async () => {
    const unconfirmed: Record<string, unknown> = goodBody('Not confirmed');
    delete unconfirmed['confirmed'];
    expect((await call(omar, 'POST', '/api/me/scheduled-jobs', unconfirmed)).status).toBe(400);
  });

  it('keeps guests out', async () => {
    expect((await call(lena, 'POST', '/api/me/scheduled-jobs/draft', { sentence: 'Every morning tell me the news', timeZone: 'Asia/Dubai' })).status).toBe(403);
    expect((await call(lena, 'GET', '/api/me/scheduled-jobs')).status).toBe(403);
  });
});

describe('making, changing and removing a routine', () => {
  it('saves the routine file in the owner\'s own files and the routine is private to the owner', async () => {
    const routine = await make(omar, 'Morning notes');
    expect(routine.enabled).toBe(true);
    expect(routine.nextRunAt).not.toBeNull();
    expect(routine.botSlug).toBe('pulse');
    const files = await sql(`SELECT f.name FROM app.files f WHERE f.owner_person_id = $1 AND f.folder_path || f.name = $2`, [omar.personId, routine.contractPath]);
    expect(files).toHaveLength(1);
    // a conversation of the owner with the bot exists, which is what makes the run a private one
    const conv = await sql(`SELECT 1 FROM app.channels WHERE kind = 'bot_conversation' AND bot_id = $1 AND created_by = $2`, [botId, omar.actorId]);
    expect(conv).toHaveLength(1);
    expect(ListPersonalRoutinesResponse.parse((await call(nadia, 'GET', '/api/me/scheduled-jobs')).body).items.map((r) => r.id)).not.toContain(routine.id);
    expect((await call(nadia, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { enabled: false })).status).toBe(404);
    expect((await call(nadia, 'DELETE', `/api/me/scheduled-jobs/${routine.id}`)).status).toBe(404);
  });

  it('refuses a schedule faster than every fifteen minutes, a time zone that does not exist, and a bot the person cannot ask', async () => {
    expect(messageOf((await call(omar, 'POST', '/api/me/scheduled-jobs', goodBody('Too fast', { schedule: '*/5 * * * *' }))).body)).toMatch(/15 minutes/);
    expect((await call(omar, 'POST', '/api/me/scheduled-jobs', goodBody('Odd zone', { timeZone: 'Mars/Olympus' }))).status).toBe(400);
    // sameera is not on Engineering, so she cannot use its bot
    expect((await call(sameera, 'POST', '/api/me/scheduled-jobs', goodBody('Not mine'))).status).toBe(404);
  });

  it('says in plain words when the bot may not read the person\'s space', async () => {
    const res = await call(sameera, 'POST', '/api/me/scheduled-jobs', goodBody('No bot', { botSlug: 'does-not-exist' }));
    expect(res.status).toBe(404);
    // a member of Engineering who has not said yes to the bot
    const rafiLike = personas.rafi;
    const refused = await call(rafiLike, 'POST', '/api/me/scheduled-jobs', goodBody('No yes'));
    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toMatch(/Personal space/);
  });

  it('rewrites the routine file on a change and clears a stop when it is turned on again', async () => {
    const routine = await make(nadia, 'Weekly digest');
    const changed = await call(nadia, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { prompt: 'Make the digest shorter.', schedule: '0 6 * * 1', scheduleWords: 'Mondays at 10:00 AM' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(UpdatePersonalRoutineResponse.parse(changed.body).routine.schedule).toBe('0 6 * * 1');
    const versions = await sql(
      `SELECT count(*)::int AS n FROM app.file_versions v JOIN app.files f ON f.id = v.file_id WHERE f.owner_person_id = $1 AND f.folder_path || f.name = $2`,
      [nadia.personId, routine.contractPath],
    );
    expect(Number(versions[0]!['n'])).toBe(1);
    // the bot is switched off: the platform stops the routine on its next turn, and a person cannot turn it on while the bot is off
    await sql(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [botId]);
    await due(routine.id);
    await tick();
    const stopped = await routineRow(routine.id);
    expect(stopped['enabled']).toBe(false);
    expect(stopped['stopped_reason']).toBe('bot_off');
    const blocked = await call(nadia, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { enabled: true });
    expect(blocked.status).toBe(409);
    expect(messageOf(blocked.body)).toMatch(/turned off/);
    await sql(`UPDATE app.bots SET status = 'active' WHERE id = $1`, [botId]);
    const on = await call(nadia, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const after = UpdatePersonalRoutineResponse.parse(on.body).routine;
    expect(after.enabled).toBe(true);
    expect(after.stoppedReason).toBeNull();
  });

  it('removes a routine and keeps its file', async () => {
    const routine = await make(omar, 'Short lived');
    expect((await call(omar, 'DELETE', `/api/me/scheduled-jobs/${routine.id}`)).status).toBe(200);
    expect(await sql('SELECT 1 FROM app.scheduled_jobs WHERE id = $1', [routine.id])).toHaveLength(0);
    expect(await sql('SELECT 1 FROM app.files WHERE owner_person_id = $1 AND folder_path || name = $2', [omar.personId, routine.contractPath])).toHaveLength(1);
  });
});

describe('a name that was used before', () => {
  it('makes a routine with the name of a deleted one in a folder of its own, and leaves the old files alone', async () => {
    const first = await make(omar, 'Come back');
    expect((await call(omar, 'DELETE', `/api/me/scheduled-jobs/${first.id}`)).status).toBe(200);
    const again = await make(omar, 'Come back');
    expect(again.contractPath).not.toBe(first.contractPath);
    expect(again.contractPath).toBe('Routines/come-back-2/routine.yaml');
    expect(await sql('SELECT 1 FROM app.files WHERE owner_person_id = $1 AND folder_path || name = $2', [omar.personId, first.contractPath])).toHaveLength(1);
    // the plan for the same sentence names the folder the save will use
    const draft = DraftPersonalRoutineResponse.parse((await call(omar, 'POST', '/api/me/scheduled-jobs/draft', { sentence: 'Every weekday at 8am summarise my unread mail', timeZone: 'Asia/Dubai' })).body).draft;
    const slugOfPlan = /^Routines\/([^/]+)\//.exec(draft.outputPath)?.[1] ?? '';
    const taken = await sql(`SELECT 1 FROM app.files WHERE owner_person_id = $1 AND folder_path || name = $2`, [omar.personId, `Routines/${slugOfPlan}/routine.yaml`]);
    expect(taken).toHaveLength(0);
  });
});

describe('running', () => {
  it('"Run now" files one firing with the owner as asker; a second one while it runs is refused', async () => {
    const routine = await make(omar, 'Run now one');
    const res = await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const run = RunPersonalRoutineResponse.parse(res.body).run;
    expect(run.status).toBe('queued');
    const row = await routineRow(routine.id);
    expect(row['asker_person_id']).toBe(omar.personId);
    expect((await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`)).status).toBe(409);
    const runs = ListPersonalRoutineRunsResponse.parse((await call(omar, 'GET', `/api/me/scheduled-jobs/${routine.id}/runs`)).body);
    expect(runs.items).toHaveLength(1);
    expect((await call(nadia, 'GET', `/api/me/scheduled-jobs/${routine.id}/runs`)).status).toBe(404);
  });

  it('"Run now" is held to the day\'s count of firings, like the schedule', async () => {
    const routine = await make(omar, 'Run now many');
    await sql(
      `INSERT INTO app.scheduled_job_runs (scheduled_job_id, owner_person_id, status, started_at, ended_at, reason)
       SELECT $1, $2, 'done', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval, '' FROM generate_series(20, 20 + 95) g`,
      [routine.id, omar.personId],
    );
    // 96 firings in the last day: the 97th is refused
    const over = await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`);
    expect(over.status, JSON.stringify(over.body)).toBe(409);
    expect(JSON.stringify(over.body)).toMatch(/96 times/);
    expect(await runsOf(routine.id)).toHaveLength(96);
  });

  it('fails a firing, with the reason, when the routine file was removed', async () => {
    const routine = await make(omar, 'File gone');
    await sql(`DELETE FROM app.files WHERE owner_person_id = $1 AND folder_path || name = $2`, [omar.personId, routine.contractPath]);
    const res = await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const run = RunPersonalRoutineResponse.parse(res.body).run;
    expect(run.status).toBe('failed');
    expect(run.reason).toMatch(/routine file/i);
  });

  it('the tick job fires a due routine once and moves it on', async () => {
    const routine = await make(omar, 'Tick fires');
    await due(routine.id);
    await tick();
    expect(await runsOf(routine.id)).toHaveLength(1);
    const next = (await routineRow(routine.id))['next_run_at'] as Date;
    expect(next.getTime()).toBeGreaterThan(Date.now());
    await tick();
    expect(await runsOf(routine.id)).toHaveLength(1);
  });
});

describe('the guards', () => {
  it('holds a routine during its owner\'s quiet hours, and fires it after', async () => {
    const hour = new Date().getUTCHours();
    const hh = (n: number) => `${String((n + 24) % 24).padStart(2, '0')}:00`;
    const set = await call(nadia, 'PUT', '/api/me/routine-settings', { timeZone: 'UTC', quietHours: { from: hh(hour - 1), to: hh(hour + 2) } });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const routine = await make(nadia, 'Quiet one');
    await due(routine.id);
    await tick();
    expect(await runsOf(routine.id)).toHaveLength(0);
    const held = (await routineRow(routine.id))['next_run_at'] as Date;
    expect(held.getTime()).toBeGreaterThan(Date.now());
    // quiet hours off: the next time it is due it fires
    expect((await call(nadia, 'PUT', '/api/me/routine-settings', { quietHours: null })).status).toBe(200);
    await due(routine.id);
    await tick();
    expect(await runsOf(routine.id)).toHaveLength(1);
  });

  it('switches a routine off when the month\'s allowance is used up, and tells the owner once', async () => {
    const routine = await make(omar, 'Costly one');
    expect((await call(nadia, 'PUT', '/api/workspace/routine-settings', { monthlyCapUsd: 0 })).status).toBe(403);
    const set = await call(omar, 'PUT', '/api/workspace/routine-settings', { monthlyCapUsd: 0 });
    expect(RoutineWorkspaceSettings.parse(set.body).monthlyCapUsd).toBe(0);
    const refused = await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`);
    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toMatch(/allowance/);
    await due(routine.id);
    await tick();
    const row = await routineRow(routine.id);
    expect(row['enabled']).toBe(false);
    expect(row['stopped_reason']).toBe('spend_cap');
    expect(await runsOf(routine.id)).toHaveLength(0);
    await tick();
    expect(row['stop_told_at'] ?? (await routineRow(routine.id))['stop_told_at']).not.toBeNull();
    const events = await sql(`SELECT 1 FROM app.events WHERE type = 'scheduled_jobs.scheduled_job.stopped' AND payload->>'scheduledJobId' = $1`, [routine.id]);
    expect(events).toHaveLength(1);
    // the notice is a message in the owner's Reminders conversation and reaches the bell
    const messageId = String((await sql(`SELECT payload->>'messageId' AS id FROM app.events WHERE type = 'scheduled_jobs.scheduled_job.stopped' AND payload->>'scheduledJobId' = $1`, [routine.id]))[0]!['id']);
    await expect
      .poll(async () => (await sql(`SELECT 1 FROM app.notifications WHERE person_id = $1 AND ref_id = $2`, [omar.personId, messageId])).length, { timeout: 15_000 })
      .toBe(1);
    await call(omar, 'PUT', '/api/workspace/routine-settings', { monthlyCapUsd: 5 });
  });

  it('switches a routine off when the person says no to the bot', async () => {
    const routine = await make(omar, 'Consent one');
    await sql(`UPDATE app.bot_personal_consents SET allowed = false WHERE person_id = $1 AND bot_id = $2`, [omar.personId, botId]);
    await due(routine.id);
    await tick();
    const row = await routineRow(routine.id);
    expect(row['enabled']).toBe(false);
    expect(row['stopped_reason']).toBe('consent_withdrawn');
    await sql(`UPDATE app.bot_personal_consents SET allowed = true WHERE person_id = $1 AND bot_id = $2`, [omar.personId, botId]);
  });

  it('a bot that is removed switches its routines off and they stay in the list', async () => {
    const otherBot = randomUUID();
    await sql(
      `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, $3, 'brief-bot', 'Brief bot', 'Briefs', 'agent', 'hermes', 'team', $4, 'active')`,
      [otherBot, KAHF_WORKSPACE_ID, ENG, 'e'.repeat(64)],
    );
    const actor = String((await sql(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [KAHF_WORKSPACE_ID, otherBot]))[0]!['id']);
    await sql(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [ENG, actor]);
    await sql(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [omar.personId, otherBot, KAHF_WORKSPACE_ID]);
    const routine = await make(omar, 'Soon orphaned', { botSlug: 'brief-bot' });
    await sql('DELETE FROM app.bots WHERE id = $1', [otherBot]);
    const listed = ListPersonalRoutinesResponse.parse((await call(omar, 'GET', '/api/me/scheduled-jobs')).body).items.find((r) => r.id === routine.id)!;
    expect(listed.enabled).toBe(false);
    expect(listed.stoppedReason).toBe('bot_gone');
    expect(listed.botSlug).toBeNull();
    expect((await call(omar, 'POST', `/api/me/scheduled-jobs/${routine.id}/run`)).status).toBe(409);
  });
});

describe('the Personal shelf', () => {
  it('makes a routine from a recipe and the action-items list then shows its keeper', async () => {
    const recipe = personalRecipeById('action-items')!;
    const draft = recipeToDraft(recipe, 'Asia/Dubai');
    const before = ListActionItemsResponse.parse((await call(omar, 'GET', '/api/me/action-items')).body);
    expect(before.keeperRoutineId).toBeNull();
    const routine = await make(omar, draft.name, {
      words: recipe.sentence,
      schedule: draft.schedule,
      scheduleWords: draft.scheduleWords,
      prompt: draft.prompt,
      sources: [],
      outputPath: draft.outputPath,
      outputMode: draft.outputMode,
      recipeId: recipe.id,
    });
    expect(routine.outputPath).toBe('Action items/action-items.md');
    const after = ListActionItemsResponse.parse((await call(omar, 'GET', '/api/me/action-items')).body);
    expect(after.keeperRoutineId).toBe(routine.id);
  });

  it('refuses a recipe that is not on the shelf and an output inside Memory', async () => {
    expect((await call(omar, 'POST', '/api/me/scheduled-jobs', goodBody('Odd recipe', { recipeId: 'not-a-recipe' }))).status).toBe(400);
    expect((await call(omar, 'POST', '/api/me/scheduled-jobs', goodBody('Into memory', { outputPath: 'Memory/notes.md' }))).status).toBe(400);
  });
});

describe('action items', () => {
  it('starts empty, takes an add, and refuses an edit made on a stale copy', async () => {
    const empty = ListActionItemsResponse.parse((await call(nadia, 'GET', '/api/me/action-items')).body);
    expect(empty.items).toEqual([]);
    expect(empty.revision).toBeNull();
    const added = await call(nadia, 'PATCH', '/api/me/action-items', { revision: null, change: { op: 'add', what: 'Send Tariq the release notes', due: '2026-11-20' } });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const first = ChangeActionItemResponse.parse(added.body);
    expect(first.list.items).toHaveLength(1);
    expect(first.list.items[0]).toMatchObject({ what: 'Send Tariq the release notes', due: '2026-11-20', done: false });
    // the same stale revision again
    const stale = await call(nadia, 'PATCH', '/api/me/action-items', { revision: null, change: { op: 'add', what: 'Another' } });
    expect(stale.status).toBe(409);
    const ticked = await call(nadia, 'PATCH', '/api/me/action-items', { revision: first.list.revision, change: { op: 'tick', id: first.id, done: true } });
    expect(ticked.status, JSON.stringify(ticked.body)).toBe(200);
    expect(ChangeActionItemResponse.parse(ticked.body).list.items[0]!.done).toBe(true);
    // somebody else's list is their own
    expect(ListActionItemsResponse.parse((await call(omar, 'GET', '/api/me/action-items')).body).items).toEqual([]);
    const missing = await call(nadia, 'PATCH', '/api/me/action-items', {
      revision: ChangeActionItemResponse.parse(ticked.body).list.revision,
      change: { op: 'tick', id: 'deadbeef', done: true },
    });
    expect(missing.status).toBe(404);
  });
});
