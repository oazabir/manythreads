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

// Marks and reviews (meetings 0015, P17-06 step 2). `app.meeting_marks` is read by the readers of the call's channel and written by a person in the live call, as themself;
// never changed by the app. `app.meeting_reviews` is made by the platform, read by the people who were in the call while they can read its channel, and confirmed once by
// one of them, as themself, with items of the review only (the guard trigger); nothing else of the row is theirs.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let priv = '';
let room = '';
const ITEM = '00000000-0000-4000-8000-00000000a001';

const newChannel = (name: string, isPrivate: boolean, members: Persona[]): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [
        omar.workspaceId,
        TEAM_IDS.Engineering,
        name,
        'channel',
        isPrivate,
        omar.actorId,
      ])
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const startRoom = (p: Persona, channel: string): Promise<string> =>
  as(p, async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, $3, $4, $4) RETURNING id', [p.workspaceId, channel, 'Standup', p.actorId])).rows[0]!.id);
const join = (p: Persona, meeting: string): Promise<unknown> => as(p, (tx) => tx.query('INSERT INTO app.meeting_participants (meeting_id, actor_id) VALUES ($1, $2)', [meeting, p.actorId]));
const mark = (p: Persona, meeting: string, by: Persona = p): Promise<unknown> =>
  as(p, (tx) => tx.query("INSERT INTO app.meeting_marks (meeting_id, marked_by, at_ms, text) VALUES ($1, $2, 1000, 'Nadia: I will send it')", [meeting, by.actorId]));
