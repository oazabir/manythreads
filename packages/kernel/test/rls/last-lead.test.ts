import { KAHF_WORKSPACE_ID, NADIA, OMAR, PRIYA, TARIQ, TEAM_IDS, type Persona } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, column, type World } from './world.ts';

// Migration 0012: a team always keeps one lead, for every writer; admins and the system pool may override.

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const MKT = TEAM_IDS.Marketing;
const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error & { code?: string }) => `${e.code ?? ''} ${e.message}`);
const leads = (team: string) =>
  w.system((tx) => column(tx, `SELECT a.ref_id FROM team_members tm JOIN actors a ON a.id = tm.actor_id WHERE tm.team_id = $1 AND tm.role = 'lead'`, [team]));
const setRole = (actor: Persona, who: Persona, team: string, role: string) =>
  w.as(actor, (tx) => tx.query(`UPDATE team_members SET role = $3 WHERE team_id = $1 AND actor_id = $2`, [team, who.actorId, role]));

describe('last-lead guard', () => {
  it('Tariq, the only lead of Marketing, cannot demote or remove himself (23514)', async () => {
    expect(await leads(MKT)).toEqual([TARIQ.personId]);
    expect(await outcome(setRole(TARIQ, TARIQ, MKT, 'member'))).toMatch(/^23514 a team must keep at least one lead/);
    expect(await outcome(w.as(TARIQ, (tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId])))).toMatch(
      /^23514 a team must keep at least one lead/,
    );
    expect(await leads(MKT)).toEqual([TARIQ.personId]);
  });

  it('moving the lead row to another team or actor is not a way around it', async () => {
    expect(
      await outcome(w.as(TARIQ, (tx) => tx.query(`UPDATE team_members SET actor_id = $3 WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId, NADIA.actorId]))),
    ).toMatch(/^23514/);
    expect(
      await outcome(w.as(TARIQ, (tx) => tx.query(`UPDATE team_members SET team_id = $3 WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId, TEAM_IDS.Engineering]))),
    ).toMatch(/^23514|^42501|row-level/);
    expect(await leads(MKT)).toEqual([TARIQ.personId]);
  });

  it('saving the lead row as lead is not a demotion; members are unrestricted', async () => {
    expect(await outcome(setRole(TARIQ, TARIQ, MKT, 'lead'))).toBe('ok');
    // Priya is a plain member of Marketing: leaving is fine, and so is anything on non-lead rows.
    expect(await outcome(w.as(PRIYA, (tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [MKT, PRIYA.actorId])))).toBe('ok');
    await w.system((tx) => tx.query(`INSERT INTO team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [MKT, PRIYA.actorId, KAHF_WORKSPACE_ID]));
  });

  it('with a second lead the first can step down, and the survivor is then protected', async () => {
    expect(await outcome(setRole(OMAR, PRIYA, MKT, 'lead'))).toBe('ok');
    expect(await outcome(setRole(TARIQ, TARIQ, MKT, 'member'))).toBe('ok');
    expect(await leads(MKT)).toEqual([PRIYA.personId]);
    expect(await outcome(w.as(PRIYA, (tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [MKT, PRIYA.actorId])))).toMatch(/^23514/);
  });

  it('a workspace admin (Omar) may remove or demote the last lead; the system pool may too', async () => {
    expect(await outcome(setRole(OMAR, PRIYA, MKT, 'member'))).toBe('ok');
    expect(await leads(MKT)).toEqual([]);
    expect(await outcome(setRole(OMAR, TARIQ, MKT, 'lead'))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE team_members SET role = 'member' WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE team_members SET role = 'lead' WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [MKT, TARIQ.actorId])))).toBe('ok');
    expect(await leads(MKT)).toEqual([]);
  });

  it('deleting a team removes its roster, last lead included', async () => {
    const eng = TEAM_IDS.Engineering;
    expect(await leads(eng)).toEqual([OMAR.personId]);
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`DELETE FROM teams WHERE id = $1`, [eng])))).toBe('ok');
    expect(await w.system((tx) => column(tx, `SELECT 1 FROM team_members WHERE team_id = $1`, [eng]))).toEqual([]);
  });
});
