import { KAHF_WORKSPACE_ID, NADIA, OMAR } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type World } from './world.ts';

/** 0010: an address is exclusive only once verified, and only inside its workspace. */
let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
});

const insert = (ws: string, person: string, email: string, verified: boolean) =>
  w.system(async (tx) => {
    await tx.query(`INSERT INTO person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, $3, ${verified ? 'now()' : 'NULL'})`, [ws, person, email]);
  });
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? 'error';
  }
};

describe('person_emails uniqueness (verified rows only)', () => {
  it('an unverified claim cannot squat an address: the real owner can still verify it', async () => {
    expect(await code(insert(KAHF_WORKSPACE_ID, NADIA.personId, 'shared@kahf.example', false))).toBe('ok');
    expect(await code(insert(KAHF_WORKSPACE_ID, OMAR.personId, 'Shared@kahf.example', false))).toBe('ok');
    expect(await code(insert(KAHF_WORKSPACE_ID, OMAR.personId, 'SHARED@kahf.example', true))).toBe('23505'); // same person lists it once
    await w.system(async (tx) => {
      await tx.query(`UPDATE person_emails SET verified_at = now() WHERE person_id = $1 AND lower(email) = 'shared@kahf.example'`, [OMAR.personId]);
    });
  });

  it('a verified address belongs to one person in a workspace', async () => {
    expect(await code(insert(KAHF_WORKSPACE_ID, NADIA.personId, 'shared@kahf.example', true))).toBe('23505');
    await expect(
      w.system((tx) => tx.query(`UPDATE person_emails SET verified_at = now() WHERE person_id = $1 AND lower(email) = 'shared@kahf.example'`, [NADIA.personId])),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('the same address may be verified in another workspace', async () => {
    const other = await w.system(async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ('second', 'Second') RETURNING id`)).rows[0]!.id;
      const person = (
        await tx.query<{ id: string }>(`INSERT INTO people (workspace_id, display_name, primary_email) VALUES ($1, 'Om', 'om@second.example') RETURNING id`, [ws])
      ).rows[0]!.id;
      return { ws, person };
    });
    expect(await code(insert(other.ws, other.person, 'shared@kahf.example', true))).toBe('ok');
  });
});
