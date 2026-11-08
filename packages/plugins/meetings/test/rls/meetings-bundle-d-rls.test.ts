import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  TEAM_IDS,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
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
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, lena } = personas;

// Bundle D, meetings 0005 (pnpm test:rls): planned rooms. Who reads a plan, that only a poster can plan and only the organizer can cancel, that a non-reader gets the gate sentence and
// nothing more, that attendees who cannot read the channel are counted as outsiders, and that opening the room marks its plan started (once).

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let pub = '';
let priv = '';
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

const inHours = (h: number): string => new Date(Date.now() + h * 3600_000).toISOString();
const schedule = (p: Persona, channel: string, over: { title?: string; attendees?: string[]; outside?: number; startH?: number; endH?: number; provider?: string } = {}): Promise<string> =>
  as(p, async (tx) =>
    (
      await tx.query<{ id: string }>('SELECT app.meetings_schedule(NULL, $1, $2, $3, $4, $5, $6, NULL, $7, $8, $9) AS id', [
        channel,
        over.title ?? 'Design review',
        inHours(over.startH ?? 24),
        inHours(over.endH ?? 25),
        'Agenda line',
        over.provider ?? 'google',
        `evt-${Math.random().toString(36).slice(2)}`,
        over.attendees ?? [],
        over.outside ?? 0,
      ])
    ).rows[0]!.id,
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, meetingsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  pub = await newChannel('d-open', false, []);
  priv = await newChannel('d-private', true, [nadia, rafi]);
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the new tables pass the RLS harness', () => {
  it('forced RLS, a rls: comment, policies for every command', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const rows = (
        await admin.query<{ relname: string; force: boolean; comment: string | null; cmds: string[] }>(
          `SELECT c.relname, c.relforcerowsecurity AS force, obj_description(c.oid) AS comment,
                  array(SELECT DISTINCT p.polcmd::text FROM pg_policy p WHERE p.polrelid = c.oid ORDER BY 1) AS cmds
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'app' AND c.relname IN ('scheduled_meetings', 'scheduled_meeting_attendees')`,
        )
      ).rows;
      expect(rows).toHaveLength(2);
      for (const r of rows) {
        expect(r.force, r.relname).toBe(true);
        expect(r.comment ?? '', r.relname).toMatch(/^rls: /);
        expect([...r.cmds].sort(), r.relname).toEqual(['a', 'd', 'r', 'w']);
      }
    } finally {
      await admin.end();
    }
  });
});

