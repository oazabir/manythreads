import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import type { PluginContext, PluginTx } from '@manythreads/sdk';
import type { ActorId, RunId } from '@manythreads/shared';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { filesReadFor } from '../../src/read.ts';

// P20-08: `files.read`. A bot reads the asker's Personal files only in a private context the asker and the bot allow, never by a place it names; a file of a
// team only when the run may read that team. Run as the asker, like the gateway's reader transaction.

const { omar, nadia, rafi } = personas;
const ENG = TEAM_IDS.Engineering;
const MKT = TEAM_IDS.Marketing;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const bytes: Record<string, string> = {};
const ctx = {
  providers: { get: () => ({ get: async (key: string): Promise<AsyncIterable<Uint8Array>> => (async function* () { yield Buffer.from(bytes[key] ?? ''); })() }) },
} as unknown as PluginContext;
const read = filesReadFor(ctx);

const runs: Record<string, string> = {};
const ids: Record<string, string> = {};
/** The capability as the asker, inside the run: the same transaction the gateway opens for a read tool. */
const call = (runKey: string, asker: { actorId: string }, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  withActor({ kind: 'person', id: asker.actorId as ActorId, workspaceId: omar.workspaceId, runId: runs[runKey] as RunId }, (tx) => read(input, tx as unknown as PluginTx), { pool: appPool });

async function makeBot(tx: Tx, slug: string, scope: 'team' | 'workspace', team: string): Promise<string> {
  const bot = await tx.query<{ id: string }>(
    `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status, placement, scope)
     VALUES ($1, $2, $3, $3, 'Helps', 'agent', 'hermes', $4, repeat('1', 64), 'active', '{"runner": "default"}', $5) RETURNING id`,
    [omar.workspaceId, team, slug, scope === 'workspace' ? 'workspace' : 'team', scope],
  );
  await tx.query(`INSERT INTO app.actors (workspace_id, kind, ref_id) VALUES ($1, 'bot', $2)`, [omar.workspaceId, bot.rows[0]!.id]);
  return bot.rows[0]!.id;
}
async function makeRun(tx: Tx, key: string, botId: string, trigger: string, asker: string, channelId: string | null, team = ENG): Promise<void> {
  runs[key] = (
    await tx.query<{ id: string }>(
      `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, asker_id, channel_id, status) VALUES ($1, $2, $3, $4, $5, $6, 'running') RETURNING id`,
      [omar.workspaceId, botId, team, trigger, asker, channelId],
    )
  ).rows[0]!.id;
}
async function makeFile(tx: Tx, key: string, cols: { owner?: string; team?: string; channel?: string; folder: string; name: string; mime?: string; text: string }): Promise<void> {
  const blob = `blob-${key}`;
  bytes[blob] = cols.text;
  ids[key] = (
    await tx.query<{ id: string }>(
      `INSERT INTO app.files (workspace_id, owner_person_id, team_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, repeat('a', 64), $10) RETURNING id`,
      [omar.workspaceId, cols.owner ?? null, cols.team ?? null, cols.channel ?? null, cols.folder, cols.name, blob, cols.text.length, cols.mime ?? 'text/markdown', nadia.actorId],
    )
  ).rows[0]!.id;
}

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    const channel = (await tx.query<{ id: string }>(`INSERT INTO app.channels (workspace_id, team_id, name, kind) VALUES ($1, $2, 'read-room', 'channel') RETURNING id`, [omar.workspaceId, ENG])).rows[0]!.id;
    const brain = await makeBot(tx, 'brain', 'workspace', ENG);
    const helper = await makeBot(tx, 'helper', 'team', ENG);
    await makeRun(tx, 'conv', brain, 'conversation', nadia.actorId, null);
    await makeRun(tx, 'channel', brain, 'mention', nadia.actorId, channel);
    await makeRun(tx, 'helper', helper, 'conversation', nadia.actorId, null);
    for (const [owner, name] of [[nadia, 'plans.md'], [rafi, 'rafi-secret.md']] as const) {
      await tx.query('INSERT INTO app.personal_folders (workspace_id, owner_person_id, path) VALUES ($1, $2, $3)', [omar.workspaceId, owner.personId, 'Notes']);
      await makeFile(tx, owner.key, { owner: owner.personId, folder: 'Notes/', name, text: `${owner.key}: the trip is in May` });
    }
    await makeFile(tx, 'pic', { owner: nadia.personId, folder: 'Notes/', name: 'photo.png', mime: 'image/png', text: 'not text' });
    await makeFile(tx, 'long', { owner: nadia.personId, folder: 'Notes/', name: 'long.md', text: 'word '.repeat(100) });
    await makeFile(tx, 'eng', { team: ENG, folder: 'docs/', name: 'handbook.md', text: 'engineering handbook' });
    await makeFile(tx, 'mkt', { team: MKT, folder: 'docs/', name: 'plan.md', text: 'marketing plan' });
  });
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('files.read', () => {
  it('reads a Personal file by path, lists a folder and the top folders, for the workspace Brain in a conversation', async () => {
    const file = await call('conv', nadia, { path: 'Notes/plans.md' });
    expect(file).toMatchObject({ ok: true, file: { name: 'plans.md', space: 'personal', path: 'Notes/plans.md' }, text: 'nadia: the trip is in May' });
    const folder = await call('conv', nadia, { path: 'Notes' });
    expect(folder).toMatchObject({ ok: true, folder: 'Notes', files: [{ name: 'long.md' }, { name: 'photo.png' }, { name: 'plans.md' }] });
    expect(await call('conv', nadia, {})).toMatchObject({ ok: true, folder: '', folders: ['Notes'], files: [] });
    expect(await call('conv', nadia, { fileId: ids['nadia'] })).toMatchObject({ ok: true, text: 'nadia: the trip is in May' });
  });

  it('answers the name and size of a file that is not text, and cuts a long text', async () => {
    expect(await call('conv', nadia, { path: 'Notes/photo.png' })).toMatchObject({ ok: true, text: null });
    const cut = await call('conv', nadia, { path: 'Notes/long.md', maxChars: 200 });
    expect(cut).toMatchObject({ ok: true, truncated: true });
    expect((cut['text'] as string).length).toBe(200);
  });

  it('does not open another person\'s Personal file, by id or by path, and says the same as for a file that is not there', async () => {
    const other = await call('conv', nadia, { fileId: ids['rafi'] });
    const none = await call('conv', nadia, { fileId: '00000000-0000-7000-8000-00000000dead' });
    expect(other).toEqual(none);
    expect(other).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call('conv', nadia, { path: 'Notes/rafi-secret.md' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call('conv', nadia, { path: '../Notes/plans.md' })).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('keeps Personal files shut in a team channel and for a bot that did not ask for them; a file by id still follows the run\'s teams', async () => {
    expect(await call('channel', nadia, { path: 'Notes/plans.md' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await call('channel', nadia, { fileId: ids['nadia'] })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await call('helper', nadia, { path: 'Notes/plans.md' })).toMatchObject({ ok: false, code: 'forbidden', message: 'This bot is not set up to read Personal files.' });
  });

  it('reads a team file only for a team the run may read', async () => {
    expect(await call('channel', nadia, { fileId: ids['eng'] })).toMatchObject({ ok: true, text: 'engineering handbook', file: { space: 'team' } });
    // Nadia reads Marketing? she is not in it: not found, whatever the run says
    expect(await call('conv', nadia, { fileId: ids['mkt'] })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses outside a run', async () => {
    const out = await withActor({ kind: 'person', id: nadia.actorId as ActorId, workspaceId: omar.workspaceId }, (tx) => read({ path: 'Notes' }, tx as unknown as PluginTx), { pool: appPool });
    expect(out).toMatchObject({ ok: false, code: 'not_a_run' });
  });
});
