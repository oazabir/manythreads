import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type MigrationSource, type Tx } from '@manythreads/kernel';
import { NotificationKind, NotificationRefType } from '@manythreads/shared';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  TEAM_IDS,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, priya } = personas;

const notificationsMigrationSource: MigrationSource = {
  namespace: 'notifications',
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let general = '';
let leads = '';
const note: Record<string, string> = {};

async function channel(name: string, opts: { private?: boolean } = {}): Promise<string> {
  return sys(async (tx) =>
    (await tx.query<{ id: string }>(
      'INSERT INTO app.channels (workspace_id, team_id, name, private) VALUES ($1, $2, $3, $4) RETURNING id',
      [omar.workspaceId, TEAM_IDS.Engineering, name, opts.private ?? false],
    )).rows[0]!.id,
  );
}
const notify = (key: string, who: Persona, channelId: string, kind = 'mention'): Promise<void> =>
  sys(async (tx) => {
    note[key] = (await tx.query<{ id: string }>(
      `INSERT INTO app.notifications (workspace_id, person_id, kind, ref_type, ref_id, channel_id, actor_id, actor_name, preview)
       VALUES ($1, $2, $3, 'message', uuidv7(), $4, $5, 'Nadia', 'hello') RETURNING id`,
      [omar.workspaceId, who.personId, kind, channelId, nadia.actorId],
    )).rows[0]!.id;
  });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, notificationsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  general = await channel('general');
  leads = await channel('leads', { private: true });
  await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2), ($1, $3)', [leads, omar.personId, rafi.personId]));
  await notify('rafi-general', rafi, general);
  await notify('rafi-leads', rafi, leads);
  await notify('nadia-general', nadia, general, 'reply');
  await notify('priya-leads', priya, leads);   // priya is not a member of #leads
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the notifications tables pass the RLS harness', () => {
  it('RLS is enabled and forced, with a policy and an rls comment; no policy calls a per-row helper', async () => {
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['notifications', 'notification_prefs']) {
        expect(await findPerRowPolicyCalls(admin, table), `${table} calls a helper per row`).toEqual([]);
      }
      const plan = await admin.query("SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.notifications'::regclass");
      expect(plan.rows[0]).toEqual({ on: true, forced: true });
    } finally {
      await admin.end();
    }
  });

  it('the SQL CHECKs match the shared enums, in order', async () => {
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const defs = await admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'app.notifications'::regclass AND contype = 'c'`,
      );
      const values = (column: string): string[] => {
        const def = defs.rows.map((r) => r.def).find((d) => new RegExp(`^CHECK \\(+\\(?${column}\\b`).test(d) || d.startsWith(`CHECK (((${column})::text`));
        expect(def, column).toBeDefined();
        return [...(def ?? '').matchAll(/'((?:[^']|'')*)'::/g)].map((m) => m[1] ?? '');
      };
      expect(values('kind')).toEqual([...NotificationKind.options]);
      expect(values('ref_type')).toEqual([...NotificationRefType.options]);
    } finally {
      await admin.end();
    }
  });
});

describe('who reads a notification (policy P, behind channel visibility)', () => {
  it('a person reads only their own; nobody else, an admin included', async () => {
    expect((await q<{ id: string }>(nadia, 'SELECT id FROM app.notifications')).map((r) => r.id)).toEqual([note['nadia-general']]);
    expect((await q<{ id: string }>(rafi, 'SELECT id FROM app.notifications ORDER BY id')).map((r) => r.id)).toEqual([note['rafi-general'], note['rafi-leads']]);
    expect(await q(omar, 'SELECT id FROM app.notifications')).toEqual([]);
    expect(await sys(async (tx) => (await tx.query('SELECT id FROM app.notifications')).rows.length)).toBe(4);
  });

  it('a notification of a channel the person cannot read (any more) is invisible to them', async () => {
    expect(await q(priya, 'SELECT id FROM app.notifications')).toEqual([]);
    await sys((tx) => tx.query('DELETE FROM app.channel_members WHERE channel_id = $1 AND person_id = $2', [leads, rafi.personId]));
    try {
      expect((await q<{ id: string }>(rafi, 'SELECT id FROM app.notifications')).map((r) => r.id)).toEqual([note['rafi-general']]);
    } finally {
      await sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [leads, rafi.personId]));
    }
    expect(await q(rafi, 'SELECT id FROM app.notifications')).toHaveLength(2);
  });

  it('no person writes one: insert and delete are refused for everybody', async () => {
    const insert = (p: Persona, target: Persona): Promise<unknown> =>
      as(p, (tx) =>
        tx.query(
          `INSERT INTO app.notifications (workspace_id, person_id, kind, ref_type, ref_id, channel_id, actor_id, actor_name, preview)
           VALUES ($1, $2, 'mention', 'message', uuidv7(), $3, $4, 'x', 'forged')`,
          [omar.workspaceId, target.personId, general, p.actorId],
        ),
      );
    expect(await code(insert(rafi, rafi))).toBe('42501');
    expect(await code(insert(omar, rafi))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.notifications WHERE id = $1', [note['rafi-general']])))).toBe('42501');
  });
});

describe('what a person may change', () => {
  it('marks their own read, once; the time cannot be cleared; nothing else changes', async () => {
    // another person's row: not visible, nothing updated (a pg client reports rowCount; use RETURNING to count)
    const other = await as(nadia, async (tx) => (await tx.query('UPDATE app.notifications SET read_at = now() WHERE id = $1 RETURNING id', [note['rafi-general']])).rows);
    expect(other).toEqual([]);
    const own = await as(rafi, async (tx) => (await tx.query('UPDATE app.notifications SET read_at = now() WHERE id = $1 RETURNING id', [note['rafi-general']])).rows);
    expect(own).toHaveLength(1);
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.notifications SET read_at = NULL WHERE id = $1', [note['rafi-general']])))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query("UPDATE app.notifications SET preview = 'rewritten' WHERE id = $1", [note['rafi-leads']])))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.notifications SET kind = $2 WHERE id = $1', [note['rafi-leads'], 'dm'])))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('UPDATE app.notifications SET person_id = $2 WHERE id = $1', [note['rafi-leads'], nadia.personId])))).toBeDefined();
    const row = (await sys(async (tx) => (await tx.query<{ read_at: Date | null; preview: string; person_id: string }>('SELECT read_at, preview, person_id FROM app.notifications WHERE id = $1', [note['rafi-leads']])).rows))[0];
    expect(row).toMatchObject({ read_at: null, preview: 'hello', person_id: rafi.personId });
  });
});

describe('one row per message and person, the stronger kind wins', () => {
  const upsert = (personId: string, refId: string, kind: string): Promise<number> =>
    sys(async (tx) =>
      (await tx.query(
        `INSERT INTO app.notifications AS n (workspace_id, person_id, kind, ref_type, ref_id, channel_id, actor_id, actor_name, preview)
         VALUES ($1, $2, $3, 'message', $4, $5, $6, 'Nadia', 'x')
         ON CONFLICT (person_id, ref_type, ref_id) DO UPDATE SET kind = EXCLUDED.kind
           WHERE (CASE EXCLUDED.kind WHEN 'mention' THEN 3 WHEN 'reply' THEN 2 ELSE 1 END) > (CASE n.kind WHEN 'mention' THEN 3 WHEN 'reply' THEN 2 ELSE 1 END)
         RETURNING n.id`,
        [omar.workspaceId, personId, kind, refId, general, nadia.actorId],
      )).rows.length,
    );
  const kindOf = (refId: string): Promise<string[]> => sys(async (tx) => (await tx.query<{ kind: string }>('SELECT kind FROM app.notifications WHERE ref_id = $1', [refId])).rows.map((r) => r.kind));

  it('dm then mention becomes a mention; mention then dm or reply stays; the same kind twice writes nothing', async () => {
    const a = (await sys(async (tx) => (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id));
    expect(await upsert(rafi.personId, a, 'dm')).toBe(1);
    expect(await upsert(rafi.personId, a, 'dm')).toBe(0);
    expect(await upsert(rafi.personId, a, 'mention')).toBe(1);
    expect(await upsert(rafi.personId, a, 'reply')).toBe(0);
    expect(await upsert(rafi.personId, a, 'mention')).toBe(0);
    expect(await kindOf(a)).toEqual(['mention']);
    expect(await upsert(nadia.personId, a, 'reply')).toBe(1);
    expect(await kindOf(a)).toHaveLength(2);
  });
});

describe('notification_prefs', () => {
  const save = (p: Persona, doc: object): Promise<unknown> =>
    as(p, (tx) =>
      tx.query(
        `INSERT INTO app.notification_prefs (person_id, workspace_id, prefs) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (person_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
        [p.personId, p.workspaceId, JSON.stringify(doc)],
      ),
    );

  it('a person writes and reads only their own settings; the system reads them all', async () => {
    await save(rafi, { mention: { inApp: false, browser: true } });
    await save(nadia, { dm: { inApp: true, browser: false } });
    expect((await q<{ prefs: { mention?: unknown } }>(rafi, 'SELECT prefs FROM app.notification_prefs')).map((r) => r.prefs)).toEqual([{ mention: { inApp: false, browser: true } }]);
    expect(await q(omar, 'SELECT prefs FROM app.notification_prefs')).toEqual([]);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.notification_prefs')).rows.length)).toBe(2);
  });

  it('cannot write for someone else, nor put a non-object in the document', async () => {
    expect(await code(as(rafi, (tx) => tx.query(`INSERT INTO app.notification_prefs (person_id, workspace_id, prefs) VALUES ($1, $2, '{}')`, [priya.personId, priya.workspaceId])))).toBe('42501');
    const updated = await as(rafi, async (tx) => (await tx.query(`UPDATE app.notification_prefs SET prefs = '{}' WHERE person_id = $1 RETURNING person_id`, [nadia.personId])).rows);
    expect(updated).toEqual([]);
    expect(await code(save(rafi, [] as unknown as object))).toBe('23514');
    expect(await code(as(rafi, (tx) => tx.query('DELETE FROM app.notification_prefs WHERE person_id = $1', [rafi.personId])))).toBe('42501');
  });
});
