import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  meetingsMigrationSource,
  personaActor,
  personas,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, priya } = personas;

// "Ask to share" (meetings 0011, P17-02): `app.meeting_share_requests` is read only by the asker and the person asked, and written only through two definers owned by the
// system role. `app.meetings_ask_to_share` takes a request only from a person in the live call, to another person in it, one request per asker and person asked a minute;
// `app.meetings_answer_share` lets only the person asked answer, once, before the minute is up, while they are in the live call. A system session cannot use either.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let counter = 0;
/** An open channel of Engineering with a live call that `people` are in (the first started it). */
async function callWith(people: Persona[]): Promise<string> {
  const channel = await sys(async (tx) =>
    (
      await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', false, $4) RETURNING id", [
        omar.workspaceId,
        TEAM_IDS.Engineering,
        `share-${String((counter += 1))}`,
        omar.actorId,
      ])
    ).rows[0]!.id,
  );
  const starter = people[0]!;
  const meeting = await as(starter, async (tx) =>
    (await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, 'Pairing', $3, $3) RETURNING id", [starter.workspaceId, channel, starter.actorId])).rows[0]!.id,
  );
  for (const p of people) await as(p, (tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [meeting, p.actorId]));
  return meeting;
}
const askOf = (p: Persona, meeting: string, sharer: Persona) =>
  as(p, async (tx) => (await tx.query<{ request_id: string }>('SELECT request_id FROM app.meetings_ask_to_share($1::uuid, $2::uuid)', [meeting, sharer.actorId])).rows[0]!.request_id);
const answerOf = (p: Persona, request: string, accept: boolean) =>
  as(p, async (tx) => (await tx.query<{ asker_id: string }>('SELECT asker_id FROM app.meetings_answer_share($1::uuid, $2::boolean)', [request, accept])).rows[0]!.asker_id);
const seen = (p: Persona, meeting: string) => as(p, async (tx) => (await tx.query('SELECT id FROM app.meeting_share_requests WHERE meeting_id = $1', [meeting])).rows.length);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, meetingsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('meeting_share_requests', () => {
  it('passes the RLS harness', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('is read by the asker and the person asked only, and nobody writes it directly', async () => {
    const m = await callWith([nadia, rafi, priya]);
    const id = await askOf(rafi, m, nadia);
    expect(await seen(rafi, m)).toBe(1);
    expect(await seen(nadia, m)).toBe(1);
    // in the call, but neither asker nor asked; and someone outside it
    expect(await seen(priya, m)).toBe(0);
    expect(await seen(omar, m)).toBe(0);
    expect(await code(as(rafi, (tx) => tx.query("INSERT INTO app.meeting_share_requests (meeting_id, asker_id, sharer_id, workspace_id, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 minute')", [m, rafi.actorId, priya.actorId, rafi.workspaceId])))).toBe('42501');
    // the app role may only read it: an update or a delete is refused
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_share_requests SET state = 'accepted', answered_at = now() WHERE id = $1", [id])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.meeting_share_requests WHERE id = $1', [id])))).toBe('42501');
    const row = await sys(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.meeting_share_requests WHERE id = $1', [id])).rows[0]);
    expect(row?.state).toBe('pending');
  });

  it('takes a request only from a person in the live call, to someone else in it', async () => {
    const m = await callWith([nadia, rafi]);
    expect(await code(askOf(omar, m, nadia))).toBe('42501');
    expect(await code(askOf(nadia, m, nadia))).toBe('23514');
    expect(await code(askOf(rafi, m, priya))).toBe('23514');
    // a system session has no person to ask for
    expect(await code(sys((tx) => tx.query('SELECT * FROM app.meetings_ask_to_share($1::uuid, $2::uuid)', [m, nadia.actorId])))).toBe('42501');
    await askOf(rafi, m, nadia);
    expect(await code(askOf(rafi, m, nadia))).toBe('23505');
    // someone who left asks no more
    await as(rafi, (tx) => tx.query('UPDATE app.meeting_participants SET left_at = now() WHERE meeting_id = $1 AND actor_id = $2', [m, rafi.actorId]));
    expect(await code(askOf(rafi, m, nadia))).toBe('42501');
  });

  it('is answered by the person asked only, once, within the minute', async () => {
    const m = await callWith([nadia, rafi, priya]);
    const id = await askOf(rafi, m, nadia);
    for (const p of [rafi, priya, omar]) expect(await code(answerOf(p, id, true)), p.key).toBe('P0002');
    expect(await answerOf(nadia, id, false)).toBe(rafi.actorId);
    expect(await code(answerOf(nadia, id, true))).toBe('23514');

    // asking the same person again waits a minute from the last request, whatever its answer
    expect(await code(askOf(rafi, m, nadia))).toBe('23505');
    await sys((tx) => tx.query("UPDATE app.meeting_share_requests SET asked_at = now() - interval '61 seconds' WHERE id = $1", [id]));
    const late = await askOf(rafi, m, nadia);
    await sys((tx) => tx.query("UPDATE app.meeting_share_requests SET expires_at = now() - interval '1 second' WHERE id = $1", [late]));
    expect(await code(answerOf(nadia, late, true))).toBe('23514');
    // a lapsed request (its minute is over) does not keep the asker from asking again
    await sys((tx) => tx.query("UPDATE app.meeting_share_requests SET asked_at = now() - interval '61 seconds' WHERE id = $1", [late]));
    expect(await askOf(rafi, m, nadia)).not.toBe(late);
  });

  it('a yes turns down the other requests waiting for the same person, and returns them', async () => {
    const m = await callWith([nadia, rafi, priya, omar]);
    const a = await askOf(rafi, m, nadia);
    const b = await askOf(priya, m, nadia);
    const c = await askOf(omar, m, nadia);
    const rows = await as(nadia, async (tx) => (await tx.query<{ request_id: string; outcome: string }>('SELECT request_id, outcome FROM app.meetings_answer_share($1::uuid, true)', [b])).rows);
    expect(rows).toEqual([{ request_id: b, outcome: 'accept' }, { request_id: a, outcome: 'other' }, { request_id: c, outcome: 'other' }]);
    const states = await sys(async (tx) => (await tx.query<{ id: string; state: string }>('SELECT id, state FROM app.meeting_share_requests WHERE meeting_id = $1 ORDER BY id', [m])).rows);
    expect(Object.fromEntries(states.map((r) => [r.id, r.state]))).toEqual({ [a]: 'declined', [b]: 'accepted', [c]: 'declined' });
  });
});
