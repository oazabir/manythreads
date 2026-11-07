import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  memoryInboxMigrationSource,
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

// P20-04: a person's own inbox. Read by its owner alone (an admin only during a live audited open, and then never written); the owner drops into it, releases,
// discards and retries; everything else is the pipeline's (the system role). The caps and the "what a drop IS never changes" rule are the database's.

const { omar, nadia, rafi, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 1000;

interface Seed {
  owner?: Persona;
  state?: string;
  stage?: string;
  holdReason?: string | null;
  blob?: string | null;
}
/** An item as the system role makes one (the pipeline's door). */
async function seed(o: Seed = {}): Promise<string> {
  counter += 1;
  return sys(async (tx) => {
    const owner = o.owner ?? nadia;
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO app.memory_personal_inbox_items (workspace_id, owner_person_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, hold_reason, filed_at)
         VALUES ($1, $2, 'person', $3, $4, 'markdown', 'notes.md', 10, $5, $6, $7, 'Owner', $8, CASE WHEN $3 = 'filed' THEN now() END) RETURNING id`,
        [omar.workspaceId, owner.personId, o.state ?? 'queued', o.stage ?? 'hold', sha(counter), o.blob === undefined ? `blob-${counter}` : o.blob, owner.actorId, o.holdReason ?? null],
      )
    ).rows[0]!.id;
  });
}
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.memory_personal_inbox_items ORDER BY id')).rows.map((r) => r.id));

const dropSql = `INSERT INTO app.memory_personal_inbox_items (workspace_id, owner_person_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name)
                 VALUES ($1, $2, $3, $4, $5, 'markdown', 'a.md', 5, $6, 'k', $7, 'N') RETURNING id`;
const drop = (p: Persona, over: { owner?: string; origin?: string; state?: string; stage?: string; dropper?: string } = {}): Promise<unknown> =>
  as(p, (tx) => tx.query(dropSql, [omar.workspaceId, over.owner ?? p.personId, over.origin ?? 'person', over.state ?? 'queued', over.stage ?? 'hold', sha((counter += 1)), over.dropper ?? p.actorId]));

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

describe('the table', () => {
  it('passes the RLS audit and calls no function per row', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      expect(await findPerRowPolicyCalls(client, 'memory_personal_inbox_items')).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

describe('reading', () => {
  it('shows an item to its owner alone: not a teammate, an admin without an open, or a guest', async () => {
    const mine = await seed({ owner: nadia });
    const held = await seed({ owner: nadia, state: 'held', holdReason: 'dlp' });
    expect(await visible(nadia)).toEqual(expect.arrayContaining([mine, held]));
    for (const other of [rafi, omar, lena]) expect(await visible(other), other.key).toEqual([]);
  });

  it('shows each person only their own', async () => {
    const rafis = await seed({ owner: rafi });
    expect(await visible(rafi)).toEqual([rafis]);
    expect(await visible(nadia)).not.toContain(rafis);
  });

  it('shows an admin the items during a live audited open, and lets the admin change none of them', async () => {
    const target = await seed({ owner: nadia, state: 'held', holdReason: 'oversize' });
    await as(omar, (tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [nadia.personId, 'support request']));
    expect(await visible(omar)).toContain(target);
    // an open is read-only: no insert for the owner, no release, no discard
    expect(await code(drop(omar, { owner: nadia.personId }))).toBe('42501');
    const moved = await as(omar, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued' WHERE id = $1`, [target]));
    expect(moved.rowCount).toBe(0);
  });
});

