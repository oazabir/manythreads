import { randomUUID } from 'node:crypto';
import { findPerRowPolicyCalls, KAHF_WORKSPACE_ID, LENA, NADIA, OMAR, PRIYA, RAFI, SAMEERA, TARIQ, TEAM_IDS, testClient, type Persona } from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { column, createWorld, type World } from './world.ts';

// Kernel migration 0016 (P20-01): readable_space_ids, the admin open of a Personal space, people.suspended_at, and the one
// access-rule shape every space table uses (proved on a probe table that carries the policy template word for word).

let w: World;
let owner: pg.Client;
const sorted = (xs: string[]): string[] => [...xs].sort();
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;
const SUP = TEAM_IDS['Customer support'];
const allTeams = Object.values(TEAM_IDS);

const spaces = async (p: Persona, perm = 'read'): Promise<string[]> =>
  sorted(((await w.as(p, (tx) => column<string[]>(tx, 'SELECT app.readable_space_ids($1)', [perm])))[0] ?? []) as string[]);
const expected = (...ids: string[]): string[] => sorted(ids);

/** The policy template of migration 0016, on a throwaway table. */
const PROBE_SQL = `
  CREATE TABLE app.space_probe (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
    team_id         uuid REFERENCES app.teams (id) ON DELETE CASCADE,
    owner_person_id uuid REFERENCES app.people (id) ON DELETE CASCADE,
    name            text NOT NULL,
    CHECK (num_nonnulls(team_id, owner_person_id) = 1)
  );
  CREATE INDEX space_probe_team ON app.space_probe (team_id) WHERE team_id IS NOT NULL;
  CREATE INDEX space_probe_owner ON app.space_probe (owner_person_id) WHERE owner_person_id IS NOT NULL;
  CREATE INDEX space_probe_workspace ON app.space_probe (workspace_id);
  COMMENT ON TABLE app.space_probe IS 'rls: person — probe of the space policy template';
  ALTER TABLE app.space_probe ENABLE ROW LEVEL SECURITY;
  ALTER TABLE app.space_probe FORCE ROW LEVEL SECURITY;
  CREATE POLICY space_probe_select ON app.space_probe FOR SELECT USING (
    (SELECT app.is_system())
    OR owner_person_id = ANY ((SELECT app.readable_space_ids('read'))::uuid[])
    OR team_id = ANY ((SELECT app.readable_team_ids('read'))::uuid[])
  );
  CREATE POLICY space_probe_insert ON app.space_probe FOR INSERT WITH CHECK (
    (SELECT app.is_system())
    OR (workspace_id = (SELECT app.workspace_id())
        AND (owner_person_id = (SELECT app.person_id()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[])))
  );
  CREATE POLICY space_probe_update ON app.space_probe FOR UPDATE
    USING ((SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]))
    WITH CHECK ((SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]));
  CREATE POLICY space_probe_delete ON app.space_probe FOR DELETE
    USING ((SELECT app.is_system()) OR owner_person_id = (SELECT app.person_id()) OR team_id = ANY ((SELECT app.readable_team_ids('post'))::uuid[]));
  GRANT SELECT, INSERT, UPDATE, DELETE ON app.space_probe TO manythreads_app;
`;

const seedProbe = (): Promise<unknown> =>
  w.system(async (tx) => {
    const rows: Array<[string | null, string | null, string]> = [
      [ENG, null, 'eng-note'],
      [MKT, null, 'mkt-note'],
      [SUP, null, 'sup-note'],
      [null, NADIA.personId, 'nadia-personal'],
      [null, SAMEERA.personId, 'sameera-personal'],
      [null, LENA.personId, 'lena-personal'],
      [null, OMAR.personId, 'omar-personal'],
    ];
    for (const [team, person, name] of rows) {
      await tx.query('INSERT INTO app.space_probe (workspace_id, team_id, owner_person_id, name) VALUES ($1, $2, $3, $4)', [KAHF_WORKSPACE_ID, team, person, name]);
    }
  });

const names = (p: Persona): Promise<string[]> =>
  w.as(p, (tx) => column<string>(tx, 'SELECT name FROM app.space_probe ORDER BY name'));

const openSpace = (p: Persona, target: string, reason: string) =>
  w.as(p, (tx) => tx.query<{ access_id: string; valid_until: Date }>('SELECT * FROM app.open_personal_space($1, $2)', [target, reason]));

beforeAll(async () => {
  w = await createWorld();
  owner = testClient({ connectionString: w.db.ownerUrl });
  await owner.connect();
  await owner.query(PROBE_SQL);
  await seedProbe();
}, 120_000);
afterAll(async () => {
  await owner?.end();
  await w?.close();
}, 60_000);

