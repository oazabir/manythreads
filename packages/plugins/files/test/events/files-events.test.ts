import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { eventRegistry, parseEvent } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type FilesWorld } from '../world.ts';

const { nadia, rafi, sameera } = personas;

// Event contract tests (pnpm test:events): the two events the files plugin emits are stored in the shape their registered schema accepts, as the
// acting person, with the team of the channel; a refused request emits nothing.

let w: FilesWorld;
let dev = '';
let teamId = '';
let before: string | null = null;
let fileId = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  teamId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
  before = await w.system(async (tx) => (await tx.query<{ id: string | null }>('SELECT max(id::text)::text AS id FROM app.events')).rows[0]?.id ?? null);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const stored = (): Promise<EventRow[]> =>
  w.system(async (tx) => {
    const res = await tx.query<EventRow>(
      `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
        WHERE ($1::uuid IS NULL OR id > $1::uuid) AND type LIKE 'files.%' ORDER BY id`,
      [before],
    );
    return res.rows;
  });

describe('files events', () => {
  it('an upload emits files.file.uploaded as the uploader, with the channel and its team', async () => {
    const res = await w.upload(nadia, dev, '%PDF-1.4', { name: 'events.pdf', type: 'application/pdf' });
    expect(res.status).toBe(201);
    fileId = (res.body as { id: string }).id;
    const rows = await stored();
    expect(rows.map((r) => r.type)).toEqual(['files.file.uploaded']);
    const row = rows[0]!;
    expect(row.actor_id).toBe(nadia.actorId);
    expect(row.team_id).toBe(teamId);
    const parsed = parseEvent(eventToRaw(row));
    expect(parsed).toMatchObject({ type: 'files.file.uploaded', schemaVersion: 1, channelId: dev, teamId, fileId, uploaderId: nadia.actorId, name: 'events.pdf', size: 8, mime: 'application/pdf' });
  });

  it('refused requests (no access, too large, hidden channel) emit nothing', async () => {
    const count = (await stored()).length;
    expect((await w.upload(sameera, dev, 'x', { name: 'no.txt' })).status).toBe(403);
    expect((await w.call(sameera, 'DELETE', `/api/files/${fileId}`)).status).toBe(403);
    expect((await w.call(rafi, 'DELETE', `/api/files/${fileId}`)).status).toBe(403);
    process.env['MANYTHREADS_MAX_UPLOAD_BYTES'] = '4';
    try {
      expect((await w.upload(nadia, dev, 'too large', { name: 'big.txt' })).status).toBe(413);
    } finally {
      delete process.env['MANYTHREADS_MAX_UPLOAD_BYTES'];
    }
    expect(await stored()).toHaveLength(count);
  });

  it('a delete emits files.file.deleted as the person who deleted', async () => {
    expect((await w.call(nadia, 'DELETE', `/api/files/${fileId}`)).status).toBe(200);
    const rows = await stored();
    expect(rows.map((r) => r.type)).toEqual(['files.file.uploaded', 'files.file.deleted']);
    const parsed = parseEvent(eventToRaw(rows[1]!));
    expect(parsed).toMatchObject({ type: 'files.file.deleted', fileId, channelId: dev, teamId, deletedBy: nadia.actorId });
  });

  it('both types are in the registry at version 1', () => {
    expect(Object.keys(eventRegistry['files.file.uploaded'])).toEqual(['1']);
    expect(Object.keys(eventRegistry['files.file.deleted'])).toEqual(['1']);
  });
});
