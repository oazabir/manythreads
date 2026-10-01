import { randomUUID } from 'node:crypto';
import { KAHF_WORKSPACE_ID, NADIA, OMAR, TEAM_IDS, LENA, TARIQ, SAMEERA } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { putSecret, withActor, type Tx } from '../../src/index.ts';
import { column, createWorld, type World } from './world.ts';

let w: World;
let adam: { actor: string; person: string }; // non-owner admin of Kahf
let other: { ws: string; actor: string; person: string; secret: string; provider: string }; // admin of another workspace

const asAdam = <T>(fn: (tx: Tx) => Promise<T>) =>
  withActor({ kind: 'person', id: adam.actor as never, workspaceId: KAHF_WORKSPACE_ID }, fn, { pool: w.appPool });
const asOther = <T>(fn: (tx: Tx) => Promise<T>) =>
  withActor({ kind: 'person', id: other.actor as never, workspaceId: other.ws as never }, fn, { pool: w.appPool });

beforeAll(async () => {
  w = await createWorld();
  adam = await w.system(async (tx) => {
    const person = (
      await tx.query<{ id: string }>(
        `INSERT INTO people (workspace_id, display_name, primary_email) VALUES ($1, 'Adam', 'adam@kahf.example') RETURNING id`,
        [KAHF_WORKSPACE_ID],
      )
    ).rows[0]!.id;
    const actor = (
      await tx.query<{ id: string }>(`INSERT INTO actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [
        KAHF_WORKSPACE_ID,
        person,
      ])
    ).rows[0]!.id;
    await tx.query(`INSERT INTO workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'admin')`, [KAHF_WORKSPACE_ID, person]);
    return { actor, person };
  });
  const ids = await w.system(async (tx) => {
    const ws = (await tx.query<{ id: string }>(`INSERT INTO workspaces (slug, name) VALUES ('other', 'Other') RETURNING id`)).rows[0]!.id;
    const person = (
      await tx.query<{ id: string }>(
        `INSERT INTO people (workspace_id, display_name, primary_email) VALUES ($1, 'Xavi', 'x@other.example') RETURNING id`,
        [ws],
      )
    ).rows[0]!.id;
    const actor = (
      await tx.query<{ id: string }>(`INSERT INTO actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2) RETURNING id`, [ws, person])
    ).rows[0]!.id;
    await tx.query(`INSERT INTO workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'owner')`, [ws, person]);
    return { ws, actor, person };
  });
  const secret = await withActor({ kind: 'person', id: ids.actor as never, workspaceId: ids.ws as never }, (tx) => putSecret(tx, 'other-client-secret'), {
    pool: w.appPool,
  });
  const provider = await w.system(async (tx) =>
    (
      await tx.query<{ id: string }>(`INSERT INTO auth_providers (workspace_id, kind, secret_id) VALUES ($1, 'oidc', $2) RETURNING id`, [ids.ws, secret])
    ).rows[0]!.id,
  );
  other = { ...ids, secret, provider };
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const outcome = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);

describe('review fixes (migration 0007)', () => {
  it('an admin cannot change, suspend or add a verified address to the owner; the owner can edit herself', async () => {
    expect(await outcome(asAdam((tx) => tx.query(`UPDATE people SET primary_email = 'evil@x.example' WHERE id = $1`, [OMAR.personId])))).toMatch(/only an owner/);
    expect(await outcome(asAdam((tx) => tx.query(`UPDATE people SET status = 'suspended' WHERE id = $1`, [OMAR.personId])))).toMatch(/only an owner/);
    expect(
      await outcome(
        asAdam((tx) =>
          tx.query(`INSERT INTO person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, 'adam-takeover@x.example', now())`, [KAHF_WORKSPACE_ID, OMAR.personId]),
        ),
      ),
    ).toMatch(/row-level security/);
    // An admin still manages ordinary members; an owner manages admins.
    expect(await outcome(asAdam((tx) => tx.query(`INSERT INTO person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, 'nadia2@kahf.example', now())`, [KAHF_WORKSPACE_ID, NADIA.personId])))).toBe('ok');
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE people SET status = 'active' WHERE id = $1`, [adam.person])))).toBe('ok');
    expect(await w.system((tx) => column(tx, `SELECT primary_email FROM people WHERE id = $1`, [OMAR.personId]))).toEqual([OMAR.email]);
  });

  it('a secret belongs to its workspace: not deletable, not linkable from another', async () => {
    expect(await asAdam((tx) => column<boolean>(tx, `SELECT app.delete_secret($1)`, [other.secret]))).toEqual([false]);
    const orphan = await asOther((tx) => putSecret(tx, 'orphan'));
    expect(await asAdam((tx) => column<boolean>(tx, `SELECT app.delete_secret($1)`, [orphan]))).toEqual([false]);
    expect(await w.system((tx) => column(tx, `SELECT id FROM secrets WHERE id = $1`, [orphan]))).toEqual([orphan]);
    expect(
      await outcome(
        asAdam((tx) => tx.query(`INSERT INTO auth_providers (workspace_id, kind, secret_id) VALUES ($1, 'oidc', $2)`, [KAHF_WORKSPACE_ID, other.secret])),
      ),
    ).toMatch(/secret_id must be a secret of the row's workspace/);
    const own = await asAdam((tx) => putSecret(tx, 'adam-secret'));
    expect(await outcome(asAdam((tx) => tx.query(`INSERT INTO auth_providers (workspace_id, kind, secret_id) VALUES ($1, 'oidc', $2)`, [KAHF_WORKSPACE_ID, own])))).toBe('ok');
    expect(await asOther((tx) => column<boolean>(tx, `SELECT app.delete_secret($1)`, [orphan]))).toEqual([true]);
    // A system-created secret (no workspace) can be linked by the system only.
    const sys = await w.system((tx) => putSecret(tx, 'system-secret'));
    expect(await outcome(w.system((tx) => tx.query(`INSERT INTO auth_providers (workspace_id, kind, secret_id) VALUES ($1, 'oidc', $2)`, [KAHF_WORKSPACE_ID, sys])))).toBe('ok');
    expect(await outcome(asAdam((tx) => tx.query(`UPDATE auth_providers SET secret_id = $1 WHERE secret_id = $2`, [sys, own])))).toMatch(/secret_id must be/);
  });

  it('a revoked session cannot be reinstated by its person; the system still can', async () => {
    const sid = (
      await w.system((tx) =>
        tx.query<{ id: string }>(`INSERT INTO sessions (workspace_id, person_id, expires_at) VALUES ($1, $2, now() + interval '1 day') RETURNING id`, [KAHF_WORKSPACE_ID, NADIA.personId]),
      )
    ).rows[0]!.id;
    expect(await outcome(w.as(NADIA, (tx) => tx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sid])))).toBe('ok');
    expect(await outcome(w.as(NADIA, (tx) => tx.query(`UPDATE sessions SET revoked_at = NULL WHERE id = $1`, [sid])))).toMatch(/cannot be reinstated/);
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE sessions SET revoked_at = NULL WHERE id = $1`, [sid])))).toMatch(/cannot be reinstated/);
    expect(await outcome(w.system((tx) => tx.query(`UPDATE sessions SET revoked_at = NULL WHERE id = $1`, [sid])))).toBe('ok');
  });

  it('rows cannot point at a person, team, role or provider of another workspace', async () => {
    const otherTeam = await w.system(async (tx) =>
      (await tx.query<{ id: string }>(`INSERT INTO teams (workspace_id, slug, name) VALUES ($1, 't', 'T') RETURNING id`, [other.ws])).rows[0]!.id,
    );
    const otherRole = await w.system(async (tx) =>
      (await tx.query<{ id: string }>(`INSERT INTO roles (workspace_id, name) VALUES ($1, 'role:x') RETURNING id`, [other.ws])).rows[0]!.id,
    );
    const foreignPerson = [
      `INSERT INTO workspace_members (workspace_id, person_id, role) VALUES ($1, $2, 'member')`,
      `INSERT INTO person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, 'foreign@x.example', now())`,
      `INSERT INTO role_members (role_id, person_id, workspace_id) SELECT id, $2, $1 FROM roles WHERE workspace_id = $1 LIMIT 1`,
    ];
    for (const sql of foreignPerson) {
      expect(await outcome(w.system((tx) => tx.query(sql, [KAHF_WORKSPACE_ID, other.person]))), sql).toMatch(/must belong to the row's workspace/);
      expect(await outcome(asAdam((tx) => tx.query(sql, [KAHF_WORKSPACE_ID, other.person]))), sql).toMatch(/must belong|row-level security/);
    }
    expect(
      await outcome(asAdam((tx) => tx.query(`INSERT INTO invitations (workspace_id, team_id, email, role, token_hash) VALUES ($1, $2, 'a@b.c', 'member', $3)`, [KAHF_WORKSPACE_ID, otherTeam, Buffer.from('y')]))),
    ).toMatch(/team_id must belong/);
    expect(
      await outcome(w.system((tx) => tx.query(`INSERT INTO role_members (role_id, person_id, workspace_id) VALUES ($1, $2, $3)`, [otherRole, NADIA.personId, KAHF_WORKSPACE_ID]))),
    ).toMatch(/role_id must belong/);
    expect(
      await outcome(w.system((tx) => tx.query(`INSERT INTO identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, 's')`, [KAHF_WORKSPACE_ID, NADIA.personId, other.provider]))),
    ).toMatch(/provider_id must belong/);
    // The same rows inside the workspace are fine.
    expect(
      await outcome(asAdam((tx) => tx.query(`INSERT INTO invitations (workspace_id, team_id, email, role, token_hash) VALUES ($1, $2, 'ok@b.c', 'member', $3)`, [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, Buffer.from('ok1')]))),
    ).toBe('ok');
  });

  it('a lead cannot re-open an accepted invitation, swap its token or move it; the system accepts', async () => {
    const id = (
      await w.system((tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO invitations (workspace_id, team_id, email, role, token_hash) VALUES ($1,$2,'z@z.z','member',$3) RETURNING id`,
          [KAHF_WORKSPACE_ID, TEAM_IDS.Marketing, Buffer.from('zz')],
        ),
      )
    ).rows[0]!.id;
    expect(await outcome(w.as(TARIQ, (tx) => tx.query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [id])))).toMatch(/only the system/);
    expect(await outcome(w.as(TARIQ, (tx) => tx.query(`UPDATE invitations SET token_hash = $2 WHERE id = $1`, [id, Buffer.from('mine')])))).toMatch(/only the system/);
    expect(await outcome(w.as(OMAR, (tx) => tx.query(`UPDATE invitations SET token_hash = $2 WHERE id = $1`, [id, Buffer.from('mine')])))).toMatch(/only the system/);
    expect(await outcome(w.as(TARIQ, (tx) => tx.query(`UPDATE invitations SET expires_at = now() + interval '1 day' WHERE id = $1`, [id])))).toBe('ok');
    expect(await outcome(w.system((tx) => tx.query(`UPDATE invitations SET accepted_at = now() WHERE id = $1`, [id])))).toBe('ok');
  });

  it('spoofing another workspace in the GUC grants nothing (lookups check the actor belongs to it)', async () => {
    const asAdamInOther = <T>(fn: (tx: Tx) => Promise<T>) => withActor({ kind: 'person', id: adam.actor as never, workspaceId: other.ws as never }, fn, { pool: w.appPool });
    expect(await asAdamInOther((tx) => column(tx, `SELECT app.workspace_role()`))).toEqual([null]);
    expect(await asAdamInOther((tx) => column(tx, `SELECT app.is_workspace_admin()::text`))).toEqual(['false']);
    expect(await asAdamInOther((tx) => column(tx, `SELECT slug FROM workspaces`))).toEqual([]);
    expect(await outcome(asAdamInOther((tx) => tx.query(`SELECT app.put_secret($1, '\\x00', '\\x00', 'k')`, [randomUUID()])))).toMatch(/only a workspace admin/);
    expect(await asAdam((tx) => column(tx, `SELECT slug FROM workspaces`))).toEqual(['kahf-software']);
    void LENA; void SAMEERA;
  });
});
