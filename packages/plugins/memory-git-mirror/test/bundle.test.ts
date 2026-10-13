import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx, RepoProvider, RepoWriteChange } from '@manythreads/sdk';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryGitMirrorMigrationSource,
  memoryHindsightMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureBundle, INDEX_PATH, LOG_PATH, writeJournal } from '../src/bundle.ts';

// What the writer's refusals mean. A 409 that names files is "somebody wrote one of them"; a 409 that names none (`ref_conflict`) lost a race
// for the branch and wrote nothing. Neither is "the file exists" until a look says so — a bundle root is recorded only when both files are
// there, and a journal is "exists" only when it is. Also: the journal counts the team's bank, never a person's file.

const { omar } = personas;
const ENG = TEAM_IDS.Engineering;
const NOW = new Date('2026-10-13T02:23:00.000Z');
/** The day a test's log lines fall on (each test of the journal gets its own, so one test's lines are not another's). */
let currentDay = '2026-09-01';

let db: TestDatabase;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

const refusal = (conflicts: unknown[]): Error => Object.assign(new Error('refused'), { status: 409, code: 'conflict', conflicts });
const refConflict = (): Error => refusal([]);
const fileConflict = (): Error => refusal([{ path: INDEX_PATH, reason: 'exists' }]);

interface Script {
  /** What each successive call does: succeed, throw, or let a concurrent writer get its file in first and then refuse. */
  steps: Array<Error | 'ok' | { run: (tx: PluginTx) => Promise<void>; throws: Error }>;
  calls: Array<{ paths: string[]; message: string }>;
}
const script: Script = { steps: [], calls: [] };
const repo = {
  id: 'fake',
  write: async (tx: PluginTx, _teamId: string, _actor: unknown, changes: readonly RepoWriteChange[], message: string) => {
    script.calls.push({ paths: changes.map((c) => c.path), message });
    const step = script.steps.shift() ?? 'ok';
    if (step instanceof Error) throw step;
    if (step !== 'ok') {
      await step.run(tx);
      throw step.throws;
    }
    return { sha: 'a'.repeat(40), parentSha: null, noop: false, authorId: null, paths: [] };
  },
} as unknown as RepoProvider;
const ctx = { providers: { get: (kind: string) => (kind === 'repo' ? repo : undefined) }, runtime: { now: () => NOW } } as unknown as PluginContext;

/** A file appears in the index as if another writer had committed it. */
const appear = (path: string): ((tx: PluginTx) => Promise<void>) => async (tx) => {
  const sha = 'b'.repeat(40);
  await tx.query(`INSERT INTO app.repo_commits (team_id, sha, message, committed_at, paths) VALUES ($1, $2, 'other writer', now(), ARRAY[$3]::text[]) ON CONFLICT DO NOTHING`, [ENG, sha, path]);
  await tx.query(
    `INSERT INTO app.repo_entries (team_id, path, blob_sha, size, last_commit_sha, text_plain) VALUES ($1, $2, $3, 5, $4, 'x') ON CONFLICT (team_id, path) DO NOTHING`,
    [ENG, path, sha, sha],
  );
};

