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

const { omar, nadia, rafi, sameera, tariq, lena } = personas;

// Meeting series (meetings 0013, P17-05): `app.meeting_series` is read by the members of its team and the people of its meeting space; a member makes one only for a
// space they opened for that team; its title, agenda line and status are its maker's (a lead's, an admin's) to change, the rest the platform's. The meetings of a
// series (`app.appointments.series_id`) share its space and are added only by whoever may change the series; nobody but the platform sets an agenda path, which a
// job later writes a file at, or moves a meeting to another series or space.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let counter = 0;
const openSpace = (p: Persona, invited: Persona[] = []) =>
  as(p, async (tx) => (await tx.query<{ id: string }>('SELECT app.meetings_open_space($1, $2, $3::uuid[]) AS id', ['Weekly sync', TEAM_IDS.Engineering, invited.map((i) => i.personId)])).rows[0]!.id);
const makeSeries = (p: Persona, space: string) =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.meeting_series (workspace_id, team_id, space_channel_id, slug, title, frequency, time_zone, first_starts_at, duration_minutes, created_by, created_by_person_id)
         VALUES (app.workspace_id(), $1, $2, $3, 'Weekly sync', 'weekly', 'UTC', '2030-01-15T10:00:00Z', 30, app.actor(), app.person_id()) RETURNING id`,
        [TEAM_IDS.Engineering, space, `weekly-sync-${String((counter += 1))}`],
      )
    ).rows[0]!.id,
  );
const addMeeting = (p: Persona, space: string, series: string | null, occurrence: number | null, extra = '') =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>(
        `INSERT INTO app.appointments (workspace_id, team_id, space_channel_id, title, starts_at, ends_at, created_by, created_by_person_id, series_id, occurrence${extra ? ', agenda_path, agenda_written_at' : ''})
         VALUES (app.workspace_id(), $1, $2, 'Weekly sync', '2030-01-15T10:00:00Z', '2030-01-15T10:30:00Z', app.actor(), app.person_id(), $3, $4${extra ? ', $5, now()' : ''}) RETURNING id`,
        [TEAM_IDS.Engineering, space, series, occurrence, ...(extra ? [extra] : [])],
      )
    ).rows[0]!.id,
  );
const sees = (p: Persona, series: string) => as(p, async (tx) => (await tx.query('SELECT id FROM app.meeting_series WHERE id = $1', [series])).rows.length);

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

describe('meeting_series', () => {
  it('passes the RLS harness', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('is read by the team and the people of its space; not by someone else, a guest or anonymous', async () => {
    const space = await openSpace(nadia, [sameera]);
    const series = await makeSeries(nadia, space);
    expect(await sees(nadia, series)).toBe(1);
    expect(await sees(rafi, series)).toBe(1);
    expect(await sees(sameera, series)).toBe(1);
    expect(await sees(tariq, series)).toBe(0);
    expect(await sees(lena, series)).toBe(0);
  });

  it('is made only for a space the maker opened for its team, and only by a member of the team', async () => {
    const nadias = await openSpace(nadia);
    // Rafi is on the team but did not open this space
    expect(await code(makeSeries(rafi, nadias))).toBe('42501');
    // Tariq is not on Engineering
    expect(await code(makeSeries(tariq, nadias))).toBe('42501');
    // a space already used by a single appointment cannot become a series'
    const single = await openSpace(nadia);
    await addMeeting(nadia, single, null, null);
    expect(await code(makeSeries(nadia, single))).toBe('42501');
    // a series starts active
    const other = await openSpace(nadia);
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.meeting_series (workspace_id, team_id, space_channel_id, slug, title, frequency, time_zone, first_starts_at, duration_minutes, created_by, created_by_person_id, status, stopped_at)
             VALUES (app.workspace_id(), $1, $2, 'stopped-one', 'x', 'weekly', 'UTC', now(), 30, app.actor(), app.person_id(), 'stopped', now())`,
            [TEAM_IDS.Engineering, other],
          ),
        ),
      ),
    ).toBe('23514');
  });

  it('its maker or a lead changes the title and stops it; nobody but the platform changes the rest or starts it again', async () => {
    const space = await openSpace(nadia);
    const series = await makeSeries(nadia, space);
    await as(nadia, (tx) => tx.query("UPDATE app.meeting_series SET title = 'Renamed', updated_at = now() WHERE id = $1", [series]));
    // Rafi may not (the update policy shows him no row to change)
    const r = await as(rafi, (tx) => tx.query("UPDATE app.meeting_series SET title = 'Mine' WHERE id = $1", [series]));
    expect(r.rowCount).toBe(0);
    // the folder, the rule, the team and the space are the platform's
    for (const set of ["slug = 'elsewhere'", "frequency = 'monthly'", "time_zone = 'Asia/Tokyo'", 'duration_minutes = 600', `team_id = '${TEAM_IDS.Marketing}'`]) {
      expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.meeting_series SET ${set} WHERE id = $1`, [series]))), set).toBe('23514');
    }
    await as(omar, (tx) => tx.query("UPDATE app.meeting_series SET status = 'stopped', stopped_at = now() WHERE id = $1", [series]));
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_series SET status = 'active', stopped_at = NULL WHERE id = $1", [series])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("UPDATE app.meeting_series SET status = 'active', stopped_at = NULL WHERE id = $1", [series])))).toBe('23514');
    // nobody deletes one
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.meeting_series WHERE id = $1', [series])))).toBe('42501');
  });
});

describe('the meetings of a series', () => {
  it('are added by whoever may change the series, in its own space; never with an agenda path; never moved', async () => {
    const space = await openSpace(nadia, [sameera]);
    const series = await makeSeries(nadia, space);
    const first = await addMeeting(nadia, space, series, 0);
    await addMeeting(nadia, space, series, 1);
    // Rafi is on the team but cannot add to Nadia's series
    expect(await code(addMeeting(rafi, space, series, 2))).toBe('42501');
    // only the platform writes an agenda path
    expect(await code(addMeeting(nadia, space, series, 3, 'meetings/series/x/2030-01-01-agenda.md'))).toBe('42501');
    // another series, or an appointment on its own, cannot use this space
    const otherSpace = await openSpace(nadia);
    const other = await makeSeries(nadia, otherSpace);
    expect(await code(addMeeting(nadia, space, other, 0))).toBe('42501');
    expect(await code(addMeeting(nadia, space, null, null))).toBe('42501');
    // a meeting's series, number, space and agenda path are the platform's; its time and title are its maker's
    await as(nadia, (tx) => tx.query("UPDATE app.appointments SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour', title = 'Moved' WHERE id = $1", [first]));
    for (const set of [`series_id = '${other}'`, 'occurrence = 7', `space_channel_id = '${otherSpace}'`, "agenda_path = 'TEAM.md', agenda_written_at = now()"]) {
      expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.appointments SET ${set} WHERE id = $1`, [first]))), set).toBe('23514');
    }
    // the platform sets the agenda, and only a path under meetings/series/
    await sys((tx) => tx.query("UPDATE app.appointments SET agenda_path = 'meetings/series/weekly-sync/2030-01-15-agenda.md', agenda_written_at = now() WHERE id = $1", [first]));
    expect(await code(sys((tx) => tx.query("UPDATE app.appointments SET agenda_path = 'TEAM.md' WHERE id = $1", [first])))).toBe('23514');
    // a stopped series takes no more meetings
    await as(nadia, (tx) => tx.query("UPDATE app.meeting_series SET status = 'stopped', stopped_at = now() WHERE id = $1", [series]));
    expect(await code(addMeeting(nadia, space, series, 4))).toBe('42501');
  });

  it('are read by the team and the invited of each meeting, as an appointment is', async () => {
    const space = await openSpace(nadia, [sameera]);
    const series = await makeSeries(nadia, space);
    const m = await addMeeting(nadia, space, series, 0);
    await as(nadia, (tx) => tx.query('INSERT INTO app.appointment_invitees (appointment_id, person_id) VALUES ($1, $2)', [m, sameera.personId]));
    const read = (p: Persona) => as(p, async (tx) => (await tx.query('SELECT id FROM app.appointments WHERE id = $1', [m])).rows.length);
    expect(await read(rafi)).toBe(1);
    expect(await read(sameera)).toBe(1);
    expect(await read(tariq)).toBe(0);
    expect(await read(lena)).toBe(0);
  });
});