describe('app.readable_space_ids', () => {
  it('a member sees their own space and their teams; a guest only their own; Lena has no team', async () => {
    expect(await spaces(NADIA)).toEqual(expected(NADIA.personId, ENG));
    expect(await spaces(SAMEERA)).toEqual(expected(SAMEERA.personId, SUP));
    expect(await spaces(PRIYA)).toEqual(expected(PRIYA.personId, ENG, MKT));
    expect(await spaces(LENA)).toEqual(expected(LENA.personId));
  });

  it('an admin sees every team and their own space, but not other people without an open', async () => {
    expect(await spaces(OMAR)).toEqual(expected(OMAR.personId, ...allTeams));
  });

  it('follows the permission ranks: post is the same for members, manage is leads only, an unknown word is nothing', async () => {
    expect(await spaces(NADIA, 'post')).toEqual(expected(NADIA.personId, ENG));
    expect(await spaces(NADIA, 'manage')).toEqual(expected(NADIA.personId));
    expect(await spaces(TARIQ, 'manage')).toEqual(expected(TARIQ.personId, MKT));
    expect(await spaces(NADIA, 'write')).toEqual([]);
    expect(await spaces(NADIA, 'nope')).toEqual([]);
  });

  it('the team part is exactly readable_team_ids, for every persona and permission', async () => {
    for (const p of [OMAR, NADIA, RAFI, SAMEERA, TARIQ, PRIYA, LENA]) {
      for (const perm of ['read', 'post', 'manage']) {
        const teamsOnly = (await w.as(p, (tx) => column<string[]>(tx, 'SELECT app.readable_team_ids($1)', [perm])))[0] ?? [];
        expect(await spaces(p, perm), `${p.key} ${perm}`).toEqual(expected(p.personId, ...teamsOnly));
      }
    }
  });

  it('is empty for the system actor', async () => {
    const ids = await w.system((tx) => column<string[]>(tx, "SELECT app.readable_space_ids('read')"));
    expect(ids[0]).toEqual([]);
  });
});