const marksSeen = (p: Persona, meeting: string) => as(p, async (tx) => (await tx.query('SELECT id FROM app.meeting_marks WHERE meeting_id = $1', [meeting])).rows.length);
const reviewSeen = (p: Persona, meeting: string) => as(p, async (tx) => (await tx.query('SELECT meeting_id FROM app.meeting_reviews WHERE meeting_id = $1', [meeting])).rows.length);
const confirm = (p: Persona, meeting: string, items: unknown, by: Persona = p) =>
  as(p, async (tx) =>
    (await tx.query("UPDATE app.meeting_reviews SET status = 'confirmed', confirmed_items = $2::jsonb, confirmed_by = $3, updated_at = now() WHERE meeting_id = $1", [meeting, JSON.stringify(items), by.actorId]))
      .rowCount,
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, meetingsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  priv = await newChannel('r-private', true, [nadia, rafi, priya]);
  room = await startRoom(nadia, priv);
  await join(nadia, room);
  await join(rafi, room);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the new tables pass the RLS harness', () => {
  it('forced RLS, a rls: comment, policies', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('meeting_marks', () => {
  it('a person in the live call marks as themself; the readers of the channel see it, nobody else', async () => {
    expect(await code(mark(nadia, room))).toBeUndefined();
    expect(await marksSeen(rafi, room)).toBe(1);
    // a reader of the channel who is not in the call reads it, as they could read its lines
    expect(await marksSeen(priya, room)).toBe(1);
    expect(await marksSeen(omar, room)).toBe(0);
    const row = await sys(async (tx) => (await tx.query<{ channel_id: string; workspace_id: string }>('SELECT channel_id, workspace_id FROM app.meeting_marks WHERE meeting_id = $1', [room])).rows[0]!);
    expect(row).toEqual({ channel_id: priv, workspace_id: omar.workspaceId });
  });
  it('refuses a mark for someone else, from someone not in the call, and from a stranger to the channel', async () => {
    expect(await code(mark(rafi, room, nadia))).toBe('42501');
    expect(await code(mark(priya, room))).toBe('42501');
    expect(await code(mark(omar, room))).toBeDefined();
  });
  it('is never changed or removed by the app', async () => {
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.meeting_marks SET text = 'other' WHERE meeting_id = $1", [room])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.meeting_marks WHERE meeting_id = $1', [room])))).toBe('42501');
    expect(await marksSeen(nadia, room)).toBe(1);
  });
  it('stops at 30 a person', async () => {
    const r2 = await startRoom(rafi, await newChannel('r-other', true, [rafi]));
    await join(rafi, r2);
    for (let i = 0; i < 30; i += 1) await mark(rafi, r2);
    expect(await code(mark(rafi, r2))).toBe('23514');
    await sys((tx) => tx.query("SELECT app.meetings_end($1, 'person')", [r2]));
  });
});

describe('meeting_reviews', () => {
  beforeAll(async () => {
    await sys((tx) => tx.query("SELECT app.meetings_end($1, 'person')", [room]));
    await sys((tx) =>
      tx.query('INSERT INTO app.meeting_reviews (meeting_id, workspace_id, channel_id, team_id, items) VALUES ($1, $2, $3, $4, $5::jsonb)', [
        room,
        omar.workspaceId,
        priv,
        TEAM_IDS.Engineering,
        JSON.stringify([{ id: ITEM, source: 'mark', text: 'Send it', ownerId: null, ownerName: null, due: null, atMs: 1000 }]),
      ]),
    );
  });

  it('no mark once the call has ended', async () => {
    expect(await code(mark(nadia, room))).toBe('23514');
  });
  it('is read by the people who were in the call only', async () => {
    expect(await reviewSeen(nadia, room)).toBe(1);
    expect(await reviewSeen(rafi, room)).toBe(1);
    expect(await reviewSeen(priya, room)).toBe(0);
    expect(await reviewSeen(omar, room)).toBe(0);
  });
  it('is made by the platform only', async () => {
    expect(await code(as(nadia, (tx) => tx.query('INSERT INTO app.meeting_reviews (meeting_id, workspace_id, channel_id) VALUES ($1, $2, $3)', [room, omar.workspaceId, priv])))).toBe('42501');
  });
  it('is confirmed only with items of the review, as oneself, and nothing else of it changes', async () => {
    expect(await code(confirm(rafi, room, [{ id: '00000000-0000-4000-8000-00000000beef', text: 'x' }]))).toBe('23514');
    expect(await code(confirm(rafi, room, [{ id: ITEM, text: 'x' }], nadia))).toBeDefined();
    expect(await code(as(rafi, (tx) => tx.query("UPDATE app.meeting_reviews SET status = 'confirmed', confirmed_items = '[]'::jsonb, confirmed_by = $2, notes_included = true WHERE meeting_id = $1", [room, rafi.actorId])))).toBe('42501');
    // priya can read the channel but was not in the call: her update finds no row
    expect(await confirm(priya, room, [])).toBe(0);
  });
  it('is confirmed once', async () => {
    expect(await confirm(rafi, room, [{ id: ITEM, source: 'mark', text: 'Send it today', ownerId: null, ownerName: null, due: null, atMs: 1000 }])).toBe(1);
    const row = await sys(async (tx) => (await tx.query<{ status: string; confirmed_by: string; confirmed_at: Date | null }>('SELECT status, confirmed_by, confirmed_at FROM app.meeting_reviews WHERE meeting_id = $1', [room])).rows[0]!);
    expect(row.status).toBe('confirmed');
    expect(row.confirmed_by).toBe(rafi.actorId);
    expect(row.confirmed_at).not.toBeNull();
    expect(await confirm(nadia, room, [])).toBe(0);
    // the platform may open it again (late notes)
    expect(await code(sys((tx) => tx.query("UPDATE app.meeting_reviews SET status = 'open', confirmed_items = NULL, confirmed_at = NULL, confirmed_by = NULL WHERE meeting_id = $1", [room])))).toBeUndefined();
  });
  it('is gone for a person who can no longer read the channel', async () => {
    await sys((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [priv, rafi.personId]));
    expect(await reviewSeen(rafi, room)).toBe(0);
    expect(await confirm(rafi, room, [])).toBe(0);
  });
});
