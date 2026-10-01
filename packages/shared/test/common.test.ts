import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AclPermission,
  AclSubjectType,
  ActorKind,
  AuthProviderKind,
  EmailVerificationPurpose,
  ErrorCode,
  ErrorEnvelope,
  InvitationRole,
  JobState,
  Message,
  Page,
  PersonStatus,
  ScopedKvScopeType,
  TeamRole,
  tokenCssVar,
  tokens,
  WorkspaceRole,
} from '../src/index.ts';
import { messageWire } from './fixtures.ts';

const migrationsDir = fileURLToPath(new URL('../../kernel/migrations/', import.meta.url));

describe('Page', () => {
  it('validates items and cursor', () => {
    const schema = Page(Message);
    expect(schema.parse({ items: [messageWire], nextCursor: 'abc' }).nextCursor).toBe('abc');
    expect(schema.parse({ items: [], nextCursor: null }).items).toEqual([]);
    expect(schema.safeParse({ items: [{}], nextCursor: null }).success).toBe(false);
  });
});

describe('ErrorEnvelope', () => {
  it('accepts a validation failure with a path and details', () => {
    const env = {
      error: {
        code: 'validation_failed',
        message: 'bad body',
        path: ['body', 0],
        details: [{ code: 'too_small', message: 'too short', path: ['body'] }],
      },
    };
    expect(ErrorEnvelope.parse(env)).toEqual(env);
  });

  it('rejects unknown codes', () => {
    expect(ErrorEnvelope.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(false);
  });

  it('lists the documented codes', () => {
    expect(ErrorCode.options).toEqual([
      'validation_failed',
      'not_found',
      'forbidden',
      'rate_limited',
      'conflict',
      'internal',
      'unauthenticated',
    ]);
  });
});

describe('enums vs SQL CHECK', () => {
  // B.2 rule 7: each z.enum that mirrors a SQL CHECK is compared to the migration text here (column definitions of the
  // form `col text ... CHECK (col IN ('a', 'b'))`, so the migrations must keep that shape).
  const migrations = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
    .join('\n');

  const checkValues = (table: string, column: string): string[] => {
    const start = new RegExp(`CREATE (?:UNLOGGED )?TABLE app\\.${table} \\(`).exec(migrations);
    if (!start) throw new Error(`no CREATE TABLE app.${table} in the kernel migrations`);
    const body = migrations.slice(start.index, migrations.indexOf('\n);', start.index));
    const check = new RegExp(`\\b${column}\\s+text\\b[^\\n]*?CHECK \\(${column} IN \\(([^)]*)\\)\\)`).exec(body);
    if (!check?.[1]) throw new Error(`no CHECK (${column} IN (...)) on app.${table}`);
    return [...check[1].matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '');
  };

  const pairs: [string, { options: readonly string[] }, string, string][] = [
    ['ActorKind', ActorKind, 'actors', 'kind'],
    ['JobState', JobState, 'jobs', 'state'],
    ['ScopedKvScopeType', ScopedKvScopeType, 'scoped_kv', 'scope_type'],
    ['WorkspaceRole', WorkspaceRole, 'workspace_members', 'role'],
    ['PersonStatus', PersonStatus, 'people', 'status'],
    ['AuthProviderKind', AuthProviderKind, 'auth_providers', 'kind'],
    ['InvitationRole', InvitationRole, 'invitations', 'role'],
    ['EmailVerificationPurpose', EmailVerificationPurpose, 'email_verifications', 'purpose'],
    ['TeamRole', TeamRole, 'team_members', 'role'],
    ['AclSubjectType', AclSubjectType, 'acl_entries', 'subject_type'],
    ['AclPermission', AclPermission, 'acl_entries', 'permission'],
  ];

  it.each(pairs)('%s matches the SQL CHECK on %s.%s', (_name, schema, table, column) => {
    expect([...schema.options]).toEqual(checkValues(table, column));
  });

  it('workspace and team roles are the spec §5 roles', () => {
    expect(WorkspaceRole.options).toEqual(['owner', 'admin', 'member', 'guest']);
    expect(TeamRole.options).toEqual(['lead', 'member']);
  });
  it('ErrorCode is a z.enum', () => {
    expect(ErrorCode).toBeInstanceOf(z.ZodEnum);
  });
});

describe('tokens', () => {
  it('maps every token to a css var', () => {
    expect(tokens.paper).toMatch(/^#[0-9A-F]{6}$/);
    expect(tokens.agentWash).toHaveLength(7);
    expect(tokens.fonts.sans).toBe('Inter Tight');
    expect(tokenCssVar.agentWash).toBe('--agent-wash');
    expect(tokenCssVar.alertWash).toBe('--alert-wash');
    expect(tokenCssVar.fonts.mono).toBe('--mono');
  });
});
