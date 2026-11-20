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

const { omar, nadia, rafi, sameera, priya } = personas;

// People asked to a call (meetings 0008, P15-27): `app.meeting_invites` is read only by readers of the call's channel and written only through `app.meetings_invite`, which
// takes the whole list or nothing (one person who cannot read the channel refuses all of it), at most 100 at once, never the caller or someone asked before, only for a
// live call with a channel, and only from someone who may post there. The function is a definer owned by the system role, so its caller check must not be `is_system()`.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let counter = 0;
const newChannel = (isPrivate = false, members: Persona[] = []): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, 'channel', $4, $5) RETURNING id", [
        omar.workspaceId,
        TEAM_IDS.Engineering,
        `inv-${String((counter += 1))}`,
        isPrivate,
        omar.actorId,
      ])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const startRoom = (p: Persona, channel: string): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, 'Standup', $3, $3) RETURNING id", [p.workspaceId, channel, p.actorId])).rows[0]!.id);
const invite = (p: Persona, meetingId: string, ids: string[]): Promise<string[]> =>
  as(p, async (tx) => (await tx.query<{ ids: string[] }>('SELECT app.meetings_invite($1::uuid, $2::uuid[]) AS ids', [meetingId, ids])).rows[0]!.ids);
const invitedOf = (meetingId: string): Promise<string[]> =>
  sys(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.meeting_invites WHERE meeting_id = $1 ORDER BY person_id', [meetingId])).rows.map((r) => r.person_id));
const sorted = (ids: string[]): string[] => [...ids].sort();

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

describe('meeting_invites', () => {
  it('passes the RLS harness', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('cannot be written straight into the table by a person (42501), only through the function', async () => {
    const ch = await newChannel();
    const room = await startRoom(nadia, ch);
    const direct = as(nadia, (tx) =>
      tx.query('INSERT INTO app.meeting_invites (meeting_id, person_id, display_name, invited_by, channel_id, workspace_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        room,
        rafi.personId,
        'Rafi',
        nadia.actorId,
        ch,
        nadia.workspaceId,
      ]),
    );
    expect(await code(direct)).toBe('42501');
    expect(sorted(await invite(nadia, room, [rafi.personId]))).toEqual([rafi.personId]);
    // a person can neither change nor remove an invitation
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_invites SET display_name = 'x' WHERE meeting_id = $1", [room])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.meeting_invites WHERE meeting_id = $1', [room])))).toBe('42501');
    expect(await invitedOf(room)).toEqual([rafi.personId]);
  });

  it('is read only by readers of the call’s channel', async () => {
    const priv = await newChannel(true, [nadia, rafi, priya]);
    const room = await startRoom(nadia, priv);
    await invite(nadia, room, [rafi.personId, priya.personId]);
    const read = (p: Persona) => as(p, async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.meeting_invites WHERE meeting_id = $1', [room])).rows.length);
    expect(await read(rafi)).toBe(2);
    expect(await read(nadia)).toBe(2);
    // Omar leads the team but is not in the private channel; Sameera is on another team
    expect(await read(omar)).toBe(0);
    expect(await read(sameera)).toBe(0);
  });
});

describe('app.meetings_invite', () => {
  it('copies the name, leaves out the caller and the people asked before, and answers only the new ones', async () => {
    const ch = await newChannel();
    const room = await startRoom(nadia, ch);
    expect(sorted(await invite(nadia, room, [rafi.personId, nadia.personId, rafi.personId]))).toEqual([rafi.personId]);
    expect(sorted(await invite(nadia, room, [rafi.personId, omar.personId]))).toEqual([omar.personId]);
    expect(await invite(nadia, room, [rafi.personId])).toEqual([]);
    expect(await invite(nadia, room, [])).toEqual([]);
    const rows = await sys(
      async (tx) => (await tx.query<{ person_id: string; display_name: string; invited_by: string; team_id: string }>('SELECT person_id, display_name, invited_by, team_id FROM app.meeting_invites WHERE meeting_id = $1 ORDER BY display_name', [room])).rows,
    );
    expect(rows).toEqual([
      { person_id: omar.personId, display_name: 'Omar', invited_by: nadia.actorId, team_id: TEAM_IDS.Engineering },
      { person_id: rafi.personId, display_name: 'Rafi', invited_by: nadia.actorId, team_id: TEAM_IDS.Engineering },
    ]);
  });

  it('refuses the whole list when one person cannot read the channel, and writes nothing', async () => {
    const priv = await newChannel(true, [nadia, rafi]);
    const room = await startRoom(nadia, priv);
    // Priya is on the team but not in the private channel; Sameera is not on the team; an id that is nobody is refused too
    expect(await code(invite(nadia, room, [rafi.personId, priya.personId]))).toBe('42501');
    expect(await code(invite(nadia, room, [rafi.personId, sameera.personId]))).toBe('42501');
    expect(await code(invite(nadia, room, [rafi.personId, '00000000-0000-7000-8000-00000000dead']))).toBe('42501');
    expect(await invitedOf(room)).toEqual([]);
    expect(await invite(nadia, room, [rafi.personId])).toEqual([rafi.personId]);
  });

  it('takes at most 100 people at once', async () => {
    const ch = await newChannel();
    const room = await startRoom(nadia, ch);
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-7000-8000-${String(i + 1).padStart(12, '0')}`);
    expect(await code(invite(nadia, room, many))).toBe('23514');
  });

  it('is refused to a person who cannot post in the channel, and to one who cannot read it, whoever they name', async () => {
    const priv = await newChannel(true, [nadia, rafi]);
    const room = await startRoom(nadia, priv);
    // Omar is a lead and an admin, but not a reader of this private channel: the definer must check him, not itself (is_system is true inside it)
    expect(await code(invite(omar, room, [rafi.personId]))).toBe('42501');
    expect(await code(invite(sameera, room, [rafi.personId]))).toBe('42501');
    // an archived channel: nobody may post, so nobody may invite
    const ch = await newChannel();
    const room2 = await startRoom(nadia, ch);
    await sys((tx) => tx.query('UPDATE app.channels SET archived_at = now() WHERE id = $1', [ch]));
    expect(await code(invite(nadia, room2, [rafi.personId]))).toBe('42501');
    expect(await invitedOf(room)).toEqual([]);
    expect(await invitedOf(room2)).toEqual([]);
  });

  it('is refused for an ended call and for a call with no channel', async () => {
    const ch = await newChannel();
    const ended = await startRoom(nadia, ch);
    await as(nadia, (tx) => tx.query("SELECT app.meetings_end($1, 'person')", [ended]));
    expect(await code(invite(nadia, ended, [rafi.personId]))).toBe('23514');
    // a team room with no channel (the system role makes it; a person cannot)
    const teamRoom = await sys(
      async (tx) =>
        (await tx.query<{ id: string }>("INSERT INTO app.meetings (workspace_id, team_id, title, started_by, organizer_id) VALUES ($1, $2, 'Team room', $3, $3) RETURNING id", [omar.workspaceId, TEAM_IDS.Engineering, nadia.actorId]))
          .rows[0]!.id,
    );
    expect(await code(invite(nadia, teamRoom, [rafi.personId]))).toBe('23514');
  });

  it('is refused for a call in a direct message: the ring is the invitation', async () => {
    const dm = await sys(async (tx) => {
      const id = (
        await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, name, kind, private, dm_key, created_by) VALUES ($1, '', 'dm', true, $2, $3) RETURNING id", [
          omar.workspaceId,
          [nadia.personId, rafi.personId].sort().join(':'),
          nadia.actorId,
        ])
      ).rows[0]!.id;
      for (const m of [nadia, rafi]) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
      return id;
    });
    const room = await startRoom(nadia, dm);
    expect(await code(invite(nadia, room, [rafi.personId]))).toBe('23514');
    expect(await invitedOf(room)).toEqual([]);
  });

  it('keeps an invitation in its call’s channel (the composite foreign key), even for the system role', async () => {
    const ch = await newChannel();
    const other = await newChannel();
    const room = await startRoom(nadia, ch);
    const wrong = sys((tx) =>
      tx.query('INSERT INTO app.meeting_invites (meeting_id, person_id, display_name, invited_by, channel_id, workspace_id) VALUES ($1, $2, $3, $4, $5, $6)', [
        room,
        rafi.personId,
        'Rafi',
        nadia.actorId,
        other,
        omar.workspaceId,
      ]),
    );
    expect(await code(wrong)).toBe('23503');
  });
});