describe('dropping', () => {
  it('lets a person drop into their own inbox', async () => {
    expect(await code(drop(nadia))).toBeUndefined();
    expect(await code(drop(nadia, { state: 'duplicate', stage: 'done' }))).toBeUndefined();
  });

  it('refuses a drop into someone else’s inbox, as someone else, in a state or stage only the pipeline sets, or from an origin the inbox has no door for', async () => {
    expect(await code(drop(nadia, { owner: rafi.personId }))).toBe('42501');
    expect(await code(drop(nadia, { dropper: rafi.actorId }))).toBe('42501');
    expect(await code(drop(nadia, { state: 'filed' }))).toBe('42501');
    expect(await code(drop(nadia, { stage: 'extract' }))).toBe('42501');
    expect(await code(drop(nadia, { origin: 'email' }))).toMatch(/^(42501|23514)$/);
  });

  it('caps the waiting items of one person at 200', async () => {
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_personal_inbox_items (workspace_id, owner_person_id, origin, state, stage, kind, name, size, sha256, dropper_id)
         SELECT $1, $2, 'person', 'queued', 'hold', 'markdown', 'q' || g, 1, lpad(to_hex(700000 + g), 64, '0'), $3
           FROM generate_series(1, 200 - (SELECT count(*)::int FROM app.memory_personal_inbox_items WHERE owner_person_id = $2::uuid AND state IN ('queued', 'extracting', 'filing'))) g`,
        [omar.workspaceId, nadia.personId, nadia.actorId],
      ),
    );
    expect(await code(drop(nadia))).toBe('23514');
    // another person is not affected
    expect(await code(drop(rafi))).toBeUndefined();
  });
});

describe('moving an item along', () => {
  it('lets the owner release a held item, retry a failed one and discard a waiting one', async () => {
    const held = await seed({ owner: rafi, state: 'held', holdReason: 'dlp' });
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued', stage = 'extract', hold_reason = NULL, released_at = now() WHERE id = $1`, [held])))).toBeUndefined();
    const failed = await seed({ owner: rafi, state: 'failed' });
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued', attempts = 0 WHERE id = $1`, [failed])))).toBeUndefined();
    const waiting = await seed({ owner: rafi, state: 'queued' });
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'discarded', blob_key = NULL WHERE id = $1`, [waiting])))).toBeUndefined();
  });

  it('refuses every other move: filing it, un-filing it, discarding a filed one, keeping an original on discard', async () => {
    const queued = await seed({ owner: rafi, state: 'queued' });
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'filed' WHERE id = $1`, [queued])))).toBe('42501');
    const filed = await seed({ owner: rafi, state: 'filed', stage: 'done' });
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued' WHERE id = $1`, [filed])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'discarded', blob_key = NULL WHERE id = $1`, [filed])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'discarded' WHERE id = $1`, [queued])))).toBe('42501');
    expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET blob_key = NULL WHERE id = $1`, [queued])))).toBe('42501');
  });

  it('never lets the owner rewrite what a drop is', async () => {
    const id = await seed({ owner: rafi, state: 'queued' });
    for (const set of [`name = 'other.md'`, `kind = 'pdf'`, `size = 1`, `sha256 = '${sha(1)}'`, `origin = 'message'`, `filed_paths = ARRAY['memory/references/x.md']`, `owner_person_id = '${nadia.personId}'`]) {
      expect(await code(as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET ${set} WHERE id = $1`, [id]))), set).toMatch(/^(42501|23514)$/);
    }
  });

  it('keeps one person from moving another’s item and deletes nothing from the request role', async () => {
    const mine = await seed({ owner: nadia, state: 'held', holdReason: 'dlp' });
    const moved = await as(rafi, (tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'queued' WHERE id = $1`, [mine]));
    expect(moved.rowCount).toBe(0);
    // a delete by the request role matches no row (the policy lets only the system role delete)
    expect((await as(nadia, (tx) => tx.query(`DELETE FROM app.memory_personal_inbox_items WHERE id = $1`, [mine]))).rowCount).toBe(0);
    expect(await visible(nadia)).toContain(mine);
  });
});

describe('constraints', () => {
  it('needs a reason for a held item and a time for a filed one', async () => {
    const id = await seed({ owner: omar });
    expect(await code(sys((tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'held' WHERE id = $1`, [id])))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET state = 'filed' WHERE id = $1`, [id])))).toBe('23514');
  });
});
