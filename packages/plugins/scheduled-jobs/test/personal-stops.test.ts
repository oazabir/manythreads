import { randomUUID } from 'node:crypto';
import { CreatePersonalRoutineResponse, ListPersonalRoutinesResponse, RoutineWorkspaceSettings, type PersonalRoutine } from '@manythreads/shared';
import { KAHF_WORKSPACE_ID, TEAM_IDS, createPersonas, ownerSql, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-T3: the stop reasons the other personal-routine tests do not drive (not_a_member, connection_gone, owner_deactivated), the sentence that refuses a routine whose mail
// connection is missing, and the bounds on the settings routes. personal-routines.test.ts has bot_off/bot_gone/consent_withdrawn/spend_cap and the guards.

const { omar, nadia, rafi } = personas;
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
const due = (id: string) => sql(`UPDATE app.scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [id]);
const stoppedEvents = async (id: string) => sql(`SELECT 1 FROM app.events WHERE type = 'scheduled_jobs.scheduled_job.stopped' AND payload->>'scheduledJobId' = $1`, [id]);

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
  await sql(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [ENG, botActorId]);
  for (const p of [omar, nadia, rafi]) await sql(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [p.personId, botId, KAHF_WORKSPACE_ID]);
}, 120_000);

afterAll(async () => {
  await server?.close();
});

describe('a routine that reads mail', () => {
  it('is refused with a plain sentence while the person has no mail connection, and made once they have one', async () => {
    const refused = await call(omar, 'POST', '/api/me/scheduled-jobs', goodBody('Mail one', { sources: ['mail'] }));
    expect(refused.status).toBe(409);
    expect(messageOf(refused.body)).toBe('Connect your mail first (Account, then Connections), or take it out of this routine.');
    expect(ListPersonalRoutinesResponse.parse((await call(omar, 'GET', '/api/me/scheduled-jobs')).body).items.some((r) => r.name === 'Mail one')).toBe(false);
    // the same words through a draft say it in a note, and still save nothing
    const draft = await call(omar, 'POST', '/api/me/scheduled-jobs/draft', { sentence: 'Every morning summarise my mail', timeZone: 'Asia/Dubai' });
    expect(draft.status).toBe(200);
    expect((draft.body['notes'] as string[]).some((n) => n.includes('You have not connected mail yet'))).toBe(true);
  });

  it('is switched off with connection_gone when the connection is taken away, and may not be turned on again until it is back', async () => {
    const connectionId = String(
      (
        await sql(
          `INSERT INTO app.connections (workspace_id, slug, kind, name, scope, owner_id, status) VALUES ($1, 'omar-mail', 'email', 'Omar mail', 'person', $2, 'enabled') RETURNING id`,
          [KAHF_WORKSPACE_ID, omar.actorId],
        )
      )[0]!['id'],
    );
    const routine = await make(omar, 'Mail watcher', { sources: ['mail'] });
    await sql('DELETE FROM app.connections WHERE id = $1', [connectionId]);
    await due(routine.id);
    await tick();
    const row = await routineRow(routine.id);
    expect(row['enabled']).toBe(false);
    expect(row['stopped_reason']).toBe('connection_gone');
    expect(await stoppedEvents(routine.id)).toHaveLength(1);
    const again = await call(omar, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { enabled: true });
    expect(again.status).toBe(409);
    expect(messageOf(again.body)).toBe('Connect your mail first (Account, then Connections), or take it out of this routine.');
    // taking mail out of the routine is the other way out
    const fixed = await call(omar, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { sources: [], enabled: true });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    expect((await routineRow(routine.id))['stopped_reason']).toBeNull();
  });
});

describe('the owner', () => {
  it('whose account is suspended has their routines switched off with owner_deactivated, and is not told', async () => {
    const routine = await make(rafi, 'Rafi routine');
    const suspended = await call(omar, 'PATCH', `/api/workspace/members/${rafi.personId}`, { status: 'suspended' });
    expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
    await due(routine.id);
    await tick();
    const row = await routineRow(routine.id);
    expect(row['enabled']).toBe(false);
    expect(row['stopped_reason']).toBe('owner_deactivated');
    // a person who cannot sign in cannot be told: the stop stands and is marked as told, with no message and no event
    expect(row['stop_told_at']).not.toBeNull();
    expect(await stoppedEvents(routine.id)).toHaveLength(0);
  });
});

describe('a person who leaves the team of the bot', () => {
  it('has their routines with it switched off with not_a_member, and is told once', async () => {
    const routine = await make(nadia, 'Nadia routine');
    await sql(`DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2`, [ENG, nadia.actorId]);
    await due(routine.id);
    await tick();
    const row = await routineRow(routine.id);
    expect(row['enabled']).toBe(false);
    expect(row['stopped_reason']).toBe('not_a_member');
    await tick();
    expect(await stoppedEvents(routine.id)).toHaveLength(1);
    // turning it on again is refused in words (the bot is out of her sight now, so the sentence is the one for a bot she cannot see), and the bot is no longer one she can
    // ask for a new routine
    const again = await call(nadia, 'PATCH', `/api/me/scheduled-jobs/${routine.id}`, { enabled: true });
    expect(again.status).toBe(409);
    expect(messageOf(again.body)).toBe('The bot that runs this routine is no longer there. Make a new routine with another bot.');
    expect((await call(nadia, 'POST', '/api/me/scheduled-jobs', goodBody('Nadia again'))).status).toBe(404);
  });
});

describe('the settings routes', () => {
  it('refuse an allowance outside 0 to 10000 and a time zone that does not exist', async () => {
    for (const bad of [-1, 10_001]) expect((await call(omar, 'PUT', '/api/workspace/routine-settings', { monthlyCapUsd: bad })).status, `a cap of ${String(bad)}`).toBe(400);
    expect(RoutineWorkspaceSettings.parse((await call(nadia, 'GET', '/api/workspace/routine-settings')).body).monthlyCapUsd).toBe(5);
    const zone = await call(omar, 'PUT', '/api/me/routine-settings', { timeZone: 'Nowhere/City' });
    expect(zone.status).toBe(400);
    expect(messageOf(zone.body)).toBe('That time zone is not one I know');
    // a field the route does not know is refused, not ignored
    expect((await call(omar, 'PUT', '/api/me/routine-settings', { timeZone: 'Asia/Dubai', owner: 'someone' })).status).toBe(400);
    expect((await call(omar, 'PATCH', '/api/me/scheduled-jobs/' + randomUUID(), { ownerPersonId: omar.personId })).status).toBe(400);
  });
});
