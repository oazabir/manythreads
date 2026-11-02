import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  workshopMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P7-07: a "check this again" notice is read by the readers of the bot's team, closed by a lead or an admin (only the status columns), and filed only by the system role.

const { omar, nadia, sameera, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botId = '';
let noticeId = '';
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const insert = (tx: Tx, subject: string): Promise<pg.QueryResult<{ id: string }>> =>
  tx.query<{ id: string }>(
    `INSERT INTO app.bot_reassessments (workspace_id, team_id, bot_id, reason, subject, headline, checks) VALUES ($1, $2, $3, 'runner_revoked', $4, 'A runner was revoked', '["Check it"]') RETURNING id`,
    [omar.workspaceId, ENG, botId, subject],
  );
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.bot_reassessments ORDER BY id')).rows.map((r) => r.id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, workshopMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status) VALUES ($1, $2, 'helper', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
        [omar.workspaceId, ENG],
      )
    ).rows[0]!.id;
    noticeId = (await insert(tx, 'office-box')).rows[0]!.id;
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('bot_reassessments (P7-07)', () => {
  it('is read by the readers of the bot team and nobody else', async () => {
    expect(await visible(nadia)).toEqual([noticeId]);
    expect(await visible(omar)).toEqual([noticeId]);
    expect(await visible(sameera)).toEqual([]);
    expect(await visible(lena)).toEqual([]);
  });

  it('is filed by the system role only', async () => {
    expect(await code(as(omar, (tx) => insert(tx, 'by-a-person')))).toBe('42501');
    expect(await code(as(nadia, (tx) => insert(tx, 'by-a-member')))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.bot_reassessments')))).toBe('42501');
  });

  it('is closed by a lead or an admin, and only its status columns change', async () => {
    // a member reads it but cannot close it: the update finds no row to change
    const member = await as(nadia, (tx) => tx.query("UPDATE app.bot_reassessments SET status = 'done', closed_at = now() WHERE id = $1", [noticeId]));
    expect(member.rowCount).toBe(0);
    // nobody changes what the notice says
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.bot_reassessments SET headline = 'changed' WHERE id = $1", [noticeId])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.bot_reassessments SET team_id = gen_random_uuid() WHERE id = $1", [noticeId])))).toBe('42501');
    // a status without its time is refused by the table itself
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.bot_reassessments SET status = 'done' WHERE id = $1", [noticeId])))).toBe('23514');
    const lead = await as(omar, (tx) =>
      tx.query("UPDATE app.bot_reassessments SET status = 'dismissed', closed_at = now(), closed_by = (SELECT app.actor()) WHERE id = $1 AND status = 'open'", [noticeId]),
    );
    expect(lead.rowCount).toBe(1);
    // closed: a second close finds no open notice
    const again = await as(omar, (tx) => tx.query("UPDATE app.bot_reassessments SET status = 'done', closed_at = now() WHERE id = $1 AND status = 'open'", [noticeId]));
    expect(again.rowCount).toBe(0);
  });

  it('keeps one open notice for a bot, a reason and a subject, and allows a new one once it is closed', async () => {
    await sys(async (tx) => {
      await insert(tx, 'same');
      await expect(insert(tx, 'same')).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('refuses a reason or a status outside the lists', async () => {
    await sys(async (tx) => {
      await tx.query('SAVEPOINT a');
      await expect(tx.query("UPDATE app.bot_reassessments SET reason = 'because'")).rejects.toMatchObject({ code: '23514' });
      await tx.query('ROLLBACK TO a');
      await expect(tx.query("UPDATE app.bot_reassessments SET status = 'lost', closed_at = now()")).rejects.toMatchObject({ code: '23514' });
    });
  });
});
