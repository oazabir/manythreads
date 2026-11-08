import { createSystemPool, withSystem, type Tx } from '@manythreads/kernel';
import { HttpError, type InboxDropper, type PluginContext } from '@manythreads/sdk';
import { createHash } from 'node:crypto';
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  filesMigrationSource,
  memoryInboxMigrationSource,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createInboxDropper } from '../src/dropper.ts';

// The `inbox.dropper` provider (PLAN P15-11): a finished voice room's notes and transcript become one markdown item of origin `meeting` in the team's memory inbox, named for the
// first person of the room who said yes, held at once when somebody from outside the team was there. No server and no model: the provider runs against a real database.

const { omar, nadia, rafi } = personas;
const ENG = TEAM_IDS.Engineering;

let db: TestDatabase;
let sysPool: pg.Pool;
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

const blobs = new Map<string, Uint8Array>();
const enqueued: string[] = [];
const audits: Array<Record<string, unknown>> = [];
const storage = {
  id: 'storage',
  async put(stream: AsyncIterable<Uint8Array>): Promise<{ blobKey: string; size: number; sha256: string }> {
    const parts: Uint8Array[] = [];
    for await (const chunk of stream) parts.push(chunk);
    const bytes = Buffer.concat(parts);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    blobs.set(sha256, bytes);
    return { blobKey: sha256, size: bytes.length, sha256 };
  },
  async delete(key: string): Promise<boolean> {
    return blobs.delete(key);
  },
};
const ctx = {
  providers: { get: (kind: string): unknown => (kind === 'storage' ? storage : undefined) },
  jobs: {
    async enqueue(_tx: unknown, queue: string): Promise<void> {
      enqueued.push(queue);
    },
  },
  audit: {
    async emit(_tx: unknown, event: Record<string, unknown>): Promise<void> {
      audits.push(event);
    },
  },
  realtime: { async pushToPerson(): Promise<void> {} },
  runtime: { now: () => new Date('2026-11-02T10:00:00Z') },
} as unknown as PluginContext;
const dropper: InboxDropper = createInboxDropper(ctx);

beforeAll(async () => {
  db = await createTestDatabase({
    sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, filesMigrationSource, botsMigrationSource, memoryInboxMigrationSource],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
}, 120_000);
afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});
beforeEach(async () => {
  await sys((tx) => tx.query('DELETE FROM app.memory_inbox_items'));
  blobs.clear();
  enqueued.length = 0;
  audits.length = 0;
});

const drop = (input: Partial<Parameters<InboxDropper['drop']>[1]> & { markdown: string }) =>
  sys((tx) => dropper.drop(tx as never, { teamId: ENG, name: 'Sprint review · 2026-11-02', origin: 'meeting', dropperIds: [nadia.actorId], ...input }));
const row = (id: string) =>
  sys(async (tx) => (await tx.query<{ origin: string; kind: string; state: string; hold_reason: string | null; reason: string | null; dropper_id: string | null; dropper_name: string | null; team_only: boolean; name: string }>('SELECT origin, kind, state, hold_reason, reason, dropper_id, dropper_name, team_only, name FROM app.memory_inbox_items WHERE id = $1', [id])).rows[0]!);

describe('the meeting dropper', () => {
  it('files the markdown as one item of origin meeting, named for the first person of the room, and starts the inbox\'s own first job', async () => {
    const done = await drop({ markdown: '# Sprint review\n\nShip on Thursday.', dropperIds: [rafi.actorId, nadia.actorId] });
    expect(done.state).toBe('queued');
    expect(await row(done.itemId)).toMatchObject({ origin: 'meeting', kind: 'markdown', state: 'queued', dropper_id: rafi.actorId, dropper_name: 'Rafi', team_only: false, name: 'Sprint review · 2026-11-02' });
    expect(enqueued).toEqual(['memory-inbox.hold']);
    expect(audits.map((a) => a['type'])).toEqual(['memory.item.dropped']);
    expect(audits[0]).toMatchObject({ origin: 'meeting', droppedBy: rafi.actorId });
    expect(Buffer.from([...blobs.values()][0]!).toString('utf8')).toContain('Ship on Thursday.');
  });

  it('skips a dropper id that is not a person of the workspace, and names nobody when none is', async () => {
    const stranger = '00000000-0000-7000-8000-00000000ffff';
    expect(await row((await drop({ markdown: 'one', dropperIds: [stranger, omar.actorId] })).itemId)).toMatchObject({ dropper_id: omar.actorId });
    expect(await row((await drop({ markdown: 'two', dropperIds: [stranger] })).itemId)).toMatchObject({ dropper_id: null, dropper_name: null });
  });

  it('holds the item at once, for a lead, when somebody from outside the team was in the room', async () => {
    const done = await drop({ markdown: 'A call with a guest.', hold: 'external' });
    expect(done.state).toBe('held');
    expect(await row(done.itemId)).toMatchObject({ state: 'held', hold_reason: 'unknown_sender', dropper_id: nadia.actorId });
    expect((await row(done.itemId)).reason).toContain('outside the team');
    expect(audits.map((a) => a['type'])).toEqual(['memory.item.dropped', 'memory.item.held']);
  });

  it('answers the same item for the same bytes and holds nothing twice', async () => {
    const first = await drop({ markdown: 'The same call.' });
    const again = await drop({ markdown: 'The same call.', hold: 'external' });
    expect((await row(again.itemId)).state).toBe('duplicate');
    expect(again.state).toBe('duplicate');
    expect(again.itemId).not.toBe(first.itemId);
  });

  it('refuses a team that does not exist, a team that is archived, and a meeting too long to file', async () => {
    await expect(drop({ teamId: '00000000-0000-7000-8000-00000000eeee', markdown: 'x' })).rejects.toMatchObject({ status: 404 });
    await sys((tx) => tx.query('UPDATE app.teams SET archived_at = now() WHERE id = $1', [TEAM_IDS.Marketing]));
    try {
      await expect(drop({ teamId: TEAM_IDS.Marketing, markdown: 'x' })).rejects.toBeInstanceOf(HttpError);
      await expect(drop({ markdown: 'x'.repeat(2_600_000) })).rejects.toMatchObject({ status: 413 });
    } finally {
      await sys((tx) => tx.query('UPDATE app.teams SET archived_at = NULL WHERE id = $1', [TEAM_IDS.Marketing]));
    }
  });
});
