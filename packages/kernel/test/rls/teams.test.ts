import { randomUUID } from 'node:crypto';
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
  personaActor,
  type Persona,
} from '@majlis/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  toAclEntry,
  toTeam,
  toTeamMember,
  toTeamPendingFile,
  withActor,
  type AclEntryRow,
  type TeamMemberRow,
  type TeamPendingFileRow,
  type TeamRow,
} from '../../src/index.ts';
import { column, createWorld, type World } from './world.ts';

let w: World;
const stub = { eng: '', mkt: '', sup: '' };

beforeAll(async () => {
  w = await createWorld();
  for (const [key, team] of [
    ['eng', TEAM_IDS.Engineering],
    ['mkt', TEAM_IDS.Marketing],
    ['sup', TEAM_IDS['Customer support']],
  ] as const) {
    const r = await w.system((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO stub_resources (workspace_id, team_id, name) VALUES ($1, $2, $3) RETURNING id`,
        [KAHF_WORKSPACE_ID, team, key],
      ),
    );
    stub[key] = r.rows[0]?.id ?? '';
  }
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const can = (p: Persona, type: string, id: string, perm: string) =>
  w.as(p, async (tx) => (await tx.query<{ c: boolean }>('SELECT app.can($1, $2, $3) AS c', [type, id, perm])).rows[0]?.c);

describe('teams and team_members (T)', () => {
  it('Lena (guest, no team) sees no teams and no roster rows', async () => {
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT id FROM teams'))).toEqual([]);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT team_id FROM team_members'))).toEqual([]);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT team_id FROM team_pending_files').catch(() => 'denied'))).toBe('denied');
  });

  it('Priya sees exactly her two teams, Sameera only Customer support, Omar (admin) all three', async () => {
    const slugs = async (p: Persona) =>
      (await w.as(p, (tx) => tx.query<TeamRow>('SELECT * FROM teams'))).rows.map((r) => toTeam(r).slug).sort();
    expect(await slugs(PRIYA)).toEqual(['engineering', 'marketing']);
    expect(await slugs(SAMEERA)).toEqual(['customer-support']);
    expect(await slugs(OMAR)).toEqual(['customer-support', 'engineering', 'marketing']);
    expect(await slugs(TARIQ)).toEqual(['marketing']);
  });

  it("Sameera cannot see Engineering's roster; Nadia sees all four Engineering members", async () => {
    const rosterOf = (p: Persona, team: string) =>
      w.as(p, (tx) => tx.query<TeamMemberRow>('SELECT * FROM team_members WHERE team_id = $1 ORDER BY role', [team]));
    expect((await rosterOf(SAMEERA, TEAM_IDS.Engineering)).rows).toEqual([]);
    const eng = (await rosterOf(NADIA, TEAM_IDS.Engineering)).rows.map(toTeamMember);
    expect(eng.map((m) => m.actorId).sort()).toEqual([OMAR, NADIA, RAFI, PRIYA].map((p) => p.actorId).sort());
    expect(eng.find((m) => m.actorId === OMAR.actorId)?.role).toBe('lead');
  });

  it('a member cannot write the roster; a lead writes her own team only; an admin writes any', async () => {
    const add = (p: Persona, team: string, actor: Persona) =>
      w.as(p, (tx) =>
        tx.query(`INSERT INTO team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [
          team,
          actor.actorId,
          KAHF_WORKSPACE_ID,
        ]),
      );
    await expect(add(NADIA, TEAM_IDS.Engineering, SAMEERA)).rejects.toThrow(/row-level security/);
    await expect(add(TARIQ, TEAM_IDS.Engineering, SAMEERA)).rejects.toThrow(/row-level security/);
    await add(TARIQ, TEAM_IDS.Marketing, SAMEERA);
    expect(await w.as(SAMEERA, (tx) => column(tx, 'SELECT id FROM teams'))).toHaveLength(2);
    await add(OMAR, TEAM_IDS['Customer support'], RAFI);
    // A member can leave; a lead can remove.
    const leave = await w.as(SAMEERA, (tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [TEAM_IDS.Marketing, SAMEERA.actorId]));
    expect(leave.rowCount).toBe(1);
    const remove = await w.as(OMAR, (tx) => tx.query(`DELETE FROM team_members WHERE team_id = $1 AND actor_id = $2`, [TEAM_IDS['Customer support'], RAFI.actorId]));
    expect(remove.rowCount).toBe(1);
    // A member cannot promote herself.
    const promote = await w.as(NADIA, (tx) => tx.query(`UPDATE team_members SET role = 'lead' WHERE actor_id = $1`, [NADIA.actorId]));
    expect(promote.rowCount).toBe(0);
  });

  it('a lead renames her team; a member does not; a lead cannot move it to another workspace', async () => {
    const rename = (p: Persona, team: string) =>
      w.as(p, (tx) => tx.query(`UPDATE teams SET name = 'Eng' WHERE id = $1`, [team]));
    expect((await rename(OMAR, TEAM_IDS.Engineering)).rowCount).toBe(1);
    expect((await rename(NADIA, TEAM_IDS.Engineering)).rowCount).toBe(0);
    expect((await rename(TARIQ, TEAM_IDS.Engineering)).rowCount).toBe(0);
    await w.as(OMAR, (tx) => tx.query(`UPDATE teams SET name = 'Engineering' WHERE id = $1`, [TEAM_IDS.Engineering]));
    await expect(
      w.as(OMAR, (tx) => tx.query(`UPDATE teams SET workspace_id = $1 WHERE id = $2`, [randomUUID(), TEAM_IDS.Engineering])),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('only an admin creates teams', async () => {
    const create = (p: Persona, slug: string) =>
      w.as(p, (tx) =>
        tx.query<TeamRow>(`INSERT INTO teams (workspace_id, slug, name) VALUES ($1, $2, $2) RETURNING *`, [KAHF_WORKSPACE_ID, slug]),
      );
    await expect(create(TARIQ, 'rogue')).rejects.toThrow(/row-level security/);
    const ok = await create(OMAR, 'research');
    expect(toTeam(ok.rows[0]!).template).toBeNull();
    // Creator-as-lead is the teams plugin's job; here the new team is visible to the admin only.
    expect(await w.as(PRIYA, (tx) => column(tx, `SELECT slug FROM teams WHERE slug = 'research'`))).toEqual([]);
    await w.as(OMAR, (tx) => tx.query(`DELETE FROM teams WHERE slug = 'research'`));
  });

  it('team_pending_files: leads and admins write through the function, nobody reads it', async () => {
    const put = (p: Persona, team: string) =>
      w.as(p, (tx) => tx.query(`SELECT app.put_team_pending_files($1, '{"TEAM.md": "# Team"}')`, [team]));
    await put(OMAR, TEAM_IDS.Engineering);
    await put(TARIQ, TEAM_IDS.Marketing);
    await expect(put(TARIQ, TEAM_IDS.Engineering)).rejects.toThrow(/only a team lead or workspace admin/);
    await expect(put(NADIA, TEAM_IDS.Engineering)).rejects.toThrow(/only a team lead or workspace admin/);
    await expect(put(LENA, TEAM_IDS.Engineering)).rejects.toThrow(/only a team lead or workspace admin/);
    const rows = await w.system((tx) => tx.query<TeamPendingFileRow>('SELECT * FROM team_pending_files ORDER BY team_id'));
    expect(rows.rows.map((r) => toTeamPendingFile(r).files['TEAM.md'])).toEqual(['# Team', '# Team']);
  });
});

describe('a guest is never a team member', () => {
  const addLena = (as: 'system' | Persona) => {
    const run = (tx: Parameters<Parameters<typeof w.system>[0]>[0]) =>
      tx.query(`INSERT INTO team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [
        TEAM_IDS.Engineering,
        LENA.actorId,
        KAHF_WORKSPACE_ID,
      ]);
    return as === 'system' ? w.system(run) : w.as(as, run);
  };

  it('is rejected for the system actor, for an admin, and for a lead', async () => {
    await expect(addLena('system')).rejects.toThrow(/guest cannot be a team member/);
    await expect(addLena(OMAR)).rejects.toThrow(/guest cannot be a team member/);
    await expect(addLena(TARIQ)).rejects.toThrow(/guest cannot be a team member|row-level security/);
    expect(await w.system((tx) => column(tx, 'SELECT 1 FROM team_members WHERE actor_id = $1', [LENA.actorId]))).toEqual([]);
  });

  it('a team member cannot be demoted to guest, and a non-member person cannot join', async () => {
    await expect(
      w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'guest' WHERE person_id = $1`, [NADIA.personId])),
    ).rejects.toThrow(/cannot become a workspace guest/);
    // Moving a roster row to a guest actor is caught too.
    await expect(
      w.system((tx) => tx.query(`UPDATE team_members SET actor_id = $1 WHERE actor_id = $2`, [LENA.actorId, RAFI.actorId])),
    ).rejects.toThrow(/guest cannot be a team member/);
  });

  it('a bot actor can join a team, a person without workspace membership cannot', async () => {
    const bot = await w.system(async (tx) => {
      const a = await tx.query<{ id: string }>(
        `INSERT INTO actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`,
        [KAHF_WORKSPACE_ID, randomUUID()],
      );
      await tx.query(`INSERT INTO team_members (team_id, actor_id, workspace_id) VALUES ($1, $2, $3)`, [
        TEAM_IDS.Engineering,
        a.rows[0]?.id,
        KAHF_WORKSPACE_ID,
      ]);
      const person = randomUUID();
      await tx.query(`INSERT INTO people (id, workspace_id, display_name, primary_email) VALUES ($1, $2, 'Nomember', 'nm@kahf.example')`, [person, KAHF_WORKSPACE_ID]);
      const actor = await tx.query<{ id: string }>(
        `INSERT INTO actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`,
        [KAHF_WORKSPACE_ID, person],
      );
      return { bot: a.rows[0]?.id, nomember: actor.rows[0]?.id };
    });
    await expect(
      w.system((tx) =>
        tx.query(`INSERT INTO team_members (team_id, actor_id, workspace_id) VALUES ($1, $2, $3)`, [
          TEAM_IDS.Engineering,
          bot.nomember,
          KAHF_WORKSPACE_ID,
        ]),
      ),
    ).rejects.toThrow(/must be a workspace member/);
    // The bot is on the roster and sees the team, like a member.
    const seen = await withActor(
      { kind: 'bot', id: bot.bot as never, workspaceId: KAHF_WORKSPACE_ID },
      (tx) => column(tx, 'SELECT slug FROM teams'),
      { pool: w.appPool },
    );
    expect(seen).toEqual(['engineering']);
  });
});

