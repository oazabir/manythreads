import { randomBytes } from 'node:crypto';
import {
  allPersonas,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  KAHF_WORKSPACE_ID,
  NADIA,
  PERSONA_PASSWORD,
  RAFI,
  TEAM_IDS,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSystemPool,
  toAclEntry,
  toAuthProvider,
  toEmailVerification,
  toIdentity,
  toInvitation,
  toPasswordCredential,
  toPerson,
  toPersonEmail,
  toRole,
  toRoleMember,
  toSecret,
  toSession,
  toSessionCacheEntry,
  toTeam,
  toTeamMember,
  toTeamPendingFile,
  toWorkspace,
  toWorkspaceMember,
  verifyPassword,
  withSystem,
  putSecret,
} from '../src/index.ts';

let db: TestDatabase;
let pool: ReturnType<typeof createSystemPool>;
const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]) => withSystem(fn, { pool });

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource] });
  pool = createSystemPool(db.systemUrl, 3);
}, 60_000);
afterAll(async () => {
  await pool.end();
  await dropTestDatabase(db);
});

describe('createPersonas', () => {
  it('creates workspace, three teams and seven people in one call, and is idempotent', async () => {
    const created = await createPersonas(db);
    expect(created.personas).toHaveLength(7);
    await createPersonas(db);
    const counts = await sys((tx) =>
      tx.query<Record<string, string>>(`
        SELECT (SELECT count(*) FROM workspaces) AS workspaces, (SELECT count(*) FROM teams) AS teams,
               (SELECT count(*) FROM people) AS people, (SELECT count(*) FROM actors) AS actors,
               (SELECT count(*) FROM workspace_members) AS members, (SELECT count(*) FROM team_members) AS team_members,
               (SELECT count(*) FROM roles) AS roles, (SELECT count(*) FROM role_members) AS role_members,
               (SELECT count(*) FROM password_credentials) AS credentials`),
    );
    expect(counts.rows[0]).toEqual({
      workspaces: '1', teams: '3', people: '7', actors: '7', members: '7',
      team_members: '7', roles: '3', role_members: '3', credentials: '7',
    });
  });

  it('assigns the roles of PLAN.md section 4', async () => {
    const roles = await sys((tx) =>
      tx.query<{ email: string; role: string }>(
        `SELECT p.primary_email AS email, wm.role FROM workspace_members wm JOIN people p ON p.id = wm.person_id`,
      ),
    );
    const byEmail = Object.fromEntries(roles.rows.map((r) => [r.email, r.role]));
    expect(byEmail).toEqual({
      'omar@kahf.example': 'owner', 'nadia@kahf.example': 'member', 'rafi@kahf.example': 'member',
      'sameera@kahf.example': 'member', 'tariq@kahf.example': 'member', 'priya@kahf.example': 'member',
      'lena@kahf.example': 'guest',
    });
    const teams = await sys((tx) =>
      tx.query<{ person: string; team: string; role: string }>(
        `SELECT p.display_name AS person, t.slug AS team, tm.role
         FROM team_members tm JOIN actors a ON a.id = tm.actor_id JOIN people p ON p.id = a.ref_id JOIN teams t ON t.id = tm.team_id
         ORDER BY 1, 2`,
      ),
    );
    expect(teams.rows.map((r) => `${r.person}:${r.team}:${r.role}`)).toEqual([
      'Nadia:engineering:member', 'Omar:engineering:lead', 'Priya:engineering:member', 'Priya:marketing:member',
      'Rafi:engineering:member', 'Sameera:customer-support:member', 'Tariq:marketing:lead',
    ]);
    const tags = await sys((tx) =>
      tx.query<{ person: string; tag: string }>(
        `SELECT p.display_name AS person, r.name AS tag FROM role_members rm JOIN roles r ON r.id = rm.role_id JOIN people p ON p.id = rm.person_id ORDER BY 1`,
      ),
    );
    expect(tags.rows.map((r) => `${r.person}:${r.tag}`)).toEqual([
      'Nadia:role:release-owner', 'Rafi:role:on-call', 'Sameera:role:support-agent',
    ]);
  });

  it('uses fixed ids and one password for everyone, hashed with argon2id', async () => {
    expect(TEAM_IDS.Engineering).toBe('00000000-0000-7000-8000-0000000b0001');
    const hashes = await sys((tx) =>
      tx.query<{ hash: string; person_id: string }>('SELECT hash, person_id FROM password_credentials'),
    );
    expect(new Set(hashes.rows.map((r) => r.hash)).size).toBe(7); // salted
    for (const row of hashes.rows) {
      expect(row.hash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(row.hash, PERSONA_PASSWORD)).toBe(true);
    }
    expect(PERSONA_PASSWORD).toBe('correct-horse-battery');
    expect(hashes.rows.map((r) => r.person_id).sort()).toEqual(allPersonas.map((p) => p.personId).sort());
    expect(NADIA.workspaceId).toBe(KAHF_WORKSPACE_ID);
    expect(RAFI.teams[0]?.tags).toEqual(['role:on-call']);
  });
});