const recorded = async (): Promise<boolean> => sys(async (tx) => (await tx.query('SELECT 1 FROM app.memory_mirror_teams WHERE team_id = $1', [ENG])).rows.length > 0);
const logLine = (over: { store?: string; id: string; outcome: string; link?: string; at?: string }): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.memory_retain_log (workspace_id, team_id, store, bank, source_kind, source_id, outcome, link, created_at)
       VALUES ($1, $2, $3, 'team:test:eng', 'message', $4, $5, $6, $7::timestamptz)`,
      [omar.workspaceId, ENG, over.store ?? 'team_bank', over.id, over.outcome, over.link ?? '', over.at ?? `${currentDay}T10:00:00Z`],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, repoGitMigrationSource, memoryMigrationSource, memoryHindsightMigrationSource, memoryGitMirrorMigrationSource],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  script.steps = [];
  script.calls = [];
  await sys(async (tx) => {
    await tx.query('DELETE FROM app.memory_mirror_teams');
    await tx.query('DELETE FROM app.repo_entries');
    await tx.query('DELETE FROM app.repo_commits');
  });
});

describe('ensureBundle', () => {
  it('writes both files and records the team', async () => {
    const outcome = await sys((tx) => ensureBundle(ctx, tx, ENG));
    expect(outcome).toBe('created');
    expect(script.calls).toEqual([{ paths: [INDEX_PATH, LOG_PATH], message: 'Create the team memory bundle' }]);
    expect(await recorded()).toBe(true);
  });

  it('a lost race for the branch (409, no files named) is written again, not taken for "the files exist"', async () => {
    script.steps = [refConflict(), 'ok'];
    expect(await sys((tx) => ensureBundle(ctx, tx, ENG))).toBe('created');
    expect(script.calls).toHaveLength(2);
    expect(await recorded()).toBe(true);
  });

  it('a lost race that goes on losing fails the job and records nothing', async () => {
    script.steps = [refConflict(), refConflict(), refConflict()];
    await expect(sys((tx) => ensureBundle(ctx, tx, ENG))).rejects.toMatchObject({ status: 409 });
    expect(await recorded()).toBe(false);
  });

  it('a file written in between is found by the look, and only the missing one is written next', async () => {
    script.steps = [{ run: appear(INDEX_PATH), throws: fileConflict() }];
    expect(await sys((tx) => ensureBundle(ctx, tx, ENG))).toBe('created');
    expect(script.calls).toEqual([
      { paths: [INDEX_PATH, LOG_PATH], message: 'Create the team memory bundle' },
      { paths: [LOG_PATH], message: 'Create the team memory bundle' },
    ]);
    expect(await recorded()).toBe(true);
  });

  it('a file conflict with no file to be found is not "present": it fails and records nothing', async () => {
    script.steps = [fileConflict(), fileConflict(), fileConflict()];
    await expect(sys((tx) => ensureBundle(ctx, tx, ENG))).rejects.toMatchObject({ status: 409 });
    expect(await recorded()).toBe(false);
  });

  it('records a team whose root is already there without writing', async () => {
    await sys(async (tx) => {
      await appear(INDEX_PATH)(tx as unknown as PluginTx);
      await appear(LOG_PATH)(tx as unknown as PluginTx);
    });
    expect(await sys((tx) => ensureBundle(ctx, tx, ENG))).toBe('present');
    expect(script.calls).toEqual([]);
    expect(await recorded()).toBe(true);
  });
});

describe('writeJournal', () => {
  let DATE = currentDay;
  let n = 1;
  beforeEach(() => {
    n += 1;
    currentDay = `2026-09-${String(n).padStart(2, '0')}`;
    DATE = currentDay;
  });

  it('is "exists" before any write when the index has the file, and when a 409 names it and the look then finds it', async () => {
    await logLine({ id: 'm1', outcome: 'retained', link: '/t/engineering/c/dev?message=m1' });
    await sys((tx) => appear(`memory/journal/${DATE}.md`)(tx as unknown as PluginTx));
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('exists');
    expect(script.calls).toEqual([]);

    await sys((tx) => tx.query('DELETE FROM app.repo_entries'));
    script.steps = [{ run: appear(`memory/journal/${DATE}.md`), throws: fileConflict() }];
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('exists');
    expect(script.calls).toHaveLength(1);
  });

  it('a lost race for the branch is written again; one that goes on losing is the job’s failure, never "exists"', async () => {
    await logLine({ id: 'm1', outcome: 'retained', link: '/t/engineering/c/dev?message=m1' });
    script.steps = [refConflict(), 'ok'];
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('written');
    expect(script.calls).toHaveLength(2);

    script.calls = [];
    script.steps = [refConflict(), refConflict(), refConflict()];
    await expect(sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).rejects.toMatchObject({ status: 409 });
  });

  it('a 409 that names the file while no such file is in the index is not "exists" either', async () => {
    await logLine({ id: 'm1', outcome: 'retained', link: '/t/engineering/c/dev?message=m1' });
    script.steps = [fileConflict(), fileConflict(), fileConflict()];
    await expect(sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).rejects.toMatchObject({ status: 409 });
  });

  it('counts the team bank only: a person’s file never makes a team’s journal, nor adds to its counts or links', async () => {
    await logLine({ store: 'person_file', id: 'p1', outcome: 'retained', link: '/t/engineering/people/nadia' });
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('empty');
    expect(script.calls).toEqual([]);

    await logLine({ id: 'm1', outcome: 'retained', link: '/t/engineering/c/dev?message=m1' });
    let written = '';
    const original = repo.write.bind(repo);
    (repo as { write: unknown }).write = async (tx: PluginTx, teamId: string, actor: unknown, changes: readonly RepoWriteChange[], message: string) => {
      written = String((changes[0] as { content: string }).content);
      return original(tx, teamId, actor as never, changes, message);
    };
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('written');
    expect(written).toContain('| message | 1 | 0 |');
    expect(written).toContain('message=m1');
    expect(written).not.toContain('people/nadia');
  });

  it('says nothing about what was left out: a day with only withheld lines is no journal, and a journal has no column for them', async () => {
    await logLine({ id: 'w1', outcome: 'withheld', link: '/t/engineering/c/dev?message=w1' });
    expect(await sys((tx) => writeJournal(ctx, tx, { teamId: ENG, date: DATE }))).toBe('empty');
  });
});