describe('roles and role_members (WR)', () => {
  it('members read role tags; guests do not; only admins write', async () => {
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT name FROM roles ORDER BY name'))).toEqual([
      'role:on-call',
      'role:release-owner',
      'role:support-agent',
    ]);
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT person_id FROM role_members WHERE role_id = $1', [ROLE_IDS['role:on-call']]))).toEqual([RAFI.personId]);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT name FROM roles'))).toEqual([]);
    await expect(
      w.as(TARIQ, (tx) => tx.query(`INSERT INTO role_members (role_id, person_id, workspace_id) VALUES ($1, $2, $3)`, [ROLE_IDS['role:on-call'], TARIQ.personId, KAHF_WORKSPACE_ID])),
    ).rejects.toThrow(/row-level security/);
    await w.as(OMAR, (tx) => tx.query(`INSERT INTO role_members (role_id, person_id, workspace_id) VALUES ($1, $2, $3)`, [ROLE_IDS['role:on-call'], NADIA.personId, KAHF_WORKSPACE_ID]));
    await w.as(OMAR, (tx) => tx.query(`DELETE FROM role_members WHERE person_id = $1 AND role_id = $2`, [NADIA.personId, ROLE_IDS['role:on-call']]));
    await expect(w.system((tx) => tx.query(`INSERT INTO roles (workspace_id, name) VALUES ($1, 'on-call')`, [KAHF_WORKSPACE_ID]))).rejects.toThrow(/check constraint/);
  });
});

