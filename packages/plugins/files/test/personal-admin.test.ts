import {
  ListPersonalSpaceOpensResponse,
  OpenPersonalSpaceResponse,
  PersonFilesTreeResponse,
  PersonalFile,
  parseEvent,
} from '@manythreads/shared';
import { eventToRaw, type EventRow } from '@manythreads/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type FilesWorld } from './world.ts';
import { readZip } from './zip-reader.ts';

// P20-13: an admin opens a person's Personal space (reason, 60 minutes, read-only), looks at the tree, downloads a zip; the person sees who did.

const { omar, nadia, sameera, lena } = personas;

let w: FilesWorld;
let noteId = '';
beforeAll(async () => {
  w = await createWorld();
  const note = PersonalFile.parse((await w.uploadPersonal(nadia, 'Notes', 'nadia private note', { name: 'private.md', type: 'text/markdown' })).body);
  noteId = note.id;
  await w.uploadPersonal(nadia, 'Meetings', 'minutes', { name: 'اجتماع.md', type: 'text/markdown' });
  await w.call(nadia, 'POST', '/api/me/files/folders', { path: 'Ideas/Empty' });
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const open = (who: typeof omar | typeof nadia | null, target: { personId: string }, reason: string) =>
  w.call(who, 'POST', `/api/people/${target.personId}/personal-space/open`, { reason });
const eventsOf = (type: string): Promise<EventRow[]> =>
  w.system(async (tx) => (await tx.query<EventRow>('SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events WHERE type = $1 ORDER BY id', [type])).rows);
const expire = (): Promise<unknown> =>
  w.system((tx) => tx.query("UPDATE app.personal_space_access SET opened_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'"));

describe('before any open', () => {
  it('the tree, the zip and a file download are refused to an admin, with the sentence that says what to do', async () => {
    const tree = await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree`);
    expect(tree.status).toBe(403);
    expect(JSON.stringify(tree.body)).toMatch(/Open this Personal space first/);
    expect((await w.call(omar, 'POST', `/api/people/${nadia.personId}/personal-space/export`)).status).toBe(403);
    expect((await w.raw(omar, 'GET', `/api/files/${noteId}/content`)).status).toBe(403);
  });

  it('nobody but an owner or admin can open: a member, a guest and a stranger are refused, and nothing is recorded', async () => {
    expect((await open(sameera, nadia, 'curious')).status).toBe(403);
    expect((await open(lena, nadia, 'curious')).status).toBe(403);
    expect((await open(null, nadia, 'curious')).status).toBe(401);
    expect((await w.call(sameera, 'GET', `/api/people/${nadia.personId}/files/tree`)).status).toBe(403);
    expect(await eventsOf('personal.space.opened')).toHaveLength(0);
  });

  it('refuses your own space (400), an unknown person (404), and a missing, blank or too long reason (400)', async () => {
    expect((await open(omar, omar, 'my own')).status).toBe(400);
    expect((await open(omar, { personId: '00000000-0000-7000-8000-00000000ffff' }, 'nobody')).status).toBe(404);
    for (const reason of [undefined, '', '   ', 'x'.repeat(301)]) {
      expect((await w.call(omar, 'POST', `/api/people/${nadia.personId}/personal-space/open`, reason === undefined ? {} : { reason })).status, String(reason)).toBe(400);
    }
    expect((await w.call(omar, 'POST', `/api/people/${nadia.personId}/personal-space/open`, { reason: 'ok', extra: 1 })).status).toBe(400);
    expect(await eventsOf('personal.space.opened')).toHaveLength(0);
  });
});

describe('an open', () => {
  it('opens for 60 minutes and emits one event that holds no reason', async () => {
    const res = OpenPersonalSpaceResponse.parse(ok(await open(omar, nadia, '  Nadia asked me to recover the Thursday note  ')));
    const left = new Date(res.validUntil).getTime() - Date.now();
    expect(left).toBeGreaterThan(59 * 60_000);
    expect(left).toBeLessThanOrEqual(60 * 60_000);
    const events = await eventsOf('personal.space.opened');
    expect(events).toHaveLength(1);
    const parsed = parseEvent(eventToRaw(events[0]!));
    expect(parsed).toMatchObject({ type: 'personal.space.opened', personId: nadia.personId, adminActorId: omar.actorId, accessId: res.accessId });
    expect(JSON.stringify(events[0]!.payload)).not.toMatch(/Thursday|recover/);
  });

  it('shows the tree read-only: every row says admin_view, with the name of the person and when the open ends', async () => {
    const root = PersonFilesTreeResponse.parse(ok(await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree`)));
    expect(root.displayName).toBe(nadia.name);
    expect(new Date(root.validUntil).getTime()).toBeGreaterThan(Date.now());
    expect(root.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['Notes', 'Meetings', 'Ideas']));
    expect(root.entries.every((e) => e.readOnly && e.readOnlyReason === 'admin_view')).toBe(true);
    const notes = PersonFilesTreeResponse.parse(ok(await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree?path=Notes`)));
    expect(notes.entries).toMatchObject([{ kind: 'file', name: 'private.md', fileId: noteId, readOnly: true }]);
    expect((await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree?path=Nowhere`)).status).toBe(404);
  });

  it('reads the bytes during the open, and nothing can be changed through it', async () => {
    expect((await w.raw(omar, 'GET', `/api/files/${noteId}/content`)).bytes.toString()).toBe('nadia private note');
    expect((await w.call(omar, 'PATCH', `/api/me/files/${noteId}`, { name: 'by-admin.md' })).status).toBe(403);
    expect((await w.call(omar, 'DELETE', `/api/me/files/${noteId}`)).status).toBe(403);
    expect((await w.call(omar, 'GET', `/api/me/files/${noteId}/versions`)).status).toBe(403);
    expect((await w.call(sameera, 'GET', `/api/people/${nadia.personId}/files/tree`)).status).toBe(403);
    expect((await w.raw(sameera, 'GET', `/api/files/${noteId}/content`)).status).toBe(403);
    const tree = ok<{ entries: Array<{ name: string }> }>(await w.call(nadia, 'GET', '/api/me/files/tree?path=Notes'));
    expect(tree.entries.map((e) => e.name)).toEqual(['private.md']);
  });

  it('the open is only for the admin who made it: a second admin has none', async () => {
    await w.system((tx) => tx.query("UPDATE app.workspace_members SET role = 'admin' WHERE person_id = $1", [sameera.personId]));
    expect((await w.call(sameera, 'GET', `/api/people/${nadia.personId}/files/tree`)).status).toBe(403);
    await w.system((tx) => tx.query("UPDATE app.workspace_members SET role = 'member' WHERE person_id = $1", [sameera.personId]));
  });
});

