import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  onboardingMigrationSource,
  personaActor,
  personas,
  seedFinishedSetup,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P10-01: who may read or write the setup checklist's state (workspace owners and admins of that workspace, nobody else), and the rules the database
// keeps whatever the code does: a launch is all of its fields, the checklist cannot be put away before a launch, and a mark takes only its own kind.

const { omar, nadia, tariq, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;

const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const count = (p: Persona, table: string): Promise<number> =>
  as(p, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table}`)).rows[0]?.n ?? 0));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, onboardingMigrationSource] });
  await createPersonas(db);
  await seedFinishedSetup(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('onboarding tables follow the RLS rules', () => {
  it('pass the harness and read without a per-row policy helper', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of ['onboarding_state', 'onboarding_marks']) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('seedFinishedSetup (the e2e servers) marks the install as set up, once, and seeding the personas again changes nothing', async () => {
    expect(await count(omar, 'onboarding_state')).toBe(1);
    const row = await as(omar, async (tx) => (await tx.query<{ dismissed_at: Date | null; launched_at: Date | null }>('SELECT dismissed_at, launched_at FROM app.onboarding_state')).rows[0]);
    expect(row?.dismissed_at).not.toBeNull();
    expect(row?.launched_at).not.toBeNull();
    await seedFinishedSetup(db);
    await createPersonas(db);
    expect(await count(omar, 'onboarding_state')).toBe(1);
  });

  it('a workspace admin reads and writes both tables', async () => {
    await as(omar, async (tx) => {
      await tx.query(`INSERT INTO app.onboarding_marks (workspace_id, step, kind, marked_by) VALUES ($1, 'code', 'skipped', $2)`, [omar.workspaceId, omar.actorId]);
      await tx.query(`UPDATE app.onboarding_state SET dismissed_at = NULL, dismissed_by = NULL`);
    });
    expect(await count(omar, 'onboarding_marks')).toBe(1);
  });

  it('a member, a team lead and a guest see nothing and cannot write', async () => {
    for (const person of [nadia, tariq, lena]) {
      expect(await count(person, 'onboarding_state'), person.name).toBe(0);
      expect(await count(person, 'onboarding_marks'), person.name).toBe(0);
      expect(
        await code(as(person, (tx) => tx.query(`INSERT INTO app.onboarding_marks (workspace_id, step, kind) VALUES ($1, 'servers', 'skipped')`, [omar.workspaceId]))),
        person.name,
      ).toBe('42501');
    }
    await as(nadia, (tx) => tx.query(`UPDATE app.onboarding_state SET launched_at = NULL, launch_team_id = NULL, launch_channel_id = NULL`));
    expect(await as(omar, async (tx) => (await tx.query('SELECT 1 FROM app.onboarding_state WHERE launched_at IS NOT NULL')).rows.length)).toBe(1);
  });

  it('an admin of another workspace sees none of this workspace\'s rows', async () => {
    const other = await withSystem(
      async (tx) => {
        const ws = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]!.id;
        const person = (await tx.query<{ id: string }>(`INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`, [ws])).rows[0]!.id;
        const actor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])).rows[0]!.id;
        await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
        await tx.query(`INSERT INTO app.onboarding_marks (workspace_id, step, kind) VALUES ($1, 'servers', 'skipped')`, [ws]);
        return { ws, actor };
      },
      { pool: sysPool },
    );
    const seen = await withActor({ kind: 'person', id: other.actor as never, workspaceId: other.ws as never }, async (tx) => (await tx.query<{ step: string }>('SELECT step FROM app.onboarding_marks')).rows, { pool: appPool });
    expect(seen.map((r) => r.step)).toEqual(['servers']);
    expect(await count(omar, 'onboarding_marks')).toBe(1);
  });
});

describe('onboarding tables keep their own rules', () => {
  it('a launch is all of its fields or none of them', async () => {
    const team = randomUUID();
    expect(await code(sys((tx) => tx.query(`UPDATE app.onboarding_state SET launched_at = NULL`)))).toBe('23514');
    expect(await code(sys((tx) => tx.query(`UPDATE app.onboarding_state SET launch_team_id = $1, launch_channel_id = NULL`, [team])))).toBe('23514');
  });

  it('the checklist cannot be put away without a launch', async () => {
    await sys(async (tx) => {
      await tx.query(`UPDATE app.onboarding_state SET launched_at = NULL, launched_by = NULL, launch_team_id = NULL, launch_channel_id = NULL, dismissed_at = NULL, dismissed_by = NULL`);
    });
    expect(await code(sys((tx) => tx.query(`UPDATE app.onboarding_state SET dismissed_at = now()`)))).toBe('23514');
  });

  it('a mark takes only the kind its step allows, and only the four steps that are decisions', async () => {
    const mark = (step: string, kind: string): Promise<unknown> =>
      sys((tx) => tx.query(`INSERT INTO app.onboarding_marks (workspace_id, step, kind) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, step) DO NOTHING`, [omar.workspaceId, step, kind]));
    expect(await code(mark('signin', 'skipped'))).toBe('23514');
    expect(await code(mark('infrastructure', 'acknowledged'))).toBe('23514');
    expect(await code(mark('models', 'skipped'))).toBe('23514');
    expect(await code(mark('signin', 'acknowledged'))).toBeUndefined();
  });
});
