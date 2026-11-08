import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  gatewayMcpMigrationSource,
  knowledgeMigrationSource,
  meetingsMigrationSource,
  memoryHindsightMigrationSource,
  memoryInboxMigrationSource,
  memoryMigrationSource,
  personas,
  repoGitMigrationSource,
  retentionMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MEETING_AUDIO_DEFAULT_DAYS, startSweep, sweepStep, type SweepState } from '../src/sweep.ts';

// Recorded meeting audio (P15-15, retention 0002): the sweep deletes the Files row of a recording once its day has passed, never earlier than a day after it stopped, keeps the
// recording row, and a dry run only counts. Each step is its own system transaction, as the job would make it.

const { omar, nadia } = personas;
const DAY = 24 * 3_600_000;

let db: TestDatabase;
let sysPool: pg.Pool;
let owner: pg.Client;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const ago = (days: number, extraMs = 0): string => new Date(Date.now() - days * DAY + extraMs).toISOString();

let channelId = '';
let meetingId = '';
let counter = 0;

async function recording(over: { stoppedAt?: string | null; deleteAfter?: string | null; withFile?: boolean; workspaceId?: string } = {}): Promise<{ recordingId: string; fileId: string | null }> {
  counter += 1;
  const n = counter;
  return sys(async (tx) => {
    let fileId: string | null = null;
    if (over.withFile !== false) {
      fileId = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
           VALUES ($1, $2, 'channels/dev/meetings/10-0900-standup/audio/', $3, md5($3), 44, 'audio/wav', repeat('a', 64), $4) RETURNING id`,
          [omar.workspaceId, channelId, `voice-${n}.wav`, nadia.actorId],
        )
      ).rows[0]!.id;
    }
    const stoppedAt = over.stoppedAt === undefined ? ago(31) : over.stoppedAt;
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.meeting_recordings (meeting_id, workspace_id, actor_id, file_id, started_at, stopped_at, stop_reason, delete_after)
         VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::timestamptz) RETURNING id`,
        [meetingId, omar.workspaceId, nadia.actorId, fileId, ago(32), stoppedAt, stoppedAt === null ? null : 'ended', over.deleteAfter === undefined ? ago(1) : over.deleteAfter],
      )
    ).rows[0]!.id;
    return { recordingId: row, fileId };
  });
}

const fileExists = (id: string | null): Promise<boolean> => sys(async (tx) => id !== null && (await tx.query('SELECT 1 FROM app.files WHERE id = $1', [id])).rows.length > 0);
const recordingFile = (id: string): Promise<string | null | undefined> =>
  sys(async (tx) => (await tx.query<{ file_id: string | null }>('SELECT file_id FROM app.meeting_recordings WHERE id = $1', [id])).rows[0]?.file_id);

/** One whole sweep, step by step. Returns the audio files it deleted (or would have) and how many steps it took. */
async function sweep(options: { dryRun?: boolean; forge?: (state: SweepState) => SweepState } = {}): Promise<{ audioFiles: number; steps: number }> {
  const started: SweepState = await sys((tx) => startSweep(tx, omar.workspaceId, new Date(), options.dryRun ?? false));
  let state: SweepState = options.forge ? options.forge(started) : started;
  for (let steps = 1; steps < 200; steps += 1) {
    const current = state;
    const result = await sys((tx) => sweepStep(tx, current));
    if (result.done) return { audioFiles: result.audioFiles, steps };
    state = result.state;
  }
  throw new Error('the sweep did not finish');
}

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      filesMigrationSource,
      botsMigrationSource,
      gatewayMcpMigrationSource,
      approvalsMigrationSource,
      repoGitMigrationSource,
      memoryMigrationSource,
      memoryHindsightMigrationSource,
      knowledgeMigrationSource,
      memoryInboxMigrationSource,
      meetingsMigrationSource,
      retentionMigrationSource,
    ],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  owner = testClient({ connectionString: db.ownerUrl });
  await owner.connect();
  channelId = await sys(
    async (tx) =>
      (await tx.query<{ id: string }>("INSERT INTO app.channels (workspace_id, team_id, name, kind, private) VALUES ($1, $2, 'dev', 'channel', false) RETURNING id", [omar.workspaceId, TEAM_IDS.Engineering])).rows[0]!.id,
  );
  meetingId = await sys(
    async (tx) =>
      (await tx.query<{ id: string }>('INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id) VALUES ($1, $2, $3, $4, $4) RETURNING id', [omar.workspaceId, channelId, 'Standup', nadia.actorId])).rows[0]!
        .id,
  );
}, 180_000);

afterAll(async () => {
  delete process.env['MANYTHREADS_RETENTION_BATCH'];
  await sysPool?.end();
  await owner?.end();
  if (db) await dropTestDatabase(db);
});

beforeEach(async () => {
  delete process.env['MANYTHREADS_RETENTION_BATCH'];
  await sys(async (tx) => {
    await tx.query('DELETE FROM app.meeting_recordings');
    await tx.query("DELETE FROM app.files WHERE mime = 'audio/wav'");
  });
});

