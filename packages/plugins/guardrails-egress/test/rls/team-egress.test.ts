import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  guardrailsEgressMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P10-04: who may read and write a team's list of reachable hosts. Workspace admins read every team's row and write them; a member reads the rows of
// their own teams (the check runs in a bot's transaction); nobody else reads a team's list, and nobody but an admin writes one.

const { omar, nadia, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const teamsSeen = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ team_id: string }>('SELECT team_id FROM app.team_egress ORDER BY team_id')).rows.map((r) => r.team_id));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, guardrailsEgressMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await as(omar, async (tx) => {
    for (const team of [ENG, MKT]) {
      await tx.query(`INSERT INTO app.team_egress (team_id, workspace_id, enforce, hosts, updated_by) VALUES ($1, $2, true, ARRAY['api.example.org'], $3)`, [team, omar.workspaceId, omar.actorId]);
    }
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('team_egress (P10-04)', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'team_egress')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('is read by a workspace admin for every team and by a member for their own teams only', async () => {
    expect((await teamsSeen(omar)).sort()).toEqual([ENG, MKT].sort());
    expect(await teamsSeen(nadia)).toEqual([ENG]); // an Engineering member
    expect(await teamsSeen(tariq)).toEqual([MKT]); // leads Marketing, not in Engineering
  });

  it('is written only by a workspace admin: a member or a team lead changes nothing and adds nothing', async () => {
    for (const p of [nadia, tariq]) {
      const changed = await as(p, async (tx) => (await tx.query(`UPDATE app.team_egress SET enforce = false, hosts = '{}'`)).rowCount);
      expect(changed, p.key).toBe(0);
      expect(await code(as(p, (tx) => tx.query(`INSERT INTO app.team_egress (team_id, workspace_id) VALUES (gen_random_uuid(), $1)`, [p.workspaceId])))).toBeDefined();
    }
    expect(await as(omar, async (tx) => (await tx.query<{ enforce: boolean }>('SELECT enforce FROM app.team_egress WHERE team_id = $1', [ENG])).rows[0]!.enforce)).toBe(true);
    // the app role cannot delete a row at all
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.team_egress')))).toBe('42501');
  });

  it('refuses a proxy address that carries a password or is not http(s), and a list of more than 200 hosts', async () => {
    for (const bad of ['http://user:pw@proxy.internal:3128', 'ftp://proxy.internal', 'http://proxy.internal/path']) {
      expect(await code(as(omar, (tx) => tx.query('UPDATE app.team_egress SET proxy_url = $1 WHERE team_id = $2', [bad, ENG]))), bad).toBe('23514');
    }
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.team_egress SET hosts = (SELECT array_agg('h' || i || '.example.org') FROM generate_series(1, 201) i) WHERE team_id = $1`, [ENG])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.team_egress SET proxy_url = 'https://proxy.internal:3128' WHERE team_id = $1`, [ENG])))).toBeUndefined();
  });
  it('does not let an admin file a list for a team of another workspace under their own', async () => {
    const foreignTeam = await withSystem(
      async (tx) => {
        const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('elsewhere', 'Elsewhere') RETURNING id`)).rows[0]!.id;
        return (await tx.query<{ id: string }>(`INSERT INTO app.teams (workspace_id, slug, name) VALUES ($1, 'ops', 'Ops') RETURNING id`, [ws])).rows[0]!.id;
      },
      { pool: sysPool },
    );
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.team_egress (team_id, workspace_id, enforce) VALUES ($1, $2, true)`, [foreignTeam, omar.workspaceId])))).toBe('42501');
    expect(await teamsSeen(omar)).not.toContain(foreignTeam);
  });
});
