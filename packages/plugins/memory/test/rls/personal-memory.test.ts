import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import type { ActorId, RunId } from '@manythreads/shared';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  filesMigrationSource,
  findPerRowPolicyCalls,
  memoryMigrationSource,
  personaActor,
  personas,
  repoGitMigrationSource,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P20-05: a person's own Memory (an OKF bundle kept as rows). Read by the owner alone (an admin only during a live audited open); written ONLY through the
// two database doors, which let in the owner, the bot of a run the owner asked and allowed, and the system role; a bot never replaces a file a person wrote.

const { omar, nadia, rafi, lena } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const sha = (n: number): string => String(n).repeat(64).slice(0, 64);

const meta = (type = 'Fact', extra: Record<string, unknown> = {}): string => JSON.stringify({ type, title: 't', tags: [], status: 'stable', trust_tier: 'unverified', origin: '', share_never: false, blob_sha: 'a'.repeat(40), ...extra });
type Put = { status: string; version_no: number; caller_kind: string | null };
const PUT = 'SELECT status, version_no, caller_kind FROM app.memory_personal_put($1::uuid, $2, $3, $4::jsonb, $5::int, $6::boolean)';
const put = (tx: Tx, owner: string, path: string, text: string, opts: { base?: number | null; check?: boolean; meta?: string } = {}): Promise<Put | undefined> =>
  tx.query<Put>(PUT, [owner, path, text, opts.meta ?? meta(), opts.base ?? null, opts.check ?? false]).then((r) => r.rows[0]);

let helperId = '';
let helperActor = '';
let teamChannelId = '';
const runs: Record<string, string> = {};