describe('the person sees who opened their space', () => {
  it('lists the open with the admin\'s name, the reason and whether it is still live; nobody else sees it', async () => {
    const mine = ListPersonalSpaceOpensResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/personal-space/opens')));
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ adminPersonId: omar.personId, adminName: omar.name, reason: 'Nadia asked me to recover the Thursday note', active: true });
    expect(mine.nextCursor).toBeNull();
    expect(ListPersonalSpaceOpensResponse.parse(ok(await w.call(sameera, 'GET', '/api/me/personal-space/opens'))).items).toEqual([]);
    expect((await w.call(lena, 'GET', '/api/me/personal-space/opens')).status).toBe(403);
    expect((await w.call(null, 'GET', '/api/me/personal-space/opens')).status).toBe(401);
  });

  it('pages newest first', async () => {
    ok(await open(omar, nadia, 'second look'));
    ok(await open(omar, nadia, 'third look'));
    const first = ListPersonalSpaceOpensResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/personal-space/opens?limit=2')));
    expect(first.items.map((i) => i.reason)).toEqual(['third look', 'second look']);
    expect(first.nextCursor).not.toBeNull();
    const rest = ListPersonalSpaceOpensResponse.parse(ok(await w.call(nadia, 'GET', `/api/me/personal-space/opens?limit=2&before=${first.nextCursor}`)));
    expect(rest.items.map((i) => i.reason)).toEqual(['Nadia asked me to recover the Thursday note']);
    expect(rest.nextCursor).toBeNull();
  });
});

