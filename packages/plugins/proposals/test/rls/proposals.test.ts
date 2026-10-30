import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { ActorId, WorkspaceId } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  proposalsMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P7-01: who may read a proposal, who may write one, and the rule for who may apply it. Rows are written only by the definer functions; every assertion
// runs as a persona through the app pool, which is what a request is.

const { omar, nadia, tariq, sameera, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const HEAD = 'a'.repeat(40);

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

/** A proposal as `who`, through the definer door (the plugin's own call). */
const create = (who: Actor | Persona, path = 'skills/review/SKILL.md', team: string = ENG): Promise<string> => {
  const actor = 'kind' in who ? (who as Actor) : personaActor(who);
  return withActor(
    actor,
    async (tx) =>
      (
        await tx.query<{ id: string }>('SELECT app.proposals_create($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb) AS id', [
          team, path, 'put', 'A skill', '', 'new text\n', null, HEAD, false, '--- /dev/null\n+++ b/x\n@@ -0,0 +1,1 @@\n+new text', 1, 0, '[]',
        ])
      ).rows[0]!.id,
    { pool: appPool },
  );
};
const visible = (p: Persona): Promise<string[]> => as(p, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.proposals ORDER BY id')).rows.map((r) => r.id));
const whyNot = (p: Persona, id: string, self = false): Promise<string | null> =>
  as(p, async (tx) => (await tx.query<{ why: string | null }>('SELECT app.proposals_why_not($1::uuid, $2) AS why', [id, self])).rows[0]!.why);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, proposalsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('proposals (P7-01)', () => {
  it('passes the RLS harness and reads without a per-row policy helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      expect(await findPerRowPolicyCalls(admin, 'proposals')).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it('a proposal is read by its team and the workspace owner, by nobody else', async () => {
    const id = await create(nadia);
    expect(await visible(nadia)).toContain(id);
    expect(await visible(omar)).toContain(id);
    expect(await visible(tariq)).not.toContain(id); // leads Marketing, not Engineering
    expect(await visible(sameera)).not.toContain(id);
    expect(await visible(lena)).toEqual([]);
  });

  it('the app role cannot insert, update or delete a proposal directly', async () => {
    const id = await create(nadia);
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.proposals SET status = 'applied' WHERE id = $1", [id])))).toBeDefined();
    expect(await as(nadia, async (tx) => (await tx.query<{ status: string }>('SELECT status FROM app.proposals WHERE id = $1', [id])).rows[0]?.status)).toBe('open');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.proposals WHERE id = $1', [id])))).toBeDefined();
    expect(
      await code(
        as(omar, (tx) =>
          tx.query(
            `INSERT INTO app.proposals (workspace_id, team_id, author_id, author_kind, author_name, title, path, op, content, base_commit_sha, diff)
             VALUES ($1, $2, $3, 'person', 'x', 'x', 'TEAM.md', 'put', 'x', $4, 'x')`,
            [omar.workspaceId, ENG, omar.actorId, HEAD],
          ),
        ),
      ),
    ).toBeDefined();
  });

  it('only someone who can post in the team makes a proposal there', async () => {
    expect(await code(create(sameera))).toBeDefined(); // not on Engineering
    expect(await code(create(lena))).toBeDefined(); // a guest
    expect(await code(create(nadia, 'skills/a/SKILL.md', TEAM_IDS.Marketing))).toBeDefined(); // not on Marketing
  });

  it('a bot of the team can propose, and is named as the author', async () => {
    const botId = await sys(async (tx) => {
      const a = await tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()]);
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member')`, [ENG, a.rows[0]!.id, omar.workspaceId]);
      return a.rows[0]!.id;
    });
    const bot: Actor = { kind: 'bot', id: botId as ActorId, workspaceId: omar.workspaceId as WorkspaceId } as Actor;
    const id = await create(bot);
    const row = await as(omar, async (tx) => (await tx.query<{ author_kind: string }>('SELECT author_kind FROM app.proposals WHERE id = $1', [id])).rows[0]);
    expect(row?.author_kind).toBe('bot');
    // a bot never applies: the rule names it
    expect(await withActor(bot, async (tx) => (await tx.query<{ why: string | null }>('SELECT app.proposals_why_not($1::uuid, false) AS why', [id])).rows[0]!.why, { pool: appPool })).not.toBeNull();
  });

  it('who may apply: a lead or admin who is not the author; a member never; the author only as the sole approver', async () => {
    const id = await create(nadia);
    expect(await whyNot(nadia, id)).not.toBeNull(); // a member
    expect(await whyNot(omar, id)).toBeNull(); // lead and admin
    expect(await whyNot(tariq, id)).not.toBeNull(); // leads another team
    const own = await create(omar);
    // saved for review by the only person who could apply it: allowed (nobody else would ever be able to)
    expect(await whyNot(omar, own)).toBeNull();
    // once someone else leads the team, the author may not apply what they saved for review; the explicit one-step apply still goes through
    await sys((tx) => tx.query("UPDATE app.team_members SET role = 'lead' WHERE team_id = $1 AND actor_id = $2", [ENG, nadia.actorId]));
    try {
      expect(await whyNot(omar, own)).not.toBeNull();
      expect(await whyNot(omar, own, true)).toBeNull();
      expect(await whyNot(nadia, own)).toBeNull(); // the other lead
    } finally {
      await sys((tx) => tx.query("UPDATE app.team_members SET role = 'member' WHERE team_id = $1 AND actor_id = $2", [ENG, nadia.actorId]));
    }
    const done = await code(as(nadia, (tx) => tx.query("SELECT app.proposals_decide($1::uuid, 'applied', '', $2, false, NULL)", [id, HEAD])));
    expect(done).toBeDefined();
  });

  it('a decision is made once', async () => {
    const id = await create(nadia);
    await as(omar, (tx) => tx.query("SELECT app.proposals_decide($1::uuid, 'applied', 'ok', $2, false, '[]'::jsonb)", [id, HEAD]));
    const row = await as(omar, async (tx) => (await tx.query<{ status: string; applied_commit_sha: string }>('SELECT status, applied_commit_sha FROM app.proposals WHERE id = $1', [id])).rows[0]);
    expect(row).toMatchObject({ status: 'applied', applied_commit_sha: HEAD });
    expect(await code(as(omar, (tx) => tx.query("SELECT app.proposals_decide($1::uuid, 'rejected', '', NULL, false, NULL)", [id])))).toBeDefined();
  });
});