describe('app.can() on stub_resources (team-scoped)', () => {
  // [persona, resource, read, post, manage]
  const matrix: [Persona, 'eng' | 'mkt' | 'sup', boolean, boolean, boolean][] = [
    [OMAR, 'eng', true, true, true],
    [OMAR, 'mkt', true, true, true],
    [OMAR, 'sup', true, true, true],
    [NADIA, 'eng', true, true, false],
    [NADIA, 'mkt', false, false, false],
    [NADIA, 'sup', false, false, false],
    [RAFI, 'eng', true, true, false],
    [RAFI, 'mkt', false, false, false],
    [SAMEERA, 'eng', false, false, false],
    [SAMEERA, 'mkt', false, false, false],
    [SAMEERA, 'sup', true, true, false],
    [TARIQ, 'eng', false, false, false],
    [TARIQ, 'mkt', true, true, true],
    [PRIYA, 'eng', true, true, false],
    [PRIYA, 'mkt', true, true, false],
    [PRIYA, 'sup', false, false, false],
    [LENA, 'eng', false, false, false],
    [LENA, 'mkt', false, false, false],
    [LENA, 'sup', false, false, false],
  ];

  it.each(matrix)('%s on %s: read %s, post %s, manage %s', async (persona, res, read, post, manage) => {
    expect(await can(persona, 'stub_resource', stub[res], 'read')).toBe(read);
    expect(await can(persona, 'stub_resource', stub[res], 'post')).toBe(post);
    expect(await can(persona, 'stub_resource', stub[res], 'manage')).toBe(manage);
  });

  it('team resources follow the same rule', async () => {
    expect(await can(NADIA, 'team', TEAM_IDS.Engineering, 'post')).toBe(true);
    expect(await can(NADIA, 'team', TEAM_IDS.Engineering, 'manage')).toBe(false);
    expect(await can(NADIA, 'team', TEAM_IDS.Marketing, 'read')).toBe(false);
    expect(await can(OMAR, 'team', TEAM_IDS.Marketing, 'manage')).toBe(true);
    expect(await can(TARIQ, 'team', TEAM_IDS.Marketing, 'manage')).toBe(true);
  });

  it('unknown types, missing ids and invalid permissions deny; the system actor is always allowed', async () => {
    expect(await can(OMAR, 'nonsense', stub.eng, 'read')).toBe(false);
    expect(await can(OMAR, 'stub_resource', randomUUID(), 'read')).toBe(false);
    expect(await can(OMAR, 'stub_resource', stub.eng, 'delete')).toBe(false);
    const sys = await w.system(async (tx) => (await tx.query<{ c: boolean }>(`SELECT app.can('nonsense', $1, 'read') AS c`, [stub.eng])).rows[0]?.c);
    expect(sys).toBe(true);
  });

  it('the stub table follows: reads by app.can(read), writes need post on the team', async () => {
    const names = (p: Persona) => w.as(p, (tx) => column(tx, 'SELECT name FROM stub_resources ORDER BY name'));
    expect(await names(LENA)).toEqual([]);
    expect(await names(NADIA)).toEqual(['eng']);
    expect(await names(SAMEERA)).toEqual(['sup']);
    expect(await names(PRIYA)).toEqual(['eng', 'mkt']);
    expect(await names(OMAR)).toEqual(['eng', 'mkt', 'sup']);
    const insert = (p: Persona, team: string) =>
      w.as(p, (tx) =>
        tx.query(`INSERT INTO stub_resources (workspace_id, team_id, name) VALUES ($1, $2, 'new') RETURNING id`, [KAHF_WORKSPACE_ID, team]),
      );
    await expect(insert(NADIA, TEAM_IDS.Marketing)).rejects.toThrow(/row-level security/);
    await expect(insert(LENA, TEAM_IDS.Engineering)).rejects.toThrow(/row-level security/);
    const ok = await insert(NADIA, TEAM_IDS.Engineering);
    expect(ok.rowCount).toBe(1);
    const del = (p: Persona, id: string) => w.as(p, (tx) => tx.query(`DELETE FROM stub_resources WHERE id = $1`, [id]));
    const newId = ok.rows[0]?.['id'] as string;
    expect((await del(NADIA, newId)).rowCount).toBe(0); // manage is a lead's
    expect((await del(OMAR, newId)).rowCount).toBe(1);
  });
});

