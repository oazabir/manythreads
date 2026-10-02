import {
  KAHF_WORKSPACE_ID,
  LENA,
  NADIA,
  OMAR,
  PRIYA,
  RAFI,
  ROLE_IDS,
  SAMEERA,
  TARIQ,
  TEAM_IDS,
  allPersonas,
  type Persona,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { column, createWorld, type World } from './world.ts';

// Migration 0011: the hoisted visibility sets must agree with the per-row helpers they replace (app.can, can_in_team,
// is_team_member, team_role), for every persona, grant kind and permission.

let w: World;
const stub = { eng: '', mkt: '', sup: '' };
const teamOf = { eng: TEAM_IDS.Engineering, mkt: TEAM_IDS.Marketing, sup: TEAM_IDS['Customer support'] };
const allTeams = Object.values(TEAM_IDS);
const sorted = (xs: string[]): string[] => [...xs].sort();

beforeAll(async () => {
  w = await createWorld();
  for (const key of ['eng', 'mkt', 'sup'] as const) {
    const r = await w.system((tx) =>
      tx.query<{ id: string }>(`INSERT INTO stub_resources (workspace_id, team_id, name) VALUES ($1, $2, $3) RETURNING id`, [
        KAHF_WORKSPACE_ID,
        teamOf[key],
        key,
      ]),
    );
    stub[key] = r.rows[0]?.id ?? '';
  }
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const grant = (subjectType: string, subjectId: string, resource: string, permission: string) =>
  w.as(OMAR, (tx) =>
    tx.query(
      `INSERT INTO acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'stub_resource', $2, $3, $4, $5)`,
      [KAHF_WORKSPACE_ID, resource, subjectType, subjectId, permission],
    ),
  );
const revoke = () => w.as(OMAR, (tx) => tx.query('DELETE FROM acl_entries'));

/** The per-row answer: the teams for which the old helper says yes, asked as `p` (`t` is the team, `$2` the permission). */
const teamsWhere = (p: Persona, predicate: string, perm?: string) =>
  w.as(p, (tx) => column<string>(tx, `SELECT t FROM unnest($1::uuid[]) t WHERE ${predicate}`, perm ? [allTeams, perm] : [allTeams]).then(sorted));

describe('readable_team_ids / member_team_ids agree with the per-row helpers', () => {
  it.each(allPersonas.map((p) => [p.key, p] as const))('%s: every permission', async (_key, p) => {
    for (const perm of ['read', 'post', 'manage']) {
      const hoisted = await w.as(p, (tx) => column<string[]>(tx, `SELECT app.readable_team_ids($1)`, [perm]));
      expect(sorted(hoisted[0] ?? []), `${p.key} readable_team_ids(${perm})`).toEqual(await teamsWhere(p, 'app.can_in_team(t, $2)', perm));
    }
    const members = await w.as(p, (tx) => column<string[]>(tx, `SELECT app.member_team_ids('read')`));
    expect(sorted(members[0] ?? []), `${p.key} member_team_ids(read)`).toEqual(await teamsWhere(p, 'app.is_team_member(t)'));
    const leads = await w.as(p, (tx) => column<string[]>(tx, `SELECT app.member_team_ids('manage')`));
    expect(sorted(leads[0] ?? []), `${p.key} member_team_ids(manage)`).toEqual(await teamsWhere(p, "app.team_role(t) = 'lead'"));
  });

  it('spells out the seed roster: Priya two teams, Lena none, Omar (admin) all three but member of one', async () => {
    const ids = async (p: Persona, fn: string, perm = 'read') => sorted((await w.as(p, (tx) => column<string[]>(tx, `SELECT app.${fn}($1)`, [perm])))[0] ?? []);
    expect(await ids(PRIYA, 'readable_team_ids')).toEqual(sorted([TEAM_IDS.Engineering, TEAM_IDS.Marketing]));
    expect(await ids(LENA, 'readable_team_ids')).toEqual([]);
    expect(await ids(SAMEERA, 'readable_team_ids')).toEqual([TEAM_IDS['Customer support']]);
    expect(await ids(OMAR, 'readable_team_ids')).toEqual(sorted(allTeams));
    expect(await ids(OMAR, 'member_team_ids')).toEqual([TEAM_IDS.Engineering]);
    expect(await ids(NADIA, 'readable_team_ids', 'manage')).toEqual([]);
    expect(await ids(TARIQ, 'readable_team_ids', 'manage')).toEqual([TEAM_IDS.Marketing]);
  });
});

describe('acl_grant_ids and the hoisted stub_resources policy agree with app.can', () => {
  it('person, team and role grants at every permission', async () => {
    await grant('person', LENA.personId, stub.eng, 'read');
    await grant('person', NADIA.personId, stub.sup, 'post');
    await grant('team', TEAM_IDS['Customer support'], stub.mkt, 'read');
    await grant('role', ROLE_IDS['role:on-call'], stub.sup, 'manage');
    await grant('role', ROLE_IDS['role:support-agent'], stub.eng, 'post');
    try {
      const stubs = [stub.eng, stub.mkt, stub.sup];
      for (const p of allPersonas) {
        for (const perm of ['read', 'post', 'manage']) {
          const granted = sorted((await w.as(p, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', $1)`, [perm])))[0] ?? []);
          const readableTeams = (await w.as(p, (tx) => column<string[]>(tx, `SELECT app.readable_team_ids($1)`, [perm])))[0] ?? [];
          const viaTeam = (await w.system((tx) => column<string>(tx, `SELECT id FROM stub_resources WHERE team_id = ANY ($1::uuid[])`, [readableTeams])));
          const canPerRow = sorted(await w.as(p, (tx) => column<string>(tx, `SELECT id FROM unnest($1::uuid[]) id WHERE app.can('stub_resource', id, $2)`, [stubs, perm])));
          expect(sorted([...new Set([...granted, ...viaTeam])]), `${p.key} ${perm}`).toEqual(canPerRow);
        }
        // The table policy (read) returns exactly what app.can(read) allows.
        const seen = sorted(await w.as(p, (tx) => column<string>(tx, 'SELECT id FROM stub_resources')));
        const can = sorted(await w.as(p, (tx) => column<string>(tx, `SELECT id FROM unnest($1::uuid[]) id WHERE app.can('stub_resource', id, 'read')`, [stubs])));
        expect(seen, `${p.key} stub_resources policy`).toEqual(can);
      }
      // Spot checks on the grants themselves: a guest keeps her person grant and nothing else.
      expect(sorted((await w.as(LENA, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'read')`)))[0] ?? [])).toEqual([stub.eng]);
      expect((await w.as(TARIQ, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'read')`)))[0]).toEqual([]);
      expect(sorted((await w.as(RAFI, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'manage')`)))[0] ?? [])).toEqual([stub.sup]);
      // A resource type nobody registered or granted gives nothing.
      expect((await w.as(LENA, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('nothing', 'read')`)))[0]).toEqual([]);
      expect((await w.as(LENA, (tx) => column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'bogus')`)))[0]).toEqual([]);
    } finally {
      await revoke();
    }
  });
});

describe('the sets answer only about a live caller', () => {
  it('a suspended person has no teams and no grants; reinstating restores them', async () => {
    await grant('person', TARIQ.personId, stub.eng, 'read');
    try {
      const sets = (p: Persona) =>
        w.as(p, async (tx) => ({
          readable: (await column<string[]>(tx, `SELECT app.readable_team_ids('read')`))[0],
          granted: (await column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'read')`))[0],
          roles: (await column<string[]>(tx, `SELECT app.held_role_ids()`))[0],
        }));
      expect((await sets(TARIQ)).readable).toEqual([TEAM_IDS.Marketing]);
      expect((await sets(TARIQ)).granted).toEqual([stub.eng]);
      await w.system((tx) => tx.query(`UPDATE people SET status = 'suspended' WHERE id = $1`, [TARIQ.personId]));
      expect(await sets(TARIQ)).toEqual({ readable: [], granted: [], roles: [] });
      await w.system((tx) => tx.query(`UPDATE people SET status = 'active' WHERE id = $1`, [TARIQ.personId]));
      expect((await sets(TARIQ)).readable).toEqual([TEAM_IDS.Marketing]);
    } finally {
      await revoke();
    }
  });

  it('role holders get their role ids; others none', async () => {
    const roles = (p: Persona) => w.as(p, async (tx) => (await column<string[]>(tx, `SELECT app.held_role_ids()`))[0] ?? []);
    expect(await roles(RAFI)).toEqual([ROLE_IDS['role:on-call']]);
    expect(await roles(NADIA)).toEqual([ROLE_IDS['role:release-owner']]);
    expect(await roles(OMAR)).toEqual([]);
  });

  it('the system role and a transaction with no actor get empty sets (system uses the is_system() branch, never the set)', async () => {
    const system = await w.system(async (tx) => ({
      readable: (await column<string[]>(tx, `SELECT app.readable_team_ids('read')`))[0],
      granted: (await column<string[]>(tx, `SELECT app.acl_grant_ids('stub_resource', 'read')`))[0],
    }));
    expect(system).toEqual({ readable: [], granted: [] });
    const client = await w.appPool.connect();
    try {
      const r = await client.query<{ a: string[]; b: string[] }>(`SELECT app.readable_team_ids('read') a, app.acl_grant_ids('stub_resource', 'read') b`);
      expect(r.rows[0]).toEqual({ a: [], b: [] });
    } finally {
      client.release();
    }
  });

  it('the app role cannot read the tables the sets are built from, only call the functions', async () => {
    await expect(w.as(LENA, (tx) => tx.query(`SELECT * FROM app.team_pending_files`))).rejects.toThrow(/permission denied/);
    // Lena asks for the guest-visible acl_entries through the policy and sees only her own grant row.
    await grant('person', LENA.personId, stub.eng, 'read');
    await grant('person', TARIQ.personId, stub.mkt, 'read');
    try {
      expect(await w.as(LENA, (tx) => column(tx, 'SELECT subject_id FROM acl_entries'))).toEqual([LENA.personId]);
    } finally {
      await revoke();
    }
  });
});
