import { randomUUID } from 'node:crypto';
import { LENA, NADIA, OMAR, PRIYA, RAFI, SAMEERA, TARIQ, TEAM_IDS, KAHF_WORKSPACE_ID } from '@majlis/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type PersonRow,
  type SessionRow,
  type WorkspaceRow,
  deleteSecret,
  getSecret,
  hashPassword,
  putSecret,
  toPerson,
  toSession,
  toWorkspace,
  verifyPassword,
} from '../../src/index.ts';
import { column, createWorld, type World } from './world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w?.close();
}, 60_000);

const emails = (rows: { primary_email: string }[]) => rows.map((r) => r.primary_email).sort();

describe('workspaces, people, workspace_members (WR, P)', () => {
  it('every member reads the workspace, including the guest', async () => {
    for (const p of [OMAR, NADIA, LENA]) {
      const r = await w.as(p, (tx) => tx.query<WorkspaceRow>('SELECT * FROM workspaces'));
      expect(r.rows.map((row) => toWorkspace(row).name)).toEqual(['Kahf Software']);
    }
  });

  it('a guest sees only herself in people and workspace_members, nobody else', async () => {
    const people = await w.as(LENA, (tx) => tx.query<{ primary_email: string }>('SELECT primary_email FROM people'));
    expect(emails(people.rows)).toEqual([LENA.email]);
    const members = await w.as(LENA, (tx) => column(tx, 'SELECT person_id FROM workspace_members'));
    expect(members).toEqual([LENA.personId]);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT id FROM roles'))).toEqual([]);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT team_id FROM team_members'))).toEqual([]);
  });

  it('a member reads all seven people and the roster', async () => {
    const people = await w.as(SAMEERA, (tx) => tx.query<{ primary_email: string }>('SELECT primary_email FROM people'));
    expect(people.rows).toHaveLength(7);
    expect(await w.as(SAMEERA, (tx) => column(tx, 'SELECT person_id FROM workspace_members'))).toHaveLength(7);
  });

  it('only an admin updates the workspace', async () => {
    const denied = await w.as(NADIA, (tx) => tx.query(`UPDATE workspaces SET name = 'Hacked' RETURNING id`));
    expect(denied.rowCount).toBe(0);
    const ok = await w.as(OMAR, (tx) => tx.query(`UPDATE workspaces SET self_signup = true RETURNING *`));
    expect(ok.rowCount).toBe(1);
    await w.as(OMAR, (tx) => tx.query(`UPDATE workspaces SET self_signup = false`));
  });

  it('a person edits her own name but not her email or status, and not other people', async () => {
    const own = await w.as(NADIA, (tx) =>
      tx.query<PersonRow>(`UPDATE people SET display_name = 'Nadia K' WHERE id = $1 RETURNING *`, [NADIA.personId]),
    );
    expect(toPerson(own.rows[0]!).displayName).toBe('Nadia K');
    await w.as(NADIA, (tx) => tx.query(`UPDATE people SET display_name = 'Nadia' WHERE id = $1`, [NADIA.personId]));
    await expect(
      w.as(NADIA, (tx) => tx.query(`UPDATE people SET primary_email = 'x@evil.example' WHERE id = $1`, [NADIA.personId])),
    ).rejects.toThrow(/only a workspace admin/);
    await expect(
      w.as(NADIA, (tx) => tx.query(`UPDATE people SET status = 'suspended' WHERE id = $1`, [NADIA.personId])),
    ).rejects.toThrow(/only a workspace admin/);
    const other = await w.as(NADIA, (tx) => tx.query(`UPDATE people SET display_name = 'Pwned' WHERE id = $1`, [RAFI.personId]));
    expect(other.rowCount).toBe(0);
  });

  it('only an owner may grant or touch the owner role', async () => {
    // Make Tariq an admin through the system, then he cannot promote himself to owner.
    await w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'admin' WHERE person_id = $1`, [TARIQ.personId]));
    try {
      await expect(
        w.as(TARIQ, (tx) => tx.query(`UPDATE workspace_members SET role = 'owner' WHERE person_id = $1`, [TARIQ.personId])),
      ).rejects.toThrow(/row-level security/);
      const demote = await w.as(TARIQ, (tx) =>
        tx.query(`UPDATE workspace_members SET role = 'member' WHERE person_id = $1`, [OMAR.personId]),
      );
      expect(demote.rowCount).toBe(0);
      // An admin can manage members, though.
      const ok = await w.as(TARIQ, (tx) =>
        tx.query(`UPDATE workspace_members SET role = 'member' WHERE person_id = $1`, [RAFI.personId]),
      );
      expect(ok.rowCount).toBe(1);
    } finally {
      await w.system((tx) => tx.query(`UPDATE workspace_members SET role = 'member' WHERE person_id = $1`, [TARIQ.personId]));
    }
  });

  it('a suspended person loses every workspace role at once', async () => {
    await w.as(OMAR, (tx) => tx.query(`UPDATE people SET status = 'suspended' WHERE id = $1`, [NADIA.personId]));
    try {
      expect(await w.as(NADIA, (tx) => column(tx, 'SELECT id FROM workspaces'))).toEqual([]);
      expect(await w.as(NADIA, (tx) => column(tx, 'SELECT id FROM teams'))).toEqual([]);
    } finally {
      await w.as(OMAR, (tx) => tx.query(`UPDATE people SET status = 'active' WHERE id = $1`, [NADIA.personId]));
    }
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT id FROM teams'))).toEqual([TEAM_IDS.Engineering]);
  });

  it('person_emails: own rows, unverified inserts only', async () => {
    await w.as(NADIA, (tx) =>
      tx.query(`INSERT INTO person_emails (workspace_id, person_id, email) VALUES ($1, $2, 'nadia@home.example')`, [
        KAHF_WORKSPACE_ID,
        NADIA.personId,
      ]),
    );
    await expect(
      w.as(NADIA, (tx) =>
        tx.query(
          `INSERT INTO person_emails (workspace_id, person_id, email, verified_at) VALUES ($1, $2, 'nadia@other.example', now())`,
          [KAHF_WORKSPACE_ID, NADIA.personId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await w.as(RAFI, (tx) => column(tx, 'SELECT email FROM person_emails'))).toEqual([]);
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT email FROM person_emails'))).toEqual(['nadia@home.example']);
    expect(await w.as(OMAR, (tx) => column(tx, 'SELECT email FROM person_emails'))).toEqual(['nadia@home.example']);
    // Verification is system: a person cannot mark her own address verified.
    const upd = await w.as(NADIA, (tx) => tx.query(`UPDATE person_emails SET verified_at = now()`));
    expect(upd.rowCount).toBe(0);
  });
});

describe('S tables: nobody as majlis_app can read secrets, password hashes, verification tokens or the session cache', () => {
  const tables = ['secrets', 'password_credentials', 'email_verifications', 'session_cache', 'team_pending_files'];

  it('majlis_app has no privilege at all', async () => {
    const r = await w.system((tx) =>
      tx.query<{ t: string; priv: string; ok: boolean }>(
        `SELECT t, priv, has_table_privilege('majlis_app', 'app.' || t, priv) AS ok
         FROM unnest($1::text[]) AS t, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS priv`,
        [tables],
      ),
    );
    expect(r.rows.filter((row) => row.ok)).toEqual([]);
  });

  it.each(tables)('Omar (workspace owner) cannot SELECT %s', async (table) => {
    await expect(w.as(OMAR, (tx) => tx.query(`SELECT * FROM ${table}`))).rejects.toThrow(/permission denied/);
  });

  it('password hashes are argon2id and verify; the system pool alone reads them', async () => {
    const rows = await w.system((tx) => tx.query<{ hash: string }>('SELECT hash FROM password_credentials'));
    expect(rows.rows).toHaveLength(7);
    for (const { hash } of rows.rows) expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(rows.rows[0]?.hash ?? '', 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(rows.rows[0]?.hash ?? '', 'wrong-horse-battery')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect((await hashPassword('another-long-password')).startsWith('$argon2id$')).toBe(true);
  });

  it('a non-argon2id hash is refused by the CHECK', async () => {
    await expect(
      w.system((tx) =>
        tx.query(`UPDATE password_credentials SET hash = 'plain' WHERE person_id = $1`, [OMAR.personId]),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('secrets: write through app.put_secret only, read as system only', () => {
  it('an admin stores a secret, nobody but the system reads it back', async () => {
    const id = await w.as(OMAR, (tx) => putSecret(tx, 'client-secret-123'));
    await expect(w.as(OMAR, (tx) => tx.query('SELECT * FROM secrets WHERE id = $1', [id]))).rejects.toThrow(/permission denied/);
    await expect(w.as(OMAR, (tx) => getSecret(tx, id))).rejects.toThrow(/system transaction/);
    expect(await w.system((tx) => getSecret(tx, id))).toBe('client-secret-123');
    const meta = await w.system((tx) => tx.query<{ ciphertext: Buffer }>('SELECT ciphertext FROM secrets WHERE id = $1', [id]));
    expect(meta.rows[0]?.ciphertext.toString('utf8')).not.toContain('client-secret-123');
    expect(await w.as(OMAR, (tx) => deleteSecret(tx, id))).toBe(true);
  });

  it('a non-admin cannot store or delete a secret', async () => {
    await expect(w.as(NADIA, (tx) => putSecret(tx, 'nope'))).rejects.toThrow(/only a workspace admin/);
    await expect(w.as(LENA, (tx) => putSecret(tx, 'nope'))).rejects.toThrow(/only a workspace admin/);
    const id = await w.system((tx) => putSecret(tx, 'keep'));
    await expect(w.as(NADIA, (tx) => deleteSecret(tx, id))).rejects.toThrow(/only a workspace admin/);
  });

  it('a provider row never carries the secret, only its id', async () => {
    const secretId = await w.as(OMAR, (tx) => putSecret(tx, 'oidc-client-secret'));
    await w.as(OMAR, (tx) =>
      tx.query(
        `INSERT INTO auth_providers (workspace_id, kind, config, secret_id, enabled, allowed_domains)
         VALUES ($1, 'google', '{"clientId": "abc"}', $2, true, '{kahf.example}')`,
        [KAHF_WORKSPACE_ID, secretId],
      ),
    );
    const rows = await w.as(OMAR, (tx) => tx.query('SELECT * FROM auth_providers'));
    expect(JSON.stringify(rows.rows)).not.toContain('oidc-client-secret');
    expect(rows.rows[0]?.['secret_id']).toBe(secretId);
  });
});

describe('auth_providers (W) and identities (P, W)', () => {
  it('only admins see or write sign-in methods', async () => {
    expect(await w.as(OMAR, (tx) => column(tx, 'SELECT kind FROM auth_providers'))).toEqual(['google']);
    for (const p of [NADIA, LENA]) {
      expect(await w.as(p, (tx) => column(tx, 'SELECT kind FROM auth_providers'))).toEqual([]);
    }
    await expect(
      w.as(NADIA, (tx) =>
        tx.query(`INSERT INTO auth_providers (workspace_id, kind) VALUES ($1, 'oidc')`, [KAHF_WORKSPACE_ID]),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await w.as(NADIA, (tx) => tx.query(`UPDATE auth_providers SET enabled = false`));
    expect(upd.rowCount).toBe(0);
  });

  it('a person sees and unlinks only her own identities; admins see all; linking is system', async () => {
    const providerId = (await w.system((tx) => column(tx, 'SELECT id FROM auth_providers')))[0];
    await w.system((tx) =>
      tx.query(
        `INSERT INTO identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, 'sub-n'), ($1, $4, $3, 'sub-r')`,
        [KAHF_WORKSPACE_ID, NADIA.personId, providerId, RAFI.personId],
      ),
    );
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT subject FROM identities'))).toEqual(['sub-n']);
    expect((await w.as(OMAR, (tx) => column(tx, 'SELECT subject FROM identities'))).sort()).toEqual(['sub-n', 'sub-r']);
    await expect(
      w.as(NADIA, (tx) =>
        tx.query(`INSERT INTO identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, 'sub-x')`, [
          KAHF_WORKSPACE_ID,
          NADIA.personId,
          providerId,
        ]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
    const del = await w.as(NADIA, (tx) => tx.query(`DELETE FROM identities`));
    expect(del.rowCount).toBe(1);
  });
});

describe('sessions (P, W)', () => {
  const sessionIds: Record<string, string> = {};
  beforeAll(async () => {
    for (const p of [NADIA, RAFI]) {
      const r = await w.system((tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO sessions (workspace_id, person_id, expires_at, device)
           VALUES ($1, $2, now() + interval '1 day', 'Chrome') RETURNING id`,
          [KAHF_WORKSPACE_ID, p.personId],
        ),
      );
      sessionIds[p.key] = r.rows[0]?.id ?? '';
    }
  });

  it("Nadia cannot read Rafi's sessions, Omar (admin) can read both", async () => {
    const n = await w.as(NADIA, (tx) => tx.query<SessionRow>('SELECT * FROM sessions'));
    expect(n.rows.map((r) => toSession(r).personId)).toEqual([NADIA.personId]);
    expect(await w.as(OMAR, (tx) => column(tx, 'SELECT id FROM sessions'))).toHaveLength(2);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT id FROM sessions'))).toEqual([]);
  });

  it('a person can revoke her own session, nothing else about it, and not create one', async () => {
    const rafi = await w.as(NADIA, (tx) =>
      tx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sessionIds['rafi']]),
    );
    expect(rafi.rowCount).toBe(0);
    await expect(
      w.as(NADIA, (tx) => tx.query(`UPDATE sessions SET expires_at = now() + interval '10 years'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      w.as(NADIA, (tx) =>
        tx.query(`INSERT INTO sessions (workspace_id, person_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
          KAHF_WORKSPACE_ID,
          NADIA.personId,
        ]),
      ),
    ).rejects.toThrow(/permission denied|row-level security/);
    const own = await w.as(NADIA, (tx) =>
      tx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 RETURNING *`, [sessionIds['nadia']]),
    );
    expect(own.rowCount).toBe(1);
  });

  it('the UNLOGGED session_cache is system only and references a session', async () => {
    const persistence = await w.system((tx) =>
      tx.query<{ relpersistence: string }>(`SELECT relpersistence FROM pg_class WHERE oid = 'app.session_cache'::regclass`),
    );
    expect(persistence.rows[0]?.relpersistence).toBe('u');
    await w.system((tx) =>
      tx.query(`INSERT INTO session_cache (token_hash, session_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
        Buffer.from(randomUUID().replaceAll('-', ''), 'hex'),
        sessionIds['rafi'],
      ]),
    );
    await expect(w.as(OMAR, (tx) => tx.query('SELECT 1 FROM session_cache'))).rejects.toThrow(/permission denied/);
  });
});

