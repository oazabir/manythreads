import { randomUUID } from 'node:crypto';
import { KAHF_WORKSPACE_ID, NADIA, OMAR } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, column, type World } from './world.ts';

// Migration 0009: a workspace always keeps one owner, for every writer.

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`);
const owners = () => w.system((tx) => column(tx, `SELECT person_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`, [KAHF_WORKSPACE_ID]));

describe('last-owner guard', () => {
  it('the only owner cannot demote or remove themself, on the app pool', async () => {
    expect(await owners()).toEqual([OMAR.personId]);
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE workspace_members SET role = 'admin' WHERE person_id = $1`, [OMAR.personId])))).toMatch(
      /^23514 a workspace must keep at least one owner/,
    );
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`DELETE FROM workspace_members WHERE person_id = $1`, [OMAR.personId])))).toMatch(/^23514 a workspace must keep/);
    expect(await owners()).toEqual([OMAR.personId]);
  });

  it('the system pool is bound by it too, including moving the row to another workspace or person', async () => {
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'member' WHERE person_id = $1`, [OMAR.personId])))).toMatch(/^23514/);
    expect(await outcome(w.system((tx) => tx.query(`DELETE FROM workspace_members WHERE person_id = $1`, [OMAR.personId])))).toMatch(/^23514/);
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspace_members SET person_id = $2 WHERE person_id = $1`, [OMAR.personId, NADIA.personId])))).toMatch(/^23505|^23514/);
    expect(await owners()).toEqual([OMAR.personId]);
  });

  it('deleting the person is refused while they are the last owner (the cascade is not a way around it)', async () => {
    expect(await outcome(w.system((tx) => tx.query(`DELETE FROM people WHERE id = $1`, [OMAR.personId])))).toMatch(/^23514/);
    expect(await owners()).toEqual([OMAR.personId]);
  });

  it('non-owner rows are unrestricted, and saving an owner row as owner is not a demotion', async () => {
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'admin' WHERE person_id = $1`, [NADIA.personId])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'owner' WHERE person_id = $1`, [OMAR.personId])))).toBe('ok');
  });

  it('with a second owner the first can step down; the survivor is then protected', async () => {
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE workspace_members SET role = 'owner' WHERE person_id = $1`, [NADIA.personId])))).toBe('ok');
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE workspace_members SET role = 'admin' WHERE person_id = $1`, [OMAR.personId])))).toBe('ok');
    expect(await owners()).toEqual([NADIA.personId]);
    expect(await outcome(w.as(NADIA, (tx) => tx.query(`DELETE FROM workspace_members WHERE person_id = $1`, [NADIA.personId])))).toMatch(/^23514/);
    // Omar is now an admin: row level security hides the owner row from him, so nothing is demoted and nothing throws.
    const res = await w.as(OMAR, (tx) => tx.query(`UPDATE workspace_members SET role = 'member' WHERE person_id = $1`, [NADIA.personId]));
    expect(res.rowCount).toBe(0);
    expect(await owners()).toEqual([NADIA.personId]);
  });

  it('deleting a whole workspace removes its owners without tripping the guard', async () => {
    const ws = await w.system(async (tx) => {
      const id = (await tx.query<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ($1, 'Gone') RETURNING id`, [`gone-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
      const person = (await tx.query<{ id: string }>(`INSERT INTO people (workspace_id, display_name, primary_email) VALUES ($1, 'Solo', 'solo@gone.example') RETURNING id`, [id])).rows[0]!.id;
      await tx.query(`INSERT INTO workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [id, person]);
      return id;
    });
    // People do not cascade from workspaces, so a workspace goes together with its people, in one statement.
    expect(
      await outcome(
        w.system((tx) => tx.query(`WITH p AS (DELETE FROM people WHERE workspace_id = $1) DELETE FROM workspaces WHERE id = $1`, [ws])),
      ),
    ).toBe('ok');
    expect(await w.system((tx) => column(tx, `SELECT count(*)::int FROM workspace_members WHERE workspace_id = $1`, [ws]))).toEqual([0]);
  });
});
