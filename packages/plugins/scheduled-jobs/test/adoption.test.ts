// The plugin used to be called `rhythms`. An install that ran its two old migrations (kept verbatim in fixtures/legacy-rhythms/) must come out
// of the new migrations with the same rows under the new names, and a fresh install must reach the very same schema.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { kernelMigrationSource, type MigrationSource } from '@manythreads/kernel';
import {
  KAHF_WORKSPACE_ID,
  TEAM_IDS,
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  conversationsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  gatewayLlmMigrationSource,
  memoryMigrationSource,
  migrateTestDatabase,
  ownerSql,
  personas,
  scheduledJobsMigrationSource,
  tasksMigrationSource,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const BEFORE: readonly MigrationSource[] = [
  kernelMigrationSource,
  testKernelMigrationSource,
  teamsMigrationSource,
  channelsMigrationSource,
  filesMigrationSource,
  botsMigrationSource,
  gatewayLlmMigrationSource,
  approvalsMigrationSource,
  memoryMigrationSource,
  conversationsMigrationSource,
  tasksMigrationSource,
];
const LEGACY: MigrationSource = {
  namespace: 'rhythms',
  dir: fileURLToPath(new URL('./fixtures/legacy-rhythms/', import.meta.url)),
};

const TEAM = TEAM_IDS.Engineering;
const JOB = randomUUID();
const RUN = randomUUID();

let old: TestDatabase;
let fresh: TestDatabase;

/** Every table, column, index, constraint, policy and function of the two tables and the firing door, as comparable text. */
const shape = async (db: TestDatabase): Promise<string[]> => {
  const rows = await ownerSql<{ line: string }>(
    db.ownerUrl,
    `SELECT 'column ' || table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') AS line
       FROM information_schema.columns WHERE table_schema = 'app' AND table_name IN ('scheduled_jobs', 'scheduled_job_runs')
     UNION ALL SELECT 'index ' || indexname || ' ' || indexdef FROM pg_indexes WHERE schemaname = 'app' AND tablename IN ('scheduled_jobs', 'scheduled_job_runs')
     UNION ALL SELECT 'constraint ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid IN ('app.scheduled_jobs'::regclass, 'app.scheduled_job_runs'::regclass)
     UNION ALL SELECT 'policy ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') FROM pg_policies
       WHERE schemaname = 'app' AND tablename IN ('scheduled_jobs', 'scheduled_job_runs')
     UNION ALL SELECT 'comment ' || c.relname || ' ' || coalesce(obj_description(c.oid), '') FROM pg_class c
       WHERE c.relnamespace = 'app'::regnamespace AND c.relname IN ('scheduled_jobs', 'scheduled_job_runs')
     UNION ALL SELECT 'rls ' || c.relname || ' ' || c.relrowsecurity || ' ' || c.relforcerowsecurity FROM pg_class c
       WHERE c.relnamespace = 'app'::regnamespace AND c.relname IN ('scheduled_jobs', 'scheduled_job_runs')
     UNION ALL SELECT 'function ' || p.proname || ' ' || pg_get_userbyid(p.proowner) || ' ' || p.prosecdef || ' ' || md5(p.prosrc) FROM pg_proc p
       WHERE p.pronamespace = 'app'::regnamespace AND p.proname LIKE 'scheduled_job%'
     UNION ALL SELECT 'grant ' || table_name || ' ' || grantee || ' ' || privilege_type FROM information_schema.role_table_grants
       WHERE table_schema = 'app' AND table_name IN ('scheduled_jobs', 'scheduled_job_runs') AND grantee = 'manythreads_app'`,
  );
  return rows.map((r) => r.line).sort();
};

beforeAll(async () => {
  // An install built the old way: the plugin's two old migrations, then some data.
  old = await createTestDatabase({ migrate: false });
  await migrateTestDatabase(old, [...BEFORE, LEGACY]);
  await createPersonas(old);
  const botId = randomUUID();
  await ownerSql(
    old.ownerUrl,
    `INSERT INTO app.bots (id, workspace_id, team_id, slug, name, kind, runtime, visibility, definition_sha, status)
     VALUES ($1, $2, $3, 'pulse', 'Pulse', 'automation', 'rules', 'team', $4, 'active')`,
    [botId, KAHF_WORKSPACE_ID, TEAM, 'c'.repeat(64)],
  );
  await ownerSql(
    old.ownerUrl,
    `INSERT INTO app.rhythms (id, workspace_id, team_id, bot_id, name, kind, schedule, created_by)
     VALUES ($1, $2, $3, $4, 'Morning check', 'heartbeat', '0 9 * * *', $5)`,
    [JOB, KAHF_WORKSPACE_ID, TEAM, botId, personas.omar.actorId],
  );
  await ownerSql(
    old.ownerUrl,
    `INSERT INTO app.rhythm_runs (id, rhythm_id, team_id, status) VALUES ($1, $2, $3, 'done')`,
    [RUN, JOB, TEAM],
  );

  // Rows other tables keep about the old plugin (system-only tables, so the system login writes them).
  const sys = old.systemUrl;
  await ownerSql(sys, `INSERT INTO app.plugins (name, version) VALUES ('rhythms', '0.0.0')`);
  await ownerSql(sys, `INSERT INTO app.event_subscriptions (subscriber, event_type) VALUES ('rhythms', 'runtime.rhythm.finished')`);
  await ownerSql(sys, `INSERT INTO app.jobs (queue, dedupe_key) VALUES ('rhythms.tick', 'cron'), ('other.tick', 'cron')`);
  const [event] = await ownerSql<{ id: string }>(
    sys,
    `INSERT INTO app.events (workspace_id, team_id, actor_id, type, schema_version, payload)
     VALUES ($1, $2, $3, 'rhythms.rhythm.ran', 1, '{}'::jsonb) RETURNING id`,
    [KAHF_WORKSPACE_ID, TEAM, personas.omar.actorId],
  );
  await ownerSql(sys, `INSERT INTO app.outbox (event_id, subscriber) VALUES ($1, 'runtime-hermes'), ($1, 'rhythms')`, [event?.id]);

  // The new files run over it, as a deploy would do.
  await migrateTestDatabase(old, [...BEFORE, scheduledJobsMigrationSource]);

  // A fresh install: only the new files.
  fresh = await createTestDatabase({ migrate: false });
  await migrateTestDatabase(fresh, [...BEFORE, scheduledJobsMigrationSource]);
}, 180_000);

afterAll(async () => {
  if (old) await dropTestDatabase(old);
  if (fresh) await dropTestDatabase(fresh);
});

describe('adopting an install that ran the old `rhythms` migrations', () => {
  it('keeps the rows under the new table and column names', async () => {
    const jobs = await ownerSql<{ id: string; name: string }>(old.ownerUrl, `SELECT id, name FROM app.scheduled_jobs`);
    expect(jobs).toEqual([{ id: JOB, name: 'Morning check' }]);
    const runs = await ownerSql<{ id: string; scheduled_job_id: string; status: string }>(
      old.ownerUrl,
      `SELECT id, scheduled_job_id, status FROM app.scheduled_job_runs`,
    );
    expect(runs).toEqual([{ id: RUN, scheduled_job_id: JOB, status: 'done' }]);
  });

  it('leaves nothing of the old names in the schema', async () => {
    for (const db of [old, fresh]) {
      const left = await ownerSql<{ what: string }>(
        db.ownerUrl,
        `SELECT 'table ' || relname AS what FROM pg_class WHERE relnamespace = 'app'::regnamespace AND relname LIKE '%rhythm%'
         UNION ALL SELECT 'function ' || proname FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname LIKE '%rhythm%'
         UNION ALL SELECT 'policy ' || policyname FROM pg_policies WHERE schemaname = 'app' AND policyname LIKE '%rhythm%'
         UNION ALL SELECT 'constraint ' || conname FROM pg_constraint WHERE connamespace = 'app'::regnamespace AND conname LIKE '%rhythm%'`,
      );
      expect(left).toEqual([]);
    }
  });

  it('reaches the same schema as a fresh install', async () => {
    expect(await shape(old)).toEqual(await shape(fresh));
    expect((await shape(fresh)).length).toBeGreaterThan(30);
  });

  it('fires a job through the renamed door, for the system', async () => {
    const [run] = await ownerSql<{ scheduled_job_id: string; status: string }>(
      old.systemUrl,
      `SELECT * FROM app.scheduled_jobs_fire($1, now(), NULL, NULL)`,
      [JOB],
    );
    expect(run).toMatchObject({ scheduled_job_id: JOB, status: 'queued' });
  });

  it('no longer lists the old plugin, its waiting deliveries or its queue', async () => {
    const sys = old.systemUrl;
    expect(await ownerSql(sys, `SELECT 1 FROM app.plugins WHERE name = 'rhythms'`)).toEqual([]);
    expect(await ownerSql(sys, `SELECT 1 FROM app.event_subscriptions WHERE subscriber = 'rhythms'`)).toEqual([]);
    const outbox = await ownerSql<{ subscriber: string; done: boolean }>(
      sys,
      `SELECT subscriber, done_at IS NOT NULL AS done FROM app.outbox ORDER BY subscriber`,
    );
    // Both deliveries were for the old event type: closed, and the old plugin's one now carries the new plugin's name.
    expect(outbox).toEqual([
      { subscriber: 'runtime-hermes', done: true },
      { subscriber: 'scheduled-jobs', done: true },
    ]);
    const queues = await ownerSql<{ queue: string; state: string }>(sys, `SELECT queue, state FROM app.jobs ORDER BY queue`);
    expect(queues).toEqual([
      { queue: 'other.tick', state: 'ready' },
      { queue: 'rhythms.tick', state: 'done' },
    ]);
  });
});