describe('the migration', () => {
  it('adds delete_after to the recordings table', async () => {
    const col = await owner.query("SELECT data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'meeting_recordings' AND column_name = 'delete_after'");
    expect(col.rows[0]).toEqual({ data_type: 'timestamp with time zone' });
  });
});

describe('which recorded audio is deleted', () => {
  it('deletes the file of a recording past its day, keeps the recording row, and leaves the rest alone', async () => {
    const expired = await recording({ stoppedAt: ago(31), deleteAfter: ago(1) });
    const notYet = await recording({ stoppedAt: ago(5), deleteAfter: new Date(Date.now() + 25 * DAY).toISOString() });
    const noDate = await recording({ stoppedAt: ago(31), deleteAfter: null });
    const noDateYoung = await recording({ stoppedAt: ago(10), deleteAfter: null });
    const stillOpen = await recording({ stoppedAt: null, deleteAfter: ago(2), withFile: false });
    const noFile = await recording({ stoppedAt: ago(40), deleteAfter: ago(10), withFile: false });
    const other = await sys(
      async (tx) =>
        (
          await tx.query<{ id: string }>(
            `INSERT INTO app.files (workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
             VALUES ($1, $2, 'channels/dev/', 'notes.pdf', md5('notes'), 10, 'application/pdf', repeat('b', 64), $3) RETURNING id`,
            [omar.workspaceId, channelId, nadia.actorId],
          )
        ).rows[0]!.id,
    );

    const { audioFiles } = await sweep();
    expect(audioFiles).toBe(2);
    expect(await fileExists(expired.fileId)).toBe(false);
    expect(await fileExists(noDate.fileId)).toBe(false);
    expect(await fileExists(notYet.fileId)).toBe(true);
    expect(await fileExists(noDateYoung.fileId)).toBe(true);
    expect(await fileExists(other)).toBe(true);
    // the history stays: the row says a recording was made, with no file now
    expect(await recordingFile(expired.recordingId)).toBeNull();
    expect(await recordingFile(noDate.recordingId)).toBeNull();
    expect(await recordingFile(notYet.recordingId)).toBe(notYet.fileId);
    expect(await recordingFile(stillOpen.recordingId)).toBeNull();
    expect(await recordingFile(noFile.recordingId)).toBeNull();

    // a second sweep finds nothing more
    expect((await sweep()).audioFiles).toBe(0);
    await sys((tx) => tx.query('DELETE FROM app.files WHERE id = $1', [other]));
  });

  it('never deletes audio within a day of its stopping, whatever delete_after says', async () => {
    const fresh = await recording({ stoppedAt: ago(0, -2 * 3_600_000), deleteAfter: ago(5) });
    expect((await sweep()).audioFiles).toBe(0);
    expect(await fileExists(fresh.fileId)).toBe(true);
  });

  it('a dry run counts and deletes nothing', async () => {
    const a = await recording();
    const b = await recording({ deleteAfter: null });
    const { audioFiles } = await sweep({ dryRun: true });
    expect(audioFiles).toBe(2);
    expect(await fileExists(a.fileId)).toBe(true);
    expect(await fileExists(b.fileId)).toBe(true);
    expect(await recordingFile(a.recordingId)).toBe(a.fileId);
  });

  it('takes a backlog in batches', async () => {
    process.env['MANYTHREADS_RETENTION_BATCH'] = '2';
    const all = await Promise.all([1, 2, 3, 4, 5].map(() => recording()));
    const real = await sweep();
    expect(real.audioFiles).toBe(5);
    expect(real.steps).toBeGreaterThan(3);
    for (const r of all) expect(await fileExists(r.fileId)).toBe(false);
    process.env['MANYTHREADS_RETENTION_BATCH'] = '2';
    const again = await Promise.all([1, 2, 3, 4, 5].map(() => recording()));
    expect((await sweep({ dryRun: true })).audioFiles).toBe(5);
    for (const r of again) expect(await fileExists(r.fileId)).toBe(true);
  });

  it('does not touch another workspace', async () => {
    const mine = await recording();
    const foreign = '11111111-1111-4111-8111-111111111111';
    const { audioFiles } = await sys(async (tx) => {
      void tx;
      return sweepOther(foreign);
    });
    expect(audioFiles).toBe(0);
    expect(await fileExists(mine.fileId)).toBe(true);
  });

  it('uses the default of 30 days when the meetings plugin wrote none', () => {
    expect(MEETING_AUDIO_DEFAULT_DAYS).toBe(30);
  });
});

async function sweepOther(workspaceId: string): Promise<{ audioFiles: number }> {
  let state: SweepState = await sys((tx) => startSweep(tx, workspaceId, new Date(), false));
  for (let i = 0; i < 100; i += 1) {
    const current = state;
    const result = await sys((tx) => sweepStep(tx, current));
    if (result.done) return { audioFiles: result.audioFiles };
    state = result.state;
  }
  throw new Error('the sweep did not finish');
}