describe('planning a room', () => {
  it('a member who can post plans a room and the attendees who can read the channel are kept', async () => {
    const id = await schedule(nadia, pub, { attendees: [rafi.personId, nadia.personId], outside: 2 });
    const rows = await q<{ outside_count: number; status: string; organizer_id: string }>(nadia, 'SELECT outside_count, status, organizer_id FROM app.scheduled_meetings WHERE id = $1', [id]);
    expect(rows).toEqual([{ outside_count: 2, status: 'scheduled', organizer_id: nadia.actorId }]);
    const att = await q<{ person_id: string }>(rafi, 'SELECT person_id FROM app.scheduled_meeting_attendees WHERE scheduled_meeting_id = $1', [id]);
    expect(att.map((r) => r.person_id).sort()).toEqual([nadia.personId, rafi.personId].sort());
  });

  it('an attendee who cannot read a private channel is counted with the outsiders and never stored', async () => {
    const id = await schedule(nadia, priv, { attendees: [rafi.personId, sameera.personId], outside: 1 });
    const [row] = await q<{ outside_count: number }>(nadia, 'SELECT outside_count FROM app.scheduled_meetings WHERE id = $1', [id]);
    expect(row!.outside_count).toBe(2);
    const att = await q<{ person_id: string }>(nadia, 'SELECT person_id FROM app.scheduled_meeting_attendees WHERE scheduled_meeting_id = $1', [id]);
    expect(att.map((r) => r.person_id)).toEqual([rafi.personId]);
  });

  it('someone who cannot post in the channel is refused', async () => {
    expect(await code(schedule(sameera, priv))).toBe('42501');
    expect(await code(schedule(lena, priv))).toBe('42501');
  });

  it('more than 50 invited, a span over 24 hours, a title with a control character and a start over a year away are refused', async () => {
    expect(await code(schedule(nadia, pub, { outside: 51 }))).toBe('23514');
    expect(await code(schedule(nadia, pub, { startH: 24, endH: 24 + 25 }))).toBe('23514');
    expect(await code(schedule(nadia, pub, { startH: 24, endH: 24 }))).toBe('23514');
    expect(await code(schedule(nadia, pub, { title: 'two\nlines' }))).toBe('23514');
    expect(await code(schedule(nadia, pub, { startH: 24 * 400, endH: 24 * 400 + 1 }))).toBe('23514');
    expect(await code(schedule(nadia, pub, { provider: 'zoom' }))).toBe('23514');
  });

  it('an archived channel takes no new plan (nobody can post there)', async () => {
    const arch = await newChannel('d-archived', false, []);
    await sys((tx) => tx.query('UPDATE app.channels SET archived_at = now() WHERE id = $1', [arch]));
    expect(await code(schedule(nadia, arch))).toBe('42501');
  });

  it('a channel holds at most 100 waiting plans', async () => {
    const busy = await newChannel('d-busy', false, []);
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.scheduled_meetings (workspace_id, team_id, channel_id, organizer_id, provider, title, starts_at, ends_at)
         SELECT $1, $2, $3, $4, 'google', 'Plan ' || g, now() + interval '2 days', now() + interval '2 days 1 hour' FROM generate_series(1, 100) g`,
        [omar.workspaceId, TEAM_IDS.Engineering, busy, nadia.actorId],
      ),
    );
    expect(await code(schedule(nadia, busy))).toBe('23514');
  });
});

describe('reading a plan', () => {
  it('channel readers read it; non-readers of a private channel and the guest see nothing', async () => {
    const id = await schedule(nadia, priv, { attendees: [rafi.personId] });
    for (const p of [nadia, rafi]) expect(await q(p, 'SELECT id FROM app.scheduled_meetings WHERE id = $1', [id]), p.name).toHaveLength(1);
    for (const p of [sameera, lena]) {
      expect(await q(p, 'SELECT id FROM app.scheduled_meetings WHERE id = $1', [id]), p.name).toHaveLength(0);
      expect(await q(p, 'SELECT 1 FROM app.scheduled_meeting_attendees WHERE scheduled_meeting_id = $1', [id]), p.name).toHaveLength(0);
    }
  });

  it('a person cannot write the tables directly, not even the organizer', async () => {
    const id = await schedule(nadia, pub);
    expect(await code(q(nadia, "UPDATE app.scheduled_meetings SET title = 'Other' WHERE id = $1", [id]))).toBe('42501');
    expect(await code(q(nadia, 'DELETE FROM app.scheduled_meetings WHERE id = $1', [id]))).toBe('42501');
    expect(await code(q(nadia, 'INSERT INTO app.scheduled_meeting_attendees (scheduled_meeting_id, person_id, workspace_id, channel_id) VALUES ($1, $2, $3, $4)', [id, rafi.personId, omar.workspaceId, pub]))).toBe('42501');
  });
});

describe('the gate for /join', () => {
  it('a reader gets the plan state; a non-reader of a private channel gets the state without its name', async () => {
    const id = await schedule(nadia, priv);
    const [reader] = await q<{ readable: boolean; status: string; channel_name: string | null }>(rafi, 'SELECT * FROM app.meetings_scheduled_gate($1)', [id]);
    expect(reader).toMatchObject({ readable: true, status: 'scheduled', channel_name: 'd-private' });
    const [outsider] = await q<{ readable: boolean; status: string; channel_name: string | null; organizer_name: string | null }>(sameera, 'SELECT * FROM app.meetings_scheduled_gate($1)', [id]);
    expect(outsider).toMatchObject({ readable: false, status: 'scheduled', channel_name: null });
    expect(outsider!.organizer_name).toBeTruthy();
  });

  it('a public channel keeps its name for a person who cannot post; an unknown plan answers nothing', async () => {
    const id = await schedule(nadia, pub);
    const [row] = await q<{ channel_name: string | null }>(lena, 'SELECT * FROM app.meetings_scheduled_gate($1)', [id]);
    expect(row!.channel_name).toBe('d-open');
    expect(await q(rafi, 'SELECT * FROM app.meetings_scheduled_gate($1)', ['00000000-0000-7000-8000-000000000000'])).toEqual([]);
  });
});

describe('cancelling and starting', () => {
  it('only the organizer cancels, once', async () => {
    const id = await schedule(nadia, pub);
    expect((await q<{ c: boolean }>(rafi, 'SELECT app.meetings_cancel_scheduled($1) AS c', [id]))[0]!.c).toBe(false);
    expect((await q<{ c: boolean }>(nadia, 'SELECT app.meetings_cancel_scheduled($1) AS c', [id]))[0]!.c).toBe(true);
    expect((await q<{ c: boolean }>(nadia, 'SELECT app.meetings_cancel_scheduled($1) AS c', [id]))[0]!.c).toBe(false);
    expect((await q<{ status: string }>(nadia, 'SELECT status FROM app.scheduled_meetings WHERE id = $1', [id]))[0]!.status).toBe('cancelled');
  });

  it('opening a room from a plan marks the plan started; a second room or a cancelled plan is refused', async () => {
    const id = await schedule(nadia, pub);
    const open = (p: Persona, channel: string, plan: string): Promise<string> =>
      as(p, async (tx) => (await tx.query<{ id: string }>('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, scheduled_meeting_id) VALUES ($1, $2, $3, $4, $4, $5) RETURNING id', [p.workspaceId, channel, 'Design review', p.actorId, plan])).rows[0]!.id);
    const room = await open(rafi, pub, id);
    expect((await q<{ status: string }>(nadia, 'SELECT status FROM app.scheduled_meetings WHERE id = $1', [id]))[0]!.status).toBe('started');
    expect((await q<{ scheduled_meeting_id: string }>(nadia, 'SELECT scheduled_meeting_id FROM app.meetings WHERE id = $1', [room]))[0]!.scheduled_meeting_id).toBe(id);
    expect(await code(open(rafi, pub, id))).toBe('23514');
    const cancelled = await schedule(nadia, pub);
    await q(nadia, 'SELECT app.meetings_cancel_scheduled($1)', [cancelled]);
    expect(await code(open(nadia, pub, cancelled))).toBe('23514');
  });

  it('a plan cannot be opened in another channel', async () => {
    const id = await schedule(nadia, pub);
    const other = await newChannel('d-other', false, []);
    expect(await code(as(nadia, (tx) => tx.query('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, scheduled_meeting_id) VALUES ($1, $2, $3, $4, $4, $5)', [nadia.workspaceId, other, 'x', nadia.actorId, id])))).toBe('23514');
  });
});
