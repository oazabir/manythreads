import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryInboxMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P8-19, P8-20: the two tables of memory-inbox 0002. The email door's log (`memory_inbox_mail`) belongs to the platform alone: no person, whatever their role, can
// read or write it. The record of an action added to the board (`memory_inbox_actions`) is readable by the people of the team, written by the person who made the
// card as themselves, and changed or removed by the platform only.

const { omar, nadia, rafi, sameera, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 5000;
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

async function item(): Promise<string> {
  counter += 1;
  return sys(
    async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.memory_inbox_items (workspace_id, team_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name)
           VALUES ($1, $2, 'email', 'queued', 'hold', 'eml', 'Mail', 10, $3, 'k', NULL, NULL) RETURNING id`,
          [omar.workspaceId, ENG, sha(counter)],
        )
      ).rows[0]!.id,
  );
}

const record = (p: Persona, itemId: string, over: { team?: string; addedBy?: string; index?: number; path?: string } = {}): Promise<unknown> =>
  as(p, (tx) =>
    tx.query(
      `INSERT INTO app.memory_inbox_actions (workspace_id, team_id, item_id, concept_path, action_index, task_id, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [omar.workspaceId, over.team ?? ENG, itemId, over.path ?? 'memory/action-items/q4.md', over.index ?? 0, uuid((counter += 1)), over.addedBy ?? p.actorId],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, memoryInboxMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('memory_inbox_mail (the door’s log)', () => {
  it('is the platform’s alone: a person, even an admin, can neither read nor write it', async () => {
    const id = await item();
    await sys((tx) =>
      tx.query(`INSERT INTO app.memory_inbox_mail (workspace_id, team_id, connection_id, message_id, item_id) VALUES ($1, $2, $3, '<a@example.com>', $4)`, [omar.workspaceId, ENG, uuid(1), id]),
    );
    for (const p of [omar, nadia, sameera, lena]) {
      expect(await code(as(p, (tx) => tx.query('SELECT * FROM app.memory_inbox_mail'))), p.name).toBe('42501');
      expect(await code(as(p, (tx) => tx.query(`DELETE FROM app.memory_inbox_mail`))), p.name).toBe('42501');
    }
  });

  it('keeps one row for a message and a team', async () => {
    const insert = (): Promise<unknown> =>
      sys((tx) => tx.query(`INSERT INTO app.memory_inbox_mail (workspace_id, team_id, connection_id, message_id) VALUES ($1, $2, $3, '<same@example.com>')`, [omar.workspaceId, ENG, uuid(2)]));
    await insert();
    expect(await code(insert())).toBe('23505');
  });

  it('bounds the message id', async () => {
    const insert = (id: string): Promise<unknown> =>
      sys((tx) => tx.query(`INSERT INTO app.memory_inbox_mail (workspace_id, team_id, connection_id, message_id) VALUES ($1, $2, $3, $4)`, [omar.workspaceId, ENG, uuid(3), id]));
    expect(await code(insert(''))).toBe('23514');
    expect(await code(insert('x'.repeat(301)))).toBe('23514');
  });
});

describe('memory_inbox_actions (cards made from action items)', () => {
  it('lets a person with post rights record the card they made, as themselves', async () => {
    const id = await item();
    await expect(record(nadia, id)).resolves.toBeDefined();
    await expect(record(omar, id, { index: 1 })).resolves.toBeDefined();
  });

  it('refuses a record in somebody else’s name, from outside the team, and from a guest', async () => {
    const id = await item();
    expect(await code(record(nadia, id, { addedBy: rafi.actorId }))).toBe('42501');
    expect(await code(record(sameera, id))).toBe('42501');
    expect(await code(record(tariq, id))).toBe('42501');
    expect(await code(record(lena, id))).toBe('42501');
  });

  it('names an action once per item', async () => {
    const id = await item();
    await record(nadia, id, { index: 2 });
    expect(await code(record(rafi, id, { index: 2 }))).toBe('23505');
  });

  it('is read by the people of the team and nobody else', async () => {
    const id = await item();
    await record(nadia, id, { index: 3 });
    const count = (p: Persona): Promise<number> => as(p, async (tx) => (await tx.query('SELECT 1 FROM app.memory_inbox_actions WHERE item_id = $1', [id])).rows.length);
    expect(await count(nadia)).toBe(1);
    expect(await count(rafi)).toBe(1);
    expect(await count(omar)).toBe(1);
    expect(await count(sameera)).toBe(0);
    expect(await count(lena)).toBe(0);
  });

  it('is changed or removed by the platform only', async () => {
    const id = await item();
    await record(nadia, id, { index: 4 });
    // no UPDATE or DELETE privilege is granted to the app role at all
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.memory_inbox_actions SET action_index = 9 WHERE item_id = $1`, [id])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.memory_inbox_actions WHERE item_id = $1`, [id])))).toBe('42501');
    expect(await sys(async (tx) => (await tx.query(`DELETE FROM app.memory_inbox_actions WHERE item_id = $1 RETURNING id`, [id])).rows.length)).toBe(1);
  });

  it('bounds the concept path and the index', async () => {
    const id = await item();
    expect(await code(record(nadia, id, { path: '' }))).toBe('23514');
    expect(await code(record(nadia, id, { index: 1001 }))).toBe('23514');
  });
});