describe('invitations (W; team leads)', () => {
  const insert = (p: typeof OMAR, teamId: string | null, role: string, email: string) =>
    w.as(p, (tx) =>
      tx.query(
        `INSERT INTO invitations (workspace_id, team_id, email, role, token_hash, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [KAHF_WORKSPACE_ID, teamId, email, role, Buffer.from(randomUUID().replaceAll('-', ''), 'hex'), p.personId],
      ),
    );

  it('an admin invites to a team or the workspace, a guest only without a team', async () => {
    await insert(OMAR, TEAM_IDS.Engineering, 'member', 'new1@kahf.example');
    await insert(OMAR, null, 'guest', 'guest1@other.example');
    await expect(insert(OMAR, TEAM_IDS.Engineering, 'guest', 'guest2@other.example')).rejects.toThrow(/check constraint/);
    await expect(insert(OMAR, null, 'owner', 'owner@other.example')).rejects.toThrow(/check constraint/);
  });

  it('a lead invites members to her own team only, never admins, never to another team', async () => {
    await insert(TARIQ, TEAM_IDS.Marketing, 'member', 'new2@kahf.example');
    await expect(insert(TARIQ, TEAM_IDS.Marketing, 'admin', 'new3@kahf.example')).rejects.toThrow(/row-level security/);
    await expect(insert(TARIQ, TEAM_IDS.Engineering, 'member', 'new4@kahf.example')).rejects.toThrow(/row-level security/);
    await expect(insert(TARIQ, null, 'member', 'new5@kahf.example')).rejects.toThrow(/row-level security/);
  });

  it('a plain member cannot invite or list invitations; leads see their own team only', async () => {
    await expect(insert(NADIA, TEAM_IDS.Engineering, 'member', 'new6@kahf.example')).rejects.toThrow(/row-level security/);
    expect(await w.as(NADIA, (tx) => column(tx, 'SELECT email FROM invitations'))).toEqual([]);
    expect(await w.as(TARIQ, (tx) => column(tx, 'SELECT email FROM invitations'))).toEqual(['new2@kahf.example']);
    expect(await w.as(OMAR, (tx) => column(tx, 'SELECT email FROM invitations'))).toHaveLength(3);
    expect(await w.as(LENA, (tx) => column(tx, 'SELECT email FROM invitations'))).toEqual([]);
    expect(await w.as(PRIYA, (tx) => column(tx, 'SELECT email FROM invitations'))).toEqual([]);
  });
});