describe('acl_entries grant access outside teams', () => {
  const grant = (subjectType: string, subjectId: string, resource: string, permission: string, type = 'stub_resource') =>
    w.as(OMAR, (tx) =>
      tx.query(
        `INSERT INTO acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [KAHF_WORKSPACE_ID, type, resource, subjectType, subjectId, permission],
      ),
    );
  const revoke = () => w.as(OMAR, (tx) => tx.query('DELETE FROM acl_entries'));

  it('a person grant lets the guest read exactly what was granted', async () => {
    expect(await can(LENA, 'stub_resource', stub.eng, 'read')).toBe(false);
    await grant('person', LENA.personId, stub.eng, 'read');
    expect(await can(LENA, 'stub_resource', stub.eng, 'read')).toBe(true);
    expect(await can(LENA, 'stub_resource', stub.eng, 'post')).toBe(false);
    expect(await can(LENA, 'stub_resource', stub.mkt, 'read')).toBe(false);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT name FROM stub_resources'))).toEqual(['eng']);
    // She still sees no teams, and cannot write the stub.
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT id FROM teams'))).toEqual([]);
    const upd = await w.as(LENA, (tx) => tx.query(`UPDATE stub_resources SET name = 'x'`));
    expect(upd.rowCount).toBe(0);
    await revoke();
    expect(await can(LENA, 'stub_resource', stub.eng, 'read')).toBe(false);
  });

  it('a higher grant implies the lower ones', async () => {
    await grant('person', LENA.personId, stub.eng, 'manage');
    for (const perm of ['read', 'post', 'manage']) expect(await can(LENA, 'stub_resource', stub.eng, perm)).toBe(true);
    await revoke();
  });

  it('a team grant applies to its members only; a role grant to its holders only', async () => {
    await grant('team', TEAM_IDS['Customer support'], stub.mkt, 'read');
    await grant('role', ROLE_IDS['role:on-call'], stub.sup, 'post');
    expect(await can(SAMEERA, 'stub_resource', stub.mkt, 'read')).toBe(true);
    expect(await can(SAMEERA, 'stub_resource', stub.mkt, 'post')).toBe(false);
    expect(await can(NADIA, 'stub_resource', stub.mkt, 'read')).toBe(false);
    expect(await can(LENA, 'stub_resource', stub.mkt, 'read')).toBe(false);
    expect(await can(RAFI, 'stub_resource', stub.sup, 'post')).toBe(true);
    expect(await can(RAFI, 'stub_resource', stub.sup, 'read')).toBe(true);
    expect(await can(NADIA, 'stub_resource', stub.sup, 'read')).toBe(false);
    await revoke();
  });

  it('a subject reads its own grants only; non-admins cannot write', async () => {
    await grant('person', LENA.personId, stub.eng, 'read');
    await grant('team', TEAM_IDS.Marketing, stub.eng, 'read');
    await grant('role', ROLE_IDS['role:support-agent'], stub.eng, 'read');
    const subjects = (p: Persona) => w.as(p, (tx) => tx.query<AclEntryRow>('SELECT * FROM acl_entries'));
    expect((await subjects(LENA)).rows.map((r) => toAclEntry(r).subjectType)).toEqual(['person']);
    expect((await subjects(TARIQ)).rows.map((r) => toAclEntry(r).subjectType)).toEqual(['team']);
    expect((await subjects(SAMEERA)).rows.map((r) => toAclEntry(r).subjectType)).toEqual(['role']);
    expect((await subjects(NADIA)).rows).toEqual([]);
    expect((await subjects(OMAR)).rows).toHaveLength(3);
    await expect(
      w.as(TARIQ, (tx) =>
        tx.query(
          `INSERT INTO acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
           VALUES ($1, 'stub_resource', $2, 'person', $3, 'manage')`,
          [KAHF_WORKSPACE_ID, stub.eng, TARIQ.personId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await revoke();
  });
});

describe('workspace boundary and no policy recursion', () => {
  it('an admin of another workspace reaches nothing here, and app.can() denies', async () => {
    const other = await w.system(async (tx) => {
      const ws = (await tx.query<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]?.id;
      const person = (
        await tx.query<{ id: string }>(`INSERT INTO people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])
      ).rows[0]?.id;
      const actor = (await tx.query<{ id: string }>(`INSERT INTO actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]?.id;
      await tx.query(`INSERT INTO workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
      return { ws, actor };
    });
    const asX = <T>(fn: Parameters<typeof withActor<T>>[1]) =>
      withActor({ kind: 'person', id: other.actor as never, workspaceId: other.ws as never }, fn, { pool: w.appPool });
    expect(await asX((tx) => column(tx, 'SELECT slug FROM teams'))).toEqual([]);
    expect(await asX((tx) => column(tx, 'SELECT name FROM stub_resources'))).toEqual([]);
    expect(await asX((tx) => column(tx, 'SELECT app.can($1, $2, $3)::text', ['stub_resource', stub.eng, 'read']))).toEqual(['false']);
    expect(await asX((tx) => column(tx, 'SELECT name FROM workspaces'))).toEqual(['Other']);
    // Pretending to be in the Kahf workspace with the other actor does not work either.
    const wrongWs = await withActor({ kind: 'person', id: other.actor as never, workspaceId: KAHF_WORKSPACE_ID }, (tx) => column(tx, 'SELECT slug FROM teams'), { pool: w.appPool });
    expect(wrongWs).toEqual([]);
  });

  it('every policy-bearing table can be read by every persona without recursion errors', async () => {
    const tables = [
      'workspaces', 'people', 'person_emails', 'workspace_members', 'auth_providers', 'identities', 'sessions',
      'invitations', 'teams', 'team_members', 'roles', 'role_members', 'acl_entries', 'stub_resources', 'events',
      'entity_links', 'capability_grants', 'scoped_kv', 'actors',
    ];
    for (const p of allPersonas) {
      for (const t of tables) {
        await expect(w.as(p, (tx) => tx.query(`SELECT count(*) FROM ${t}`)), `${p.key} reads ${t}`).resolves.toBeDefined();
      }
    }
  });

  it('the helpers answer for the caller from real membership', async () => {
    const h = (p: Persona) =>
      w.as(p, async (tx) => {
        const r = await tx.query<{ admin: boolean; role: string | null; eng: string | null; pid: string | null }>(
          `SELECT app.is_workspace_admin() AS admin, app.workspace_role() AS role, app.team_role($1) AS eng, app.person_id() AS pid`,
          [TEAM_IDS.Engineering],
        );
        return r.rows[0];
      });
    expect(await h(OMAR)).toEqual({ admin: true, role: 'owner', eng: 'lead', pid: OMAR.personId });
    expect(await h(NADIA)).toEqual({ admin: false, role: 'member', eng: 'member', pid: NADIA.personId });
    expect(await h(SAMEERA)).toEqual({ admin: false, role: 'member', eng: null, pid: SAMEERA.personId });
    expect(await h(LENA)).toEqual({ admin: false, role: 'guest', eng: null, pid: LENA.personId });
    // Setting the old actor_kind GUC does not change anything.
    const spoof = await w.as(LENA, async (tx) => {
      await tx.query(`SELECT set_config('app.actor_kind', 'system', true)`);
      return (await tx.query<{ a: boolean }>('SELECT app.is_workspace_admin() AS a')).rows[0]?.a;
    });
    expect(spoof).toBe(false);
  });

  it('plugin workspace storage is hidden from guests (scoped_kv)', async () => {
    await w.system((tx) =>
      tx.query(`INSERT INTO scoped_kv (plugin, scope_type, scope_id, key, value) VALUES ('p', 'workspace', $1, 'k', '1')`, [KAHF_WORKSPACE_ID]),
    );
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT key FROM scoped_kv'))).toEqual(['k']);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT key FROM scoped_kv'))).toEqual([]);
  });

  it('personaActor ids line up with the actors table', async () => {
    const rows = await w.system((tx) =>
      tx.query<{ id: string; ref_id: string }>(`SELECT id, ref_id FROM actors WHERE id = ANY($1::uuid[]) ORDER BY id`, [
        allPersonas.map((p) => personaActor(p).id),
      ]),
    );
    expect(rows.rows.map((r) => [r.id, r.ref_id])).toEqual(allPersonas.map((p) => [p.actorId, p.personId]));
  });
});
