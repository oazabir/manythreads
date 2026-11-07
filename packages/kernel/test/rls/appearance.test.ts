import { LENA, NADIA, OMAR } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from './world.ts';

/** 0017 (P21-21): people.theme and people.density; a person writes their own row (people_update), the CHECKs hold the values. */
let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const look = (id: string) =>
  w.system(async (tx) => (await tx.query<{ theme: string; density: string }>('SELECT theme, density FROM people WHERE id = $1', [id])).rows[0]);
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

describe('people.theme and people.density', () => {
  it('start as System and Comfortable for everybody', async () => {
    for (const p of [OMAR, NADIA, LENA]) expect(await look(p.personId)).toEqual({ theme: 'system', density: 'comfortable' });
  });

  it('a person sets their own, a guest too; the other rows do not move', async () => {
    await w.as(NADIA, (tx) => tx.query(`UPDATE people SET theme = 'dark', density = 'compact' WHERE id = app.person_id()`));
    await w.as(LENA, (tx) => tx.query(`UPDATE people SET theme = 'light' WHERE id = app.person_id()`));
    expect(await look(NADIA.personId)).toEqual({ theme: 'dark', density: 'compact' });
    expect(await look(LENA.personId)).toEqual({ theme: 'light', density: 'comfortable' });
    expect(await look(OMAR.personId)).toEqual({ theme: 'system', density: 'comfortable' });
  });

  it('a member cannot write another person (the policy hides the row: no row changes)', async () => {
    const res = await w.as(NADIA, (tx) => tx.query(`UPDATE people SET theme = 'light' WHERE id = $1`, [OMAR.personId]));
    expect(res.rowCount).toBe(0);
    expect(await look(OMAR.personId)).toEqual({ theme: 'system', density: 'comfortable' });
  });

  it('refuses a value outside the lists (23514)', async () => {
    expect(await code(w.system((tx) => tx.query(`UPDATE people SET theme = 'neon' WHERE id = $1`, [OMAR.personId])))).toBe('23514');
    expect(await code(w.system((tx) => tx.query(`UPDATE people SET density = 'huge' WHERE id = $1`, [OMAR.personId])))).toBe('23514');
    expect(await code(w.system((tx) => tx.query(`UPDATE people SET theme = NULL WHERE id = $1`, [OMAR.personId])))).toBe('23502');
  });
});
