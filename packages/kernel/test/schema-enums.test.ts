import {
  AclPermission,
  ChannelKind,
  MentionKind,
  PresenceStatus,
  AclSubjectType,
  ActorKind,
  AuthProviderKind,
  EntityType,
  EmailVerificationPurpose,
  InvitationRole,
  JobState,
  PersonStatus,
  ReadTargetType,
  ScopedKvScopeType,
  TeamRole,
  WorkspaceRole,
} from '@manythreads/shared';
import {
  createTestDatabase,
  dropTestDatabase,
  channelsMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * PLAN Appendix B rule 7: an enum is a `z.enum` in `packages/shared` AND a SQL `CHECK (col IN (...))`, and both list the same
 * values in the same order. The database is the source of truth here (`pg_get_constraintdef` of the migrated schema, so the
 * SQL spelling does not matter), and the map below is complete by construction: a migration that adds a `text` column with
 * `CHECK (col IN (...))` fails the "every enum column is mapped" test until its Zod enum is listed, so the two cannot drift.
 *
 * Adding an enum table (channels, tasks, ...): add `'<table>.<column>': <ZodEnum>` below; plugin tables are migrated here
 * through `sources` in beforeAll.
 */
const ENUM_COLUMNS: Record<string, { options: readonly string[] }> = {
  'actors.kind': ActorKind,
  'jobs.state': JobState,
  'scoped_kv.scope_type': ScopedKvScopeType,
  'workspace_members.role': WorkspaceRole,
  'people.status': PersonStatus,
  'auth_providers.kind': AuthProviderKind,
  'invitations.role': InvitationRole,
  'email_verifications.purpose': EmailVerificationPurpose,
  'team_members.role': TeamRole,
  'acl_entries.subject_type': AclSubjectType,
  'acl_entries.permission': AclPermission,
  'read_state.target_type': ReadTargetType,
  'entity_links.src_type': EntityType,
  'entity_links.dst_type': EntityType,
  'channels.kind': ChannelKind,
  'message_mentions.kind': MentionKind,
  'presence.status': PresenceStatus,
};

/**
 * CHECK (col IN (...)) columns that are deliberately not a shared enum, with the reason. Empty today.
 * (A value set that only the database knows is still an enum; prefer adding the Zod schema.)
 */
const NOT_SHARED_ENUMS: Record<string, string> = {};

let db: TestDatabase;
let owner: pg.Client;
let found: Map<string, string[]>;

/** `CHECK (((role)::text = ANY ((ARRAY['lead'::character varying, ...])::text[])))` -> ['lead', ...], in written order. */
const checkValues = (definition: string): string[] => [...definition.matchAll(/'((?:[^']|'')*)'::/g)].map((m) => (m[1] ?? '').replace(/''/g, "'"));

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource] });
  owner = new pg.Client({ connectionString: db.ownerUrl });
  await owner.connect();
  const rows = await owner.query<{ table: string; column: string; def: string }>(`
    SELECT c.relname AS "table", a.attname AS "column", pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'c' AND n.nspname = 'app' AND cardinality(con.conkey) = 1
      AND pg_get_constraintdef(con.oid) ~ '= ANY \\(\\(?ARRAY\\['
    ORDER BY 1, 2
  `);
  found = new Map(rows.rows.map((r) => [`${r.table}.${r.column}`, checkValues(r.def)]));
}, 120_000);

afterAll(async () => {
  await owner?.end();
  if (db) await dropTestDatabase(db);
});

describe('Zod enums vs SQL CHECK (Appendix B rule 7)', () => {
  it('finds the CHECK (col IN (...)) columns of the migrated schema', () => {
    expect(found.size).toBeGreaterThanOrEqual(Object.keys(ENUM_COLUMNS).length);
    expect(found.get('team_members.role')).toEqual(['lead', 'member']);
  });

  it('every enum column in the database is mapped to a shared enum (or explained)', () => {
    const unmapped = [...found.keys()].filter((k) => !(k in ENUM_COLUMNS) && !(k in NOT_SHARED_ENUMS));
    expect(unmapped, `add these to ENUM_COLUMNS with their Zod enum: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('every mapped column still exists with a CHECK', () => {
    const stale = Object.keys(ENUM_COLUMNS).filter((k) => !found.has(k));
    expect(stale, `no CHECK (col IN (...)) in the database for: ${stale.join(', ')}`).toEqual([]);
    const staleExplained = Object.keys(NOT_SHARED_ENUMS).filter((k) => !found.has(k));
    expect(staleExplained).toEqual([]);
  });

  it.each(Object.entries(ENUM_COLUMNS))('%s lists the same values, in the same order, as its z.enum', (column, schema) => {
    expect([...schema.options], `${column}: z.enum vs SQL CHECK`).toEqual(found.get(column));
  });

  it('notices a drifted CHECK (the comparison is not vacuous)', async () => {
    await owner.query(`CREATE TABLE app.enum_probe (id uuid PRIMARY KEY, state text NOT NULL CHECK (state IN ('a', 'b', 'c')))`);
    try {
      const r = await owner.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'app.enum_probe'::regclass AND contype = 'c'`,
      );
      expect(checkValues(r.rows[0]?.def ?? '')).toEqual(['a', 'b', 'c']);
      expect(checkValues(r.rows[0]?.def ?? '')).not.toEqual(['a', 'b']);
    } finally {
      await owner.query('DROP TABLE app.enum_probe');
    }
  });
});