/** Runs a statement as the run's bot. */
const asBot = <T>(runKey: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withActor({ kind: 'bot', id: helperActor as ActorId, workspaceId: omar.workspaceId, runId: runs[runKey] as RunId }, fn, { pool: appPool });

async function makeRun(tx: Tx, key: string, trigger: string, asker: string | null, channelId: string | null): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
    [omar.workspaceId, helperId, ENG, trigger, asker, channelId],
  );
  runs[key] = r.rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, approvalsMigrationSource, repoGitMigrationSource, memoryMigrationSource],
  });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    teamChannelId = (await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name, kind) VALUES ($1, $2, 'mem-room', 'channel') RETURNING id`, [omar.workspaceId, ENG])).rows[0]!.id;
    const bot = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement)
       VALUES ($1, $2, 'helper', 'helper', 'Helps', 'agent', 'hermes', 'team', $3, 'active', '{"runner": "default"}') RETURNING id`,
      [omar.workspaceId, ENG, sha(1)],
    );
    helperId = bot.rows[0]!.id;
    helperActor = (await tx.query<{ id: string }>(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2) RETURNING id`, [omar.workspaceId, helperId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read')`, [ENG, helperActor]);
    await makeRun(tx, 'conv', 'conversation', nadia.actorId, null);
    await makeRun(tx, 'team', 'mention', nadia.actorId, teamChannelId);
  });
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const TABLES = ['memory_personal_files', 'memory_personal_versions'];
const countOf = (p: Persona, table = 'memory_personal_files'): Promise<number> =>
  as(p, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.${table}`)).rows[0]?.n ?? 0));

describe('a person\'s own Memory tables (P20-05)', () => {
  it('pass the RLS audit and call no function per row', async () => {
    const client = testClient({ connectionString: db.ownerUrl });
    await client.connect();
    try {
      expect(await explainRlsViolations(client)).toEqual([]);
      for (const table of TABLES) expect(await findPerRowPolicyCalls(client, table), table).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('are written through the door by their owner, one version at a time, and the same text again is not a new version', async () => {
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', '---\ntype: Person\n---\nRafi likes tea.'))).toEqual({ status: 'ok', version_no: 1, caller_kind: 'person' });
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', '---\ntype: Person\n---\nRafi likes tea.'))).toMatchObject({ status: 'unchanged', version_no: 1 });
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', '---\ntype: Person\n---\nRafi likes coffee.'))).toMatchObject({ status: 'ok', version_no: 2 });
    const versions = await as(nadia, async (tx) => (await tx.query<{ version_no: number; author_kind: string }>('SELECT version_no, author_kind FROM app.memory_personal_versions ORDER BY version_no')).rows);
    expect(versions).toEqual([{ version_no: 1, author_kind: 'person' }, { version_no: 2, author_kind: 'person' }]);
  });

  it('refuse an edit made from an old version (the file moved) and a "must not exist" write over a file that does', async () => {
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', 'x', { check: true, base: 1 }))).toMatchObject({ status: 'conflict', version_no: 2 });
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', 'x', { check: true, base: null }))).toMatchObject({ status: 'conflict', version_no: 2 });
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/new.md', 'x', { check: true, base: 3 }))).toMatchObject({ status: 'conflict', version_no: 0 });
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'people/rafi.md', '---\ntype: Person\n---\nv3', { check: true, base: 2 }))).toMatchObject({ status: 'ok', version_no: 3 });
  });

  it('are read by their owner alone: not a teammate, an admin without an open, or a guest', async () => {
    expect(await countOf(nadia)).toBe(1);
    expect(await countOf(nadia, 'memory_personal_versions')).toBe(3);
    for (const other of [rafi, omar, lena]) {
      expect(await countOf(other), other.key).toBe(0);
      expect(await countOf(other, 'memory_personal_versions'), other.key).toBe(0);
    }
  });

  it('are never written directly: the request role has no write privilege, and the doors refuse anyone but the owner, an allowed bot or the system', async () => {
    expect(await code(as(nadia, (tx) => tx.query(`UPDATE app.memory_personal_files SET content = 'tampered'`)))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query(`DELETE FROM app.memory_personal_files`)))).toBe('42501');
    expect(await as(rafi, (tx) => put(tx, nadia.personId, 'people/planted.md', 'x'))).toMatchObject({ status: 'forbidden' });
    expect(await as(omar, (tx) => put(tx, nadia.personId, 'people/planted.md', 'x'))).toMatchObject({ status: 'forbidden' });
    expect(await as(lena, (tx) => put(tx, lena.personId, 'people/guest.md', 'x'))).toMatchObject({ status: 'forbidden' });
    expect(await as(rafi, async (tx) => (await tx.query('SELECT * FROM app.memory_personal_delete($1::uuid, $2)', [nadia.personId, 'people/rafi.md'])).rows[0])).toMatchObject({ status: 'forbidden' });
    expect(await countOf(nadia)).toBe(1);
  });

  it('are read by an admin during a live audited open and never written by them', async () => {
    await as(omar, (tx) => tx.query('SELECT * FROM app.open_personal_space($1, $2)', [nadia.personId, 'support request']));
    expect(await countOf(omar)).toBe(1);
    expect(await as(omar, (tx) => put(tx, nadia.personId, 'people/planted.md', 'x'))).toMatchObject({ status: 'forbidden' });
    expect(await countOf(nadia)).toBe(1);
  });

  it('are written by the bot of a run the owner asked and allowed, and by that run only', async () => {
    // no answer yet: the default for a team bot is no
    expect(await asBot('conv', (tx) => put(tx, nadia.personId, 'facts/bot.md', 'x'))).toMatchObject({ status: 'forbidden' });
    await as(nadia, (tx) => tx.query(`INSERT INTO app.bot_personal_consents (person_id, bot_id, workspace_id, allowed) VALUES ($1, $2, $3, true)`, [nadia.personId, helperId, omar.workspaceId]));
    expect(await asBot('conv', (tx) => put(tx, nadia.personId, 'facts/bot.md', '---\ntype: Fact\n---\nbot wrote this'))).toEqual({ status: 'ok', version_no: 1, caller_kind: 'bot' });
    // the same bot in a team channel has no Personal space; it can never write someone else's bundle either
    expect(await asBot('team', (tx) => put(tx, nadia.personId, 'facts/bot2.md', 'x'))).toMatchObject({ status: 'forbidden' });
    expect(await asBot('conv', (tx) => put(tx, rafi.personId, 'facts/bot3.md', 'x'))).toMatchObject({ status: 'forbidden' });
    // a bot never deletes
    expect(await asBot('conv', async (tx) => (await tx.query('SELECT * FROM app.memory_personal_delete($1::uuid, $2)', [nadia.personId, 'facts/bot.md'])).rows[0])).toMatchObject({ status: 'forbidden' });
  });

  it('never let a bot replace a file a person wrote, but let it update its own', async () => {
    expect(await asBot('conv', (tx) => put(tx, nadia.personId, 'people/rafi.md', 'bot overwrites'))).toMatchObject({ status: 'person_owned', version_no: 3 });
    expect(await asBot('conv', (tx) => put(tx, nadia.personId, 'facts/bot.md', '---\ntype: Fact\n---\nbot wrote this again'))).toMatchObject({ status: 'ok', version_no: 2, caller_kind: 'bot' });
  });

  it('end a bot\'s access on the next call when the person withdraws their yes', async () => {
    await as(nadia, (tx) => tx.query(`UPDATE app.bot_personal_consents SET allowed = false WHERE bot_id = $1`, [helperId]));
    expect(await asBot('conv', (tx) => put(tx, nadia.personId, 'facts/bot.md', 'again'))).toMatchObject({ status: 'forbidden' });
  });

  it('keep the newest 50 versions of a file', async () => {
    for (let i = 1; i <= 53; i += 1) await as(nadia, (tx) => put(tx, nadia.personId, 'daily/log.md', `---\ntype: Log\n---\nentry ${i}`));
    const rows = await as(nadia, async (tx) => (await tx.query<{ lo: number; hi: number; n: string }>(`SELECT min(version_no) AS lo, max(version_no) AS hi, count(*)::text AS n FROM app.memory_personal_versions WHERE path = 'daily/log.md'`)).rows[0]);
    expect(rows).toEqual({ lo: 4, hi: 53, n: '50' });
  });

  it('are deleted with their versions by the owner, and by the system', async () => {
    expect(await as(nadia, async (tx) => (await tx.query('SELECT * FROM app.memory_personal_delete($1::uuid, $2)', [nadia.personId, 'daily/log.md'])).rows[0])).toEqual({ status: 'ok' });
    expect(await as(nadia, async (tx) => (await tx.query('SELECT * FROM app.memory_personal_delete($1::uuid, $2)', [nadia.personId, 'daily/log.md'])).rows[0])).toEqual({ status: 'not_found' });
    expect(await as(nadia, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app.memory_personal_versions WHERE path = 'daily/log.md'`)).rows[0]!.n))).toBe(0);
    expect(await sys((tx) => put(tx, nadia.personId, 'inbox/filed.md', '---\ntype: Fact\n---\nfrom the inbox'))).toEqual({ status: 'ok', version_no: 1, caller_kind: 'system' });
    expect(await sys(async (tx) => (await tx.query('SELECT * FROM app.memory_personal_delete($1::uuid, $2)', [nadia.personId, 'inbox/filed.md'])).rows[0])).toEqual({ status: 'ok' });
  });

  it('refuse a file over the size cap and a person\'s 2001st file', async () => {
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'big.md', 'x'.repeat(1_000_001)))).toMatchObject({ status: 'too_large' });
    await sys((tx) =>
      tx.query(
        `INSERT INTO app.memory_personal_files (owner_person_id, workspace_id, path, content, size_bytes, type, blob_sha)
         SELECT $1, $2, 'bulk/' || g || '.md', 'x', 1, 'Fact', repeat('b', 40) FROM generate_series(1, 2000 - (SELECT count(*) FROM app.memory_personal_files WHERE owner_person_id = $1)::int) g`,
        [nadia.personId, omar.workspaceId],
      ),
    );
    expect(await as(nadia, (tx) => put(tx, nadia.personId, 'one-more.md', '---\ntype: Fact\n---\nx'))).toMatchObject({ status: 'too_many_files' });
  });
});