describe('one mapper per table turns a real row into the shared type', () => {
  it('maps every phase 2 table', async () => {
    await createPersonas(db);
    await sys(async (tx) => {
      const secretId = await putSecret(tx, 'secret');
      const provider = await tx.query<{ id: string }>(
        `INSERT INTO auth_providers (workspace_id, kind, config, secret_id, allowed_domains)
         VALUES ($1, 'oidc', '{"issuer": "https://idp.example"}', $2, '{kahf.example}') RETURNING id`,
        [KAHF_WORKSPACE_ID, secretId],
      );
      await tx.query(`INSERT INTO identities (workspace_id, person_id, provider_id, subject) VALUES ($1, $2, $3, 's1')`, [
        KAHF_WORKSPACE_ID, NADIA.personId, provider.rows[0]?.id,
      ]);
      await tx.query(`INSERT INTO person_emails (workspace_id, person_id, email) VALUES ($1, $2, 'n@home.example')`, [KAHF_WORKSPACE_ID, NADIA.personId]);
      const session = await tx.query<{ id: string }>(
        `INSERT INTO sessions (workspace_id, person_id, expires_at, device) VALUES ($1, $2, now() + interval '1 day', 'Chrome') RETURNING id`,
        [KAHF_WORKSPACE_ID, NADIA.personId],
      );
      await tx.query(`INSERT INTO session_cache (token_hash, session_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [randomBytes(32), session.rows[0]?.id]);
      await tx.query(
        `INSERT INTO invitations (workspace_id, team_id, email, role, grant_spec, token_hash, invited_by)
         VALUES ($1, $2, 'new@kahf.example', 'member', '{"teamRole": "member"}', $3, $4)`,
        [KAHF_WORKSPACE_ID, TEAM_IDS.Engineering, randomBytes(32), NADIA.personId],
      );
      await tx.query(
        `INSERT INTO email_verifications (workspace_id, person_id, purpose, token_hash, expires_at) VALUES ($1, $2, 'reset_password', $3, now() + interval '1 hour')`,
        [KAHF_WORKSPACE_ID, NADIA.personId, randomBytes(32)],
      );
      await tx.query(
        `INSERT INTO acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission) VALUES ($1, 'team', $2, 'person', $3, 'read')`,
        [KAHF_WORKSPACE_ID, TEAM_IDS.Marketing, NADIA.personId],
      );
      await tx.query(`SELECT app.put_team_pending_files($1, '{"TEAM.md": "# E"}')`, [TEAM_IDS.Engineering]);
    });
    const all = <R>(table: string, map: (row: never) => R) =>
      sys(async (tx) => (await tx.query(`SELECT * FROM ${table}`)).rows.map((r) => map(r as never)));
    const mapped: [string, number][] = [
      ['workspaces', (await all('workspaces', toWorkspace)).length],
      ['people', (await all('people', toPerson)).length],
      ['person_emails', (await all('person_emails', toPersonEmail)).length],
      ['workspace_members', (await all('workspace_members', toWorkspaceMember)).length],
      ['auth_providers', (await all('auth_providers', toAuthProvider)).length],
      ['secrets', (await sys(async (tx) => (await tx.query('SELECT id, key_id, created_at FROM secrets')).rows.map((r) => toSecret(r as never)))).length],
      ['identities', (await all('identities', toIdentity)).length],
      ['password_credentials', (await sys(async (tx) => (await tx.query('SELECT person_id, must_change, created_at, updated_at FROM password_credentials')).rows.map((r) => toPasswordCredential(r as never)))).length],
      ['sessions', (await all('sessions', toSession)).length],
      ['session_cache', (await all('session_cache', toSessionCacheEntry)).length],
      ['invitations', (await all('invitations', toInvitation)).length],
      ['email_verifications', (await all('email_verifications', toEmailVerification)).length],
      ['teams', (await all('teams', toTeam)).length],
      ['team_members', (await all('team_members', toTeamMember)).length],
      ['roles', (await all('roles', toRole)).length],
      ['role_members', (await all('role_members', toRoleMember)).length],
      ['acl_entries', (await all('acl_entries', toAclEntry)).length],
      ['team_pending_files', (await all('team_pending_files', toTeamPendingFile)).length],
    ];
    for (const [table, n] of mapped) expect(n, table).toBeGreaterThan(0);
    const token = (await all('invitations', toInvitation))[0];
    expect(Object.keys(token ?? {})).not.toContain('tokenHash');
    expect(toSessionCacheEntry({ token_hash: Buffer.from([1, 255]), session_id: (await all('sessions', toSession))[0]?.id ?? '', expires_at: new Date(), created_at: new Date() } as never).tokenHash).toBe('01ff');
  });
});
