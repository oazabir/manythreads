import { readFileSync } from 'node:fs';
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

  it('the migration ends a legacy non-final row before the constraint, through the system role (a plain UPDATE would be a silent no-op under row level security)', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      await admin.query('ALTER TABLE app.approvals DROP CONSTRAINT approvals_never_gated');
      const seed = (status: string, outcome: string, decided: boolean) =>
        sys(
          async (tx) =>
            (
              await tx.query<{ id: string }>(
                `INSERT INTO app.approvals (workspace_id, team_id, source, status, outcome, tool, summary, args_preview, resume, approver_scope, requester_id, decided_at)
                 VALUES ($1, $2, 'grant', $3, $4, 'memory.retain', 'legacy', '{}', '{"kind":"handoff","payload":{}}', '{"roles":[],"people":[],"leads":true}', $5, $6)
                 RETURNING id`,
                [omar.workspaceId, ENG, status, outcome, nadia.actorId, decided ? new Date().toISOString() : null],
              )
            ).rows[0]!.id,
        );
      const pending = await seed('pending', 'none', false);
      const queued = await seed('approved', 'queued', true);
      const ran = await seed('approved', 'ran', true);
      const file = readFileSync(new URL('../../migrations/0002_never_gated.sql', import.meta.url), 'utf8');
      const block = file.slice(file.indexOf('-- legacy-begin') + '-- legacy-begin'.length, file.indexOf('-- legacy-end'));
      expect(block).toContain('SET ROLE manythreads_system');
      await admin.query(block);
      const state = async (id: string) =>
        (await sys(async (tx) => (await tx.query<{ status: string; outcome: string }>('SELECT status, outcome FROM app.approvals WHERE id = $1', [id])).rows[0]))!;
      expect(await state(pending)).toEqual({ status: 'expired', outcome: 'none' });
      expect(await state(queued)).toEqual({ status: 'approved', outcome: 'failed' });
      expect(await state(ran)).toEqual({ status: 'approved', outcome: 'ran' }); // final: left as it is
      // the constraint goes back as the migration adds it, for the tests after this one
      await admin.query("ALTER TABLE app.approvals ADD CONSTRAINT approvals_never_gated CHECK (tool NOT IN ('memory.retain')) NOT VALID");
    } finally {
      await admin.end();
    }
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
