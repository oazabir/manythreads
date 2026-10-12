import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import { NEVER_APPROVAL_GATED } from '@manythreads/sdk';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The database's own refusal (migration 0002): no door files an approval for a tool that may never wait, and the list is the SDK's.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource] });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const insert = (tool: string, resume: object) =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.approvals (workspace_id, team_id, source, tool, summary, args_preview, resume, approver_scope, requester_id)
       VALUES ($1, $2, 'grant', $3, 'summary', '{}', $4, '{"roles":[],"people":[],"leads":true}', $5)`,
      [omar.workspaceId, ENG, tool, JSON.stringify(resume), nadia.actorId],
    ),
  );

describe('approvals_never_gated', () => {
  it.each(NEVER_APPROVAL_GATED)('refuses %s as the tool, with either kind of resume', async (tool) => {
    expect(await code(insert(tool, { kind: 'tool', capability: tool, args: {}, trigger: 'mention' }))).toBe('23514');
    expect(await code(insert(tool, { kind: 'handoff', payload: {} }))).toBe('23514');
  });

  it('takes any other tool', async () => {
    expect(await code(insert('pages.write', { kind: 'tool', capability: 'pages.write', args: {}, trigger: 'mention' }))).toBeUndefined();
  });

  it('names exactly the SDK’s list', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      const def = (await admin.query<{ def: string }>("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'approvals_never_gated'")).rows[0]?.def ?? '';
      const named = [...def.matchAll(/'([^']+)'::/g)].map((m) => m[1]);
      expect([...named].sort()).toEqual([...NEVER_APPROVAL_GATED].sort());
    } finally {
      await admin.end();
    }
  });
});