describe('the export', () => {
  it('is one zip with every folder (empty ones too) and each file\'s current content, and the event holds counts only', async () => {
    const res = await w.raw(omar, 'POST', `/api/people/${nadia.personId}/personal-space/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(String(res.headers.get('content-disposition'))).toMatch(/^attachment; filename="personal-space-[0-9a-f]{8}\.zip"$/);
    const entries = readZip(res.bytes);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['Notes/', 'Meetings/', 'Ideas/', 'Ideas/Empty/', 'Notes/private.md', 'Meetings/اجتماع.md']));
    expect(entries.find((e) => e.name === 'Notes/private.md')!.data.toString()).toBe('nadia private note');
    expect(entries.find((e) => e.name === 'Meetings/اجتماع.md')!.data.toString()).toBe('minutes');
    const events = await eventsOf('personal.space.exported');
    expect(events).toHaveLength(1);
    expect(parseEvent(eventToRaw(events[0]!))).toMatchObject({ personId: nadia.personId, adminActorId: omar.actorId, fileCount: 2, bytes: 18 + 7 });
    expect(JSON.stringify(events[0]!.payload)).not.toMatch(/private|Notes|اجتماع/);
  });

  it('a non-admin cannot export, and a file whose bytes are gone is listed in a note instead of failing the download', async () => {
    expect((await w.call(sameera, 'POST', `/api/people/${nadia.personId}/personal-space/export`)).status).toBe(403);
    const key = await w.system(async (tx) => (await tx.query<{ blob_key: string }>('SELECT blob_key FROM app.files WHERE id = $1', [noteId])).rows[0]!.blob_key);
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    rmSync(join(w.storageDir, key.slice(0, 2), key));
    const res = await w.raw(omar, 'POST', `/api/people/${nadia.personId}/personal-space/export`);
    expect(res.status).toBe(200);
    const entries = readZip(res.bytes);
    expect(entries.map((e) => e.name)).not.toContain('Notes/private.md');
    expect(entries.find((e) => e.name === 'MISSING-FILES.txt')!.data.toString()).toContain('Notes/private.md');
  });
});

describe('when the open ends', () => {
  it('the admin reads nothing again, and the person\'s list shows it as over', async () => {
    await expire();
    expect((await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree`)).status).toBe(403);
    expect((await w.call(omar, 'POST', `/api/people/${nadia.personId}/personal-space/export`)).status).toBe(403);
    expect((await w.raw(omar, 'GET', `/api/files/${noteId}/content`)).status).toBe(403);
    const mine = ListPersonalSpaceOpensResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/personal-space/opens')));
    expect(mine.items.every((i) => !i.active)).toBe(true);
  });

  it('a deactivated person\'s space can still be opened and read until it is deleted', async () => {
    await w.system((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [nadia.personId]));
    ok(await open(omar, nadia, 'before the sweep removes it'));
    const root = PersonFilesTreeResponse.parse(ok(await w.call(omar, 'GET', `/api/people/${nadia.personId}/files/tree`)));
    expect(root.entries.length).toBeGreaterThan(0);
    await w.system((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [nadia.personId]));
  });
});

describe('names in the export', () => {
  it('a folder called C: or a name with a colon cannot become a drive or a stream, and names that differ only in case do not overwrite each other', async () => {
    await w.uploadPersonal(sameera, 'C:/Windows', 'one', { name: 'evil.bat', type: 'text/plain' });
    await w.uploadPersonal(sameera, 'Notes', 'upper', { name: 'Plan.md', type: 'text/markdown' });
    await w.uploadPersonal(sameera, 'Notes', 'lower', { name: 'plan.md', type: 'text/markdown' });
    ok(await open(omar, sameera, 'checking the export names'));
    const res = await w.raw(omar, 'POST', `/api/people/${sameera.personId}/personal-space/export`);
    expect(res.status).toBe(200);
    const entries = readZip(res.bytes);
    const names = entries.map((e) => e.name);
    expect(names.filter((n) => n.includes(':'))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(['C_/', 'C_/Windows/', 'C_/Windows/evil.bat']));
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    const notes = entries.filter((e) => e.name.startsWith('Notes/') && !e.name.endsWith('/')).map((e) => e.data.toString()).sort();
    expect(notes).toEqual(['lower', 'upper']);
  });
});