// Step 2 (meetings 0016): a rule change goes through app.meeting_series_change_rule, a definer that checks the caller itself; the column that records which call's
// notes an agenda took in is the platform's, like the agenda path.
describe('a rule change and late notes (0016)', () => {
  const change = (p: Persona, series: string, first = '2030-02-05T14:00:00Z') =>
    as(p, (tx) => tx.query<{ id: string }>("SELECT app.meeting_series_change_rule($1, NULL, 'biweekly', $2::timestamptz, 45, NULL, 'UTC', '2030-04-01T00:00:00Z'::timestamptz) AS id", [series, first]));

  it("is for its maker, a lead or an admin only; it re-makes the meetings to come with the series' people, numbered after the last", async () => {
    const space = await openSpace(nadia, [sameera]);
    const series = await makeSeries(nadia, space);
    const planned = await as(nadia, async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.meeting_series_plan($1, '2030-02-20T00:00:00Z') AS id", [series])).rows.map((r) => r.id));
    expect(planned.length).toBe(6);
    for (const id of planned) await as(nadia, (tx) => tx.query('INSERT INTO app.appointment_invitees (appointment_id, person_id) VALUES ($1, $2)', [id, sameera.personId]));
    for (const p of [rafi, tariq, lena, sameera]) expect(await code(change(p, series)), p.personId).toBe('42501');
    // the new rule starts with a meeting to come
    expect(await code(change(nadia, series, '2020-01-01T10:00:00Z'))).toBe('22023');
    const first = (await change(omar, series)).rows[0]!.id;
    const rows = await sys(async (tx) => (await tx.query<{ id: string; occurrence: number; starts_at: Date }>('SELECT id, occurrence, starts_at FROM app.appointments WHERE series_id = $1 ORDER BY occurrence', [series])).rows);
    expect(rows.every((r) => !planned.includes(r.id))).toBe(true);
    expect(rows[0]).toMatchObject({ id: first, occurrence: 0 });
    expect(rows.map((r) => r.starts_at.toISOString().slice(0, 10))).toEqual(['2030-02-05', '2030-02-19', '2030-03-05', '2030-03-19']);
    const invited = await sys(async (tx) => (await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM app.appointment_invitees WHERE appointment_id = ANY ($1::uuid[]) AND person_id = $2', [rows.map((r) => r.id), sameera.personId])).rows[0]!.n);
    expect(Number(invited)).toBe(rows.length);
    // the rule's columns stay the platform's outside the function
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.meeting_series SET rule_from = 9 WHERE id = $1', [series])))).toBe('23514');
    // a stopped series takes no new rule
    await as(nadia, (tx) => tx.query("UPDATE app.meeting_series SET status = 'stopped', stopped_at = now() WHERE id = $1", [series]));
    expect(await code(change(nadia, series))).toBe('55000');
  });

  it("nobody but the platform says which call's notes an agenda took in", async () => {
    const space = await openSpace(nadia);
    const series = await makeSeries(nadia, space);
    const m = await addMeeting(nadia, space, series, 0);
    const someMeeting = '0190a000-0000-7000-8000-00000000abcd';
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.appointments SET agenda_notes_meeting_id = $2 WHERE id = $1', [m, someMeeting])))).toBe('23514');
    expect(
      await code(
        as(nadia, (tx) =>
          tx.query(
            `INSERT INTO app.appointments (workspace_id, team_id, space_channel_id, title, starts_at, ends_at, created_by, created_by_person_id, series_id, occurrence, agenda_notes_meeting_id)
             VALUES (app.workspace_id(), $1, $2, 'Weekly sync', '2030-01-22T10:00:00Z', '2030-01-22T10:30:00Z', app.actor(), app.person_id(), $3, 1, $4)`,
            [TEAM_IDS.Engineering, space, series, someMeeting],
          ),
        ),
      ),
    ).toBe('42501');
  });
});
