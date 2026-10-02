import { fileURLToPath } from 'node:url';
import { createAppPool, createSystemPool, withActor, withSystem, type MigrationSource, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  personaActor,
  personas,
  testKernelMigrationSource,
  type TestDatabase,
  testClient,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, sameera, lena, priya } = personas;
const TEAMS = { engineering: '00000000-0000-7000-8000-0000000b0001', support: '00000000-0000-7000-8000-0000000b0002' };

const teamsMigrations: MigrationSource = {
  namespace: 'teams',
  dir: fileURLToPath(new URL('../../migrations/', import.meta.url)),
};

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: typeof omar, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const denied = (promise: Promise<unknown>): Promise<unknown> => expect(promise).rejects.toMatchObject({ code: '42501' });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrations] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  // Link a tag to Engineering so the visibility checks have a row to hide.
  await withSystem(
    async (tx) => {
      await tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [TEAMS.engineering, 'role:on-call']);
    },
    { pool: sysPool },
  );
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('teams plugin: RLS and definer functions', () => {
  it('the new table passes the RLS harness (enabled, forced, policy, comment)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('team_role_tags: members and admins read their team, nobody else sees a row, nobody writes', async () => {
    const count = (p: typeof omar) =>
      as(p, async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.team_role_tags')).rows[0]?.n);
    expect(await count(nadia)).toBe(1);
    expect(await count(omar)).toBe(1);
    expect(await count(sameera)).toBe(0);
    expect(await count(lena)).toBe(0);
    await expect(
      as(omar, (tx) =>
        tx.query('INSERT INTO app.team_role_tags (team_id, role_id, workspace_id) SELECT $1, id, workspace_id FROM app.roles LIMIT 1', [TEAMS.support]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('teams_roster answers only for people who can read the team', async () => {
    const roster = (p: typeof omar, team: string) =>
      as(p, async (tx) => (await tx.query('SELECT * FROM app.teams_roster($1)', [team])).rows.length);
    expect(await roster(nadia, TEAMS.engineering)).toBe(4);
    expect(await roster(omar, TEAMS.support)).toBe(1);
    expect(await roster(sameera, TEAMS.engineering)).toBe(0);
    expect(await roster(lena, TEAMS.engineering)).toBe(0);
    expect(await roster(priya, TEAMS.support)).toBe(0);
  });

  it('roster, role and tag changes are refused for anyone who is not a lead or admin of that team', async () => {
    for (const p of [nadia, sameera, lena]) {
      await denied(as(p, (tx) => tx.query('SELECT * FROM app.teams_add_member($1, $2, $3)', [TEAMS.engineering, priya.personId, 'member'])));
      await denied(as(p, (tx) => tx.query('SELECT app.teams_set_member_role($1, $2, $3)', [TEAMS.engineering, priya.personId, 'lead'])));
      await denied(as(p, (tx) => tx.query('SELECT * FROM app.teams_tag_assign($1, $2, $3)', [TEAMS.engineering, priya.personId, 'role:x'])));
      await denied(as(p, (tx) => tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [TEAMS.engineering, 'role:y'])));
      await denied(as(p, (tx) => tx.query('SELECT * FROM app.teams_tag_drop($1, $2)', [TEAMS.engineering, 'role:on-call'])));
    }
    // Tariq leads Marketing, not Engineering.
    await denied(
      as(personas.tariq, (tx) => tx.query('SELECT * FROM app.teams_add_member($1, $2, $3)', [TEAMS.engineering, lena.personId, 'member'])),
    );
    // A member may remove only themself.
    await denied(as(nadia, (tx) => tx.query('SELECT * FROM app.teams_remove_member($1, $2)', [TEAMS.engineering, priya.personId])));
  });

  it('a lead who is not a workspace admin can manage their own team through the functions', async () => {
    const tariq = personas.tariq;
    const marketing = '00000000-0000-7000-8000-0000000b0003';
    const added = await as(tariq, async (tx) => (await tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [marketing, 'role:campaign'])).rows);
    expect(added).toHaveLength(1);
    await expect(
      as(tariq, (tx) => tx.query('SELECT * FROM app.teams_add_member($1, $2, $3)', [marketing, lena.personId, 'member'])),
    ).rejects.toMatchObject({ code: '23514' }); // a guest is never a team member (team_members_guard)
  });

  it('a lead cannot take over a role the team does not own, nor strip one it does not define', async () => {
    const tariq = personas.tariq;
    const marketing = '00000000-0000-7000-8000-0000000b0003';
    // role:on-call belongs to Engineering (linked in beforeAll); role:release-owner is an admin-made role no team owns.
    await denied(as(tariq, (tx) => tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [marketing, 'role:on-call'])));
    await denied(as(tariq, (tx) => tx.query('SELECT * FROM app.teams_tag_assign($1, $2, $3)', [marketing, tariq.personId, 'role:on-call'])));
    await denied(as(tariq, (tx) => tx.query('SELECT * FROM app.teams_tag_assign($1, $2, $3)', [marketing, tariq.personId, 'role:release-owner'])));
    const holds = (who: string, tag: string) =>
      withSystem(
        async (tx) =>
          (await tx.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM app.role_members rm JOIN app.roles r ON r.id = rm.role_id WHERE rm.person_id = $1 AND r.name = $2',
            [who, tag],
          )).rows[0]?.n,
        { pool: sysPool },
      );
    expect(await holds(tariq.personId, 'role:on-call')).toBe(0);

    // Priya sits in Marketing and holds Engineering's role:on-call: Tariq cannot remove it, Omar (admin) defines it for any team.
    await withSystem(
      async (tx) => {
        await tx.query(
          "INSERT INTO app.role_members (role_id, person_id, workspace_id) SELECT r.id, $1, r.workspace_id FROM app.roles r WHERE r.name = 'role:on-call' ON CONFLICT DO NOTHING",
          [priya.personId],
        );
      },
      { pool: sysPool },
    );
    const removed = await as(tariq, async (tx) => (await tx.query('SELECT app.teams_tag_unassign($1, $2, $3) AS r', [marketing, priya.personId, 'role:on-call'])).rows[0]);
    expect(removed).toEqual({ r: false });
    expect(await holds(priya.personId, 'role:on-call')).toBe(1);
    const shared = await as(omar, async (tx) => (await tx.query('SELECT * FROM app.teams_tag_define($1, $2)', [marketing, 'role:on-call'])).rows);
    expect(shared).toHaveLength(1);
  });

  it('invitation functions never expose the token hash and only answer for a real token', async () => {
    const info = await as(lena, async (tx) => (await tx.query('SELECT app.teams_invitation_info($1) AS info', [Buffer.from('nope')])).rows[0]);
    expect(info).toEqual({ info: { outcome: 'not_found' } });
    await expect(as(lena, (tx) => tx.query('SELECT token_hash FROM app.invitations'))).resolves.toMatchObject({ rows: [] });
  });
});