describe('the admin open of a Personal space', () => {
  it('only an owner or admin may open; own space, unknown person, empty or long reason are refused', async () => {
    await expect(openSpace(TARIQ, NADIA.personId, 'curious')).rejects.toMatchObject({ code: '42501' });
    await expect(openSpace(LENA, NADIA.personId, 'curious')).rejects.toMatchObject({ code: '42501' });
    await expect(w.system((tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [NADIA.personId, 'x']))).rejects.toMatchObject({ code: '42501' });
    await expect(openSpace(OMAR, OMAR.personId, 'my own')).rejects.toMatchObject({ code: '22023' });
    await expect(openSpace(OMAR, randomUUID(), 'nobody')).rejects.toMatchObject({ code: '23503' });
    await expect(openSpace(OMAR, NADIA.personId, '   ')).rejects.toMatchObject({ code: '22023' });
    await expect(openSpace(OMAR, NADIA.personId, 'x'.repeat(301))).rejects.toMatchObject({ code: '22023' });
    expect((await w.system((tx) => column(tx, 'SELECT id FROM app.personal_space_access'))).length).toBe(0);
  });

  it("another workspace's person is refused", async () => {
    const other = randomUUID();
    const otherPerson = randomUUID();
    await owner.query(`INSERT INTO app.workspaces (id, name, slug) VALUES ($1, 'Other', 'other')`, [other]);
    await owner.query(`INSERT INTO app.people (id, workspace_id, display_name, primary_email) VALUES ($1, $2, 'Zed', 'zed@other.example')`, [otherPerson, other]);
    await expect(openSpace(OMAR, otherPerson, 'across')).rejects.toMatchObject({ code: '23503' });
  });

  let accessId = '';
  it('a live open adds that person to the admin read set, only for read, only for that admin', async () => {
    const opened = await openSpace(OMAR, NADIA.personId, '  Nadia asked me to recover a note  ');
    accessId = opened.rows[0]?.access_id ?? '';
    const until = opened.rows[0]?.valid_until.getTime() ?? 0;
    expect(until - Date.now()).toBeGreaterThan(59 * 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(60 * 60_000);

    expect(await spaces(OMAR)).toEqual(expected(OMAR.personId, NADIA.personId, ...allTeams));
    expect(await spaces(OMAR, 'post')).toEqual(expected(OMAR.personId, ...allTeams));
    expect(await spaces(OMAR, 'manage')).toEqual(expected(OMAR.personId, ...allTeams));
    expect(await spaces(NADIA)).toEqual(expected(NADIA.personId, ENG));
    expect(await spaces(SAMEERA)).toEqual(expected(SAMEERA.personId, SUP));
  });

  it('the person sees the open with its reason; nobody else does but the admin who made it', async () => {
    const seen = (p: Persona) => w.as(p, (tx) => tx.query<{ reason: string; person_id: string }>('SELECT reason, person_id FROM app.personal_space_access'));
    expect((await seen(NADIA)).rows).toEqual([{ reason: 'Nadia asked me to recover a note', person_id: NADIA.personId }]);
    expect((await seen(OMAR)).rows.length).toBe(1);
    expect((await seen(SAMEERA)).rows).toEqual([]);
    expect((await seen(LENA)).rows).toEqual([]);
  });

  it('no request role can write the table directly; the open row cannot be edited by the person or the admin', async () => {
    const direct = `INSERT INTO app.personal_space_access (workspace_id, person_id, admin_actor_id, reason, expires_at)
                    VALUES ($1, $2, $3, 'x', now() + interval '1 hour')`;
    await expect(w.as(OMAR, (tx) => tx.query(direct, [KAHF_WORKSPACE_ID, SAMEERA.personId, OMAR.actorId]))).rejects.toMatchObject({ code: '42501' });
    await expect(w.as(NADIA, (tx) => tx.query('DELETE FROM app.personal_space_access'))).rejects.toMatchObject({ code: '42501' });
    await expect(w.as(OMAR, (tx) => tx.query("UPDATE app.personal_space_access SET expires_at = now() + interval '30 days'"))).rejects.toMatchObject({ code: '42501' });
  });

  it('an expired open reads nothing', async () => {
    await w.system((tx) =>
      tx.query("UPDATE app.personal_space_access SET opened_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1", [accessId]),
    );
    expect(await spaces(OMAR)).toEqual(expected(OMAR.personId, ...allTeams));
  });
});

describe('the one access-rule shape (probe table)', () => {
  it('reads: a member sees their team and their own space, nobody sees another Personal space', async () => {
    expect(await names(NADIA)).toEqual(['eng-note', 'nadia-personal']);
    expect(await names(SAMEERA)).toEqual(['sameera-personal', 'sup-note']);
    expect(await names(PRIYA)).toEqual(['eng-note', 'mkt-note']); // Priya has no personal row in the probe
    expect(await names(LENA)).toEqual(['lena-personal']);
    expect(await names(OMAR)).toEqual(['eng-note', 'mkt-note', 'omar-personal', 'sup-note']);
  });

  it("an admin reads Nadia's rows exactly while the open is live, and never Sameera's", async () => {
    await openSpace(OMAR, NADIA.personId, 'second look');
    expect(await names(OMAR)).toEqual(['eng-note', 'mkt-note', 'nadia-personal', 'omar-personal', 'sup-note']);
    await w.system((tx) => tx.query("UPDATE app.personal_space_access SET opened_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'"));
    expect(await names(OMAR)).toEqual(['eng-note', 'mkt-note', 'omar-personal', 'sup-note']);
  });

  it('an open is read-only: the admin cannot insert, change or delete the open person\'s rows', async () => {
    await openSpace(OMAR, NADIA.personId, 'third look');
    const insertAs = (p: Persona, owned: string | null, team: string | null) =>
      w.as(p, (tx) =>
        tx.query('INSERT INTO app.space_probe (workspace_id, team_id, owner_person_id, name) VALUES ($1, $2, $3, $4)', [KAHF_WORKSPACE_ID, team, owned, 'new']),
      );
    await expect(insertAs(OMAR, NADIA.personId, null)).rejects.toMatchObject({ code: '42501' });
    const changed = await w.as(OMAR, (tx) => tx.query("UPDATE app.space_probe SET name = 'edited' WHERE owner_person_id = $1", [NADIA.personId]));
    expect(changed.rowCount).toBe(0);
    const removed = await w.as(OMAR, (tx) => tx.query('DELETE FROM app.space_probe WHERE owner_person_id = $1', [NADIA.personId]));
    expect(removed.rowCount).toBe(0);
    expect(await names(NADIA)).toEqual(['eng-note', 'nadia-personal']);
  });

  it('writes: the owner writes their own space, a member their team, nobody a space that is not theirs', async () => {
    const insertAs = (p: Persona, owned: string | null, team: string | null, name: string) =>
      w.as(p, (tx) =>
        tx.query('INSERT INTO app.space_probe (workspace_id, team_id, owner_person_id, name) VALUES ($1, $2, $3, $4)', [KAHF_WORKSPACE_ID, team, owned, name]),
      );
    await insertAs(NADIA, NADIA.personId, null, 'nadia-two');
    await insertAs(NADIA, null, ENG, 'eng-two');
    await expect(insertAs(NADIA, SAMEERA.personId, null, 'forged')).rejects.toMatchObject({ code: '42501' });
    await expect(insertAs(SAMEERA, null, ENG, 'wrong-team')).rejects.toMatchObject({ code: '42501' });
    await expect(insertAs(LENA, null, ENG, 'guest-team')).rejects.toMatchObject({ code: '42501' });
    await insertAs(LENA, LENA.personId, null, 'lena-two');
    // Exactly one owner: neither is refused by the policy for a request, and by the CHECK even for the system role.
    await expect(w.as(NADIA, (tx) => tx.query('INSERT INTO app.space_probe (workspace_id, name) VALUES ($1, $2)', [KAHF_WORKSPACE_ID, 'no owner']))).rejects.toMatchObject({ code: '42501' });
    await expect(w.system((tx) => tx.query('INSERT INTO app.space_probe (workspace_id, name) VALUES ($1, $2)', [KAHF_WORKSPACE_ID, 'no owner']))).rejects.toMatchObject({ code: '23514' });
    await expect(
      w.as(NADIA, (tx) =>
        tx.query('INSERT INTO app.space_probe (workspace_id, team_id, owner_person_id, name) VALUES ($1, $2, $3, $4)', [KAHF_WORKSPACE_ID, ENG, NADIA.personId, 'two owners']),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const own = await w.as(NADIA, (tx) => tx.query("UPDATE app.space_probe SET name = 'nadia-renamed' WHERE name = 'nadia-two'"));
    expect(own.rowCount).toBe(1);
    const theirs = await w.as(SAMEERA, (tx) => tx.query("UPDATE app.space_probe SET name = 'stolen' WHERE name IN ('nadia-renamed', 'eng-two')"));
    expect(theirs.rowCount).toBe(0);
    // A Personal row cannot be handed to somebody else by its owner.
    await expect(w.as(NADIA, (tx) => tx.query('UPDATE app.space_probe SET owner_person_id = $1 WHERE name = $2', [SAMEERA.personId, 'nadia-renamed']))).rejects.toMatchObject({ code: '42501' });
    expect((await w.as(NADIA, (tx) => tx.query("DELETE FROM app.space_probe WHERE name = 'nadia-renamed'"))).rowCount).toBe(1);
  });

  it('keeps the hoisted shape: no per-row policy call in the plan', async () => {
    expect(await findPerRowPolicyCalls(owner, 'space_probe')).toEqual([]);
    expect(await findPerRowPolicyCalls(owner, 'personal_space_access')).toEqual([]);
  });
});

describe('people.suspended_at', () => {
  const setStatus = (status: string) =>
    w.system((tx) => tx.query<{ suspended_at: Date | null }>('UPDATE app.people SET status = $2 WHERE id = $1 RETURNING suspended_at', [RAFI.personId, status]));

  it('is set when a person is deactivated, kept while they stay so, cleared on reactivation; a suspended person has no spaces', async () => {
    const before = await w.system((tx) => tx.query<{ suspended_at: Date | null }>('SELECT suspended_at FROM app.people WHERE id = $1', [RAFI.personId]));
    expect(before.rows[0]?.suspended_at).toBeNull();
    expect(await spaces(RAFI)).toEqual(expected(RAFI.personId, ENG));

    const first = (await setStatus('suspended')).rows[0]?.suspended_at ?? null;
    expect(first).toBeInstanceOf(Date);
    expect(await spaces(RAFI)).toEqual([]);
    expect(await names(RAFI)).toEqual([]);

    await w.system((tx) => tx.query("UPDATE app.people SET display_name = 'Rafi R', suspended_at = now() + interval '1 day' WHERE id = $1", [RAFI.personId]));
    const kept = await w.system((tx) => tx.query<{ suspended_at: Date | null }>('SELECT suspended_at FROM app.people WHERE id = $1', [RAFI.personId]));
    expect(kept.rows[0]?.suspended_at?.getTime()).toBe(first?.getTime());

    expect((await setStatus('active')).rows[0]?.suspended_at).toBeNull();
    expect(await spaces(RAFI)).toEqual(expected(RAFI.personId, ENG));
  });

  it('cannot be set on an active person', async () => {
    const r = await w.system((tx) => tx.query<{ suspended_at: Date | null }>("UPDATE app.people SET suspended_at = now() WHERE id = $1 RETURNING suspended_at", [RAFI.personId]));
    expect(r.rows[0]?.suspended_at).toBeNull();
  });
});
