import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  approvalsMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The narrowest-source rule resolves every source line of a run to a message or a file. It runs on every recall, retain, run summary and authored
// verdict, so it must be a lookup by primary key, not a scan of the tables for each line. This plan test makes a table large enough for a sequential
// scan to be the planner's visible mistake, EXPLAINs the very function the rule is made of, and refuses one.

const { omar, nadia } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 120_000 });

let db: TestDatabase;
let admin: pg.Client;
let runId = '';

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];
const explain = async (sql: string, values: unknown[] = []): Promise<PlanNode[]> => {
  const res = await admin.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (FORMAT JSON) ${sql}`, values);
  return nodes(res.rows[0]!['QUERY PLAN'][0]!.Plan);
};
const scansOf = (plan: PlanNode[], relation: string): string[] =>
  plan.filter((n) => n['Relation Name'] === relation && /Scan/.test(n['Node Type'])).map((n) => n['Node Type']);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
    ],
  });
  await createPersonas(db);
  admin = testClient({ connectionString: db.systemUrl });
  await admin.connect();
  const channel = (await admin.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'big', 'channel', false) RETURNING id", [omar.workspaceId, ENG])).rows[0]!.id;
  // enough rows that a scan per source line is what a plan would show
  await admin.query(
    `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
     SELECT $1, $2, $3, 'message ' || g, 'message ' || g FROM generate_series(1, 30000) g`,
    [omar.workspaceId, channel, nadia.actorId],
  );
  await admin.query(
    `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
     SELECT $1, $2, '/files/', 'f' || g, 'blob-' || g, 1, 'text/plain', repeat('a', 64), $3 FROM generate_series(1, 10000) g`,
    [omar.workspaceId, channel, nadia.actorId],
  );
  const bot = (
    await admin.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, $2, 'planner', 'Planner', '', 'agent', 'rules', 'team', repeat('a', 64), 'active') RETURNING id`,
      [omar.workspaceId, ENG],
    )
  ).rows[0]!.id;
  runId = (
    await admin.query<{ id: string }>(
      "INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, status) VALUES ($1, $2, $3, 'mention', $4, 'running') RETURNING id",
      [omar.workspaceId, bot, ENG, nadia.actorId],
    )
  ).rows[0]!.id;
  // fifty lines of each kind, as a run that searched a dozen times has
  await admin.query(
    `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
     SELECT $1, g, 'message', (SELECT id::text FROM app.messages ORDER BY id OFFSET g * 100 LIMIT 1), 'channel' FROM generate_series(0, 49) g`,
    [runId],
  );
  await admin.query(
    `INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope)
     SELECT $1, 100 + g, 'file', (SELECT id::text FROM app.files ORDER BY id OFFSET g * 100 LIMIT 1), 'channel' FROM generate_series(0, 49) g`,
    [runId],
  );
  await admin.query('ANALYZE app.messages');
  await admin.query('ANALYZE app.files');
  await admin.query('ANALYZE app.run_source_log');
  await admin.query('ANALYZE app.channels');
  // At a few tens of thousands of rows the planner may rightly hash-join a table it will read once; at production size it would not. Hash and merge
  // joins are switched off for this session so the plan is the nested loop a big table gets — and a join that cannot use the key then shows as the
  // sequential scan it is.
  await admin.query('SET enable_hashjoin = off');
  await admin.query('SET enable_mergejoin = off');
}, 240_000);

afterAll(async () => {
  await admin?.end();
  if (db) await dropTestDatabase(db);
});

describe('the narrowest-source rule is a lookup by key, not a scan', () => {
  it('app.memory_run_lines reads messages and files through their primary keys', async () => {
    const plan = await explain('SELECT * FROM app.memory_run_lines($1::uuid)', [runId]);
    expect(scansOf(plan, 'messages').length).toBeGreaterThan(0);
    expect(scansOf(plan, 'files').length).toBeGreaterThan(0);
    for (const relation of ['messages', 'files']) {
      expect(scansOf(plan, relation).filter((t) => t === 'Seq Scan'), `a sequential scan of ${relation}: ${JSON.stringify(plan.map((n) => [n['Node Type'], n['Relation Name']]))}`).toEqual([]);
    }
    expect(plan.some((n) => n['Index Name'] === 'messages_pkey')).toBe(true);
    expect(plan.some((n) => n['Index Name'] === 'files_pkey')).toBe(true);
  });

  it('the test would notice the mistake: casting the column instead of the reference is a sequential scan of the same table, for every line', async () => {
    const alone = await explain("SELECT 1 FROM app.messages m WHERE m.id::text = '00000000-0000-7000-8000-000000000001'");
    expect(scansOf(alone, 'messages')).toContain('Seq Scan');
    const joined = await explain(
      "SELECT l.seq, m.channel_id FROM app.run_source_log l LEFT JOIN app.messages m ON l.source_type = 'message' AND m.id::text = l.source_ref WHERE l.run_id = $1::uuid",
      [runId],
    );
    expect(scansOf(joined, 'messages')).toContain('Seq Scan');
  });

  it('the verdict over those lines is answered, and answers the same as the lines say', async () => {
    const v = (await admin.query<{ retain_refusal: string | null; source_lines: number }>('SELECT retain_refusal, source_lines FROM app.run_retain_verdict($1::uuid)', [runId])).rows[0]!;
    expect(v).toEqual({ retain_refusal: null, source_lines: 100 });
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) await admin.query('SELECT * FROM app.run_retain_verdict($1::uuid)', [runId]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('a ref that is not a uuid does not raise and is simply not team-visible', async () => {
    await admin.query("INSERT INTO app.run_source_log (run_id, seq, source_type, source_ref, scope) VALUES ($1, 500, 'message', 'not-a-uuid', 'channel'), ($1, 501, 'file', '12345', 'channel')", [runId]);
    const v = (await admin.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.run_retain_verdict($1::uuid)', [runId])).rows[0]!;
    expect(v.retain_refusal).toBe('private_source');
  });
});
