import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  GetFilesTreeResponse,
  ListPersonalFileVersionsResponse,
  PERSONAL_SEED_FOLDERS,
  PersonalFile,
  PersonalFilesUsage,
} from '@manythreads/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type FilesWorld } from './world.ts';

// P20-02: a person's Personal files through the HTTP API: the starting folders, upload, versions and restore, rename and move, the allowance, and
// who can and cannot reach the bytes. (Row level security itself is proved in rls/personal.test.ts.)

const { omar, nadia, sameera, lena } = personas;

let w: FilesWorld;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});
afterEach(() => {
  delete process.env['MANYTHREADS_PERSONAL_QUOTA_BYTES'];
  delete process.env['MANYTHREADS_MAX_UPLOAD_BYTES'];
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [p.slice(base.length + 1)];
  });
const blobs = (): string[] => (existsSync(w.storageDir) ? walk(w.storageDir).filter((p) => !p.startsWith('.tmp')) : []);
const put = async (who: typeof nadia, folder: string, body: string, name: string, conflict?: 'rename' | 'version'): Promise<PersonalFile> =>
  PersonalFile.parse(ok(await w.uploadPersonal(who, folder, body, { name, type: 'text/markdown', ...(conflict ? { conflict } : {}) }), conflict === 'version' ? 200 : 201));
const text = async (who: typeof nadia, path: string): Promise<string> => {
  const r = await w.raw(who, 'GET', path);
  expect(r.status).toBe(200);
  return r.bytes.toString();
};

describe('the tree', () => {
  it('starts with the seven folders, made on first read, with Memory marked as managed', async () => {
    const tree = GetFilesTreeResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/files/tree')));
    expect(tree.entries.map((e) => e.name)).toEqual([...PERSONAL_SEED_FOLDERS].sort());
    expect(tree.entries.every((e) => e.kind === 'folder' && e.source === 'attachment' && !e.readOnly)).toBe(true);
    expect(tree.entries.find((e) => e.name === 'Memory')?.managedBy).toBe('personal_memory');
    const again = GetFilesTreeResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/files/tree')));
    expect(again.entries).toHaveLength(7);
  });

  it('a folder that does not exist is 404', async () => {
    expect((await w.call(nadia, 'GET', '/api/me/files/tree?path=Nowhere')).status).toBe(404);
  });

  it('lists a folder\'s files with their ids and where to read them', async () => {
    const f = await put(nadia, 'Notes', '# plan', 'plan.md');
    const tree = GetFilesTreeResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/files/tree?path=Notes')));
    const entry = tree.entries.find((e) => e.name === 'plan.md');
    expect(entry).toMatchObject({ kind: 'file', path: 'Notes/plan.md', fileId: f.id, channelId: null, contentUrl: `/api/files/${f.id}/content`, size: 6 });
  });
});

describe('upload, download, rename, delete', () => {
  it('stores a file, gives metadata without a blob key, serves the bytes to its owner only', async () => {
    const f = await put(nadia, 'Notes', 'my private note', 'secret.md');
    expect(f).toMatchObject({ folderPath: 'Notes', name: 'secret.md', path: 'Notes/secret.md', ownerPersonId: nadia.personId, versionCount: 0, space: `person:${nadia.personId}` });
    expect(f).not.toHaveProperty('blobKey');
    expect(await text(nadia, f.contentUrl)).toBe('my private note');
    // Another member, an admin without an open, a guest and a stranger get the same refusal as for a file that does not exist.
    for (const who of [sameera, omar, lena, null]) {
      expect((await w.raw(who, 'GET', f.contentUrl)).status, who?.personId ?? 'anonymous').toBeGreaterThanOrEqual(401);
      expect((await w.raw(who, 'GET', `/api/files/${f.id}`)).status, who?.personId ?? 'anonymous').toBeGreaterThanOrEqual(401);
    }
  });

  it('a second file with the same name gets a numbered name; into a folder that does not exist makes it', async () => {
    await put(nadia, 'Notes', 'a', 'dup.md');
    const second = await put(nadia, 'Notes', 'b', 'dup.md');
    expect(second.name).toBe('dup (2).md');
    const deep = await put(nadia, 'Projects/2026/Q4', 'x', 'goal.md');
    expect(deep.folderPath).toBe('Projects/2026/Q4');
    const root = GetFilesTreeResponse.parse(ok(await w.call(nadia, 'GET', '/api/me/files/tree')));
    expect(root.entries.map((e) => e.name)).toContain('Projects');
  });

  it('refuses a folder that climbs out, and a file at the root', async () => {
    expect((await w.uploadPersonal(nadia, '../etc', 'x', { name: 'a.md' })).status).toBe(400);
    expect((await w.uploadPersonal(nadia, '', 'x', { name: 'a.md' })).status).toBe(400);
  });

  it('renames and moves; a clash is 409; a file of someone else is 403', async () => {
    const f = await put(nadia, 'Notes', 'move me', 'move.md');
    const other = await put(nadia, 'Meetings', 'x', 'move.md');
    const renamed = PersonalFile.parse(ok(await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'moved.md' })));
    expect(renamed).toMatchObject({ name: 'moved.md', path: 'Notes/moved.md' });
    expect((await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'move.md', folderPath: 'Meetings' })).status).toBe(409);
    expect(other.name).toBe('move.md');
    const moved = PersonalFile.parse(ok(await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { folderPath: 'Inbox' })));
    expect(moved.path).toBe('Inbox/moved.md');
    expect(await text(nadia, `/api/files/${f.id}/content`)).toBe('move me');
    expect((await w.call(sameera, 'PATCH', `/api/me/files/${f.id}`, { name: 'mine.md' })).status).toBe(403);
    expect((await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'x', owner: 'y' })).status).toBe(400);
  });

  it('delete removes the row, every version and the bytes', async () => {
    const before = blobs().length;
    const f = await put(nadia, 'Notes', 'v1', 'gone.md');
    await put(nadia, 'Notes', 'v2', 'gone.md', 'version');
    await put(nadia, 'Notes', 'v3', 'gone.md', 'version');
    expect(blobs().length).toBe(before + 3);
    expect((await w.call(sameera, 'DELETE', `/api/me/files/${f.id}`)).status).toBe(403);
    expect(ok<{ deleted: boolean }>(await w.call(nadia, 'DELETE', `/api/me/files/${f.id}`)).deleted).toBe(true);
    expect(blobs().length).toBe(before);
    expect((await w.raw(nadia, 'GET', `/api/files/${f.id}/content`)).status).toBe(403);
    expect(await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.file_versions WHERE file_id = $1', [f.id])).rows.length)).toBe(0);
  });
});

describe('the channel delete route and a Personal file', () => {
  it('refuses a Personal file, so no version bytes are left behind and no team-style delete event is written', async () => {
    const f = await put(nadia, 'Notes', 'v1', 'keep.md');
    await put(nadia, 'Notes', 'v2', 'keep.md', 'version');
    const before = blobs().length;
    const deleted = async (): Promise<number> =>
      w.system(async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.events WHERE type = 'files.file.deleted' AND payload->>'fileId' = $1", [f.id])).rows[0]!.n));
    expect((await w.call(nadia, 'DELETE', `/api/files/${f.id}`)).status).toBe(409);
    expect((await w.call(sameera, 'DELETE', `/api/files/${f.id}`)).status).toBe(403);
    expect(blobs().length).toBe(before);
    expect(await deleted()).toBe(0);
    expect(await text(nadia, `/api/files/${f.id}/content`)).toBe('v2');
    // The Personal route is the way, and it tags the event with the space.
    expect(ok<{ deleted: boolean }>(await w.call(nadia, 'DELETE', `/api/me/files/${f.id}`)).deleted).toBe(true);
    expect(await deleted()).toBe(1);
    expect(blobs().length).toBe(before - 2);
  });
});

describe('versions', () => {
  it('saving over a name keeps the old content; restore brings it back and keeps the replaced one', async () => {
    const f = await put(nadia, 'Notes', 'first', 'story.md');
    const saved = await put(nadia, 'Notes', 'second', 'story.md', 'version');
    expect(saved.id).toBe(f.id);
    expect(saved.versionCount).toBe(1);
    await put(nadia, 'Notes', 'third', 'story.md', 'version');
    const list = ListPersonalFileVersionsResponse.parse(ok(await w.call(nadia, 'GET', `/api/me/files/${f.id}/versions`)));
    expect(list.items.map((v) => v.current)).toEqual([true, false, false]);
    expect(list.items[1]!.size).toBe('second'.length);
    expect(await text(nadia, list.items[2]!.contentUrl)).toBe('first');
    const restored = PersonalFile.parse(ok(await w.call(nadia, 'POST', `/api/me/files/${f.id}/versions/${list.items[2]!.id}/restore`)));
    expect(restored.versionCount).toBe(3);
    expect(restored.size).toBe('first'.length);
    expect(await text(nadia, `/api/files/${f.id}/content`)).toBe('first');
    const after = ListPersonalFileVersionsResponse.parse(ok(await w.call(nadia, 'GET', `/api/me/files/${f.id}/versions`)));
    // the replaced content ('third') is a version now, and the restored version is still listed
    expect(after.items).toHaveLength(4);
    const contents = await Promise.all(after.items.map((v) => text(nadia, v.contentUrl)));
    expect(contents).toEqual(['first', 'third', 'second', 'first']);
  });

  it('the same bytes saved again add no version', async () => {
    const f = await put(nadia, 'Notes', 'same', 'steady.md');
    const again = await put(nadia, 'Notes', 'same', 'steady.md', 'version');
    expect(again.id).toBe(f.id);
    expect(again.versionCount).toBe(0);
  });

  it('only the owner reaches versions; an unknown version is 404', async () => {
    const f = await put(nadia, 'Notes', 'a', 'priv.md');
    await put(nadia, 'Notes', 'b', 'priv.md', 'version');
    const list = ListPersonalFileVersionsResponse.parse(ok(await w.call(nadia, 'GET', `/api/me/files/${f.id}/versions`)));
    const vid = list.items[1]!.id!;
    expect((await w.call(sameera, 'GET', `/api/me/files/${f.id}/versions`)).status).toBe(403);
    expect((await w.raw(omar, 'GET', `/api/me/files/${f.id}/versions/${vid}/content`)).status).toBe(403);
    expect((await w.call(nadia, 'POST', `/api/me/files/${f.id}/versions/${f.id}/restore`)).status).toBe(404);
  });
});

describe('the allowance', () => {
  it('counts files and versions, and refuses an upload that does not fit with a plain 413', async () => {
    process.env['MANYTHREADS_PERSONAL_QUOTA_BYTES'] = '100';
    const usage0 = PersonalFilesUsage.parse(ok(await w.call(sameera, 'GET', '/api/me/files/usage')));
    expect(usage0).toMatchObject({ usedBytes: 0, quotaBytes: 100, fileCount: 0 });
    await put(sameera, 'Notes', 'x'.repeat(60), 'a.md');
    const res = await w.uploadPersonal(sameera, 'Notes', 'y'.repeat(60), { name: 'b.md' });
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/Personal space/);
    // a save over the same name keeps the old content as a version, so it counts twice
    const over = await w.uploadPersonal(sameera, 'Notes', 'z'.repeat(60), { name: 'a.md', conflict: 'version' });
    expect(over.status).toBe(413);
    expect(PersonalFilesUsage.parse(ok(await w.call(sameera, 'GET', '/api/me/files/usage')))).toMatchObject({ usedBytes: 60, fileCount: 1 });
    // a refused upload leaves no bytes behind
    const files = await w.system(async (tx) => (await tx.query<{ n: string }>('SELECT count(*) AS n FROM app.files WHERE owner_person_id = $1', [sameera.personId])).rows[0]!.n);
    expect(Number(files)).toBe(1);
  });
});

describe('who has a Personal space', () => {
  it('a guest gets 403 on every route; nobody signed in gets 401', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/api/me/files/tree'],
      ['GET', '/api/me/files/usage'],
      ['POST', '/api/me/files/folders', { path: 'Mine' }],
      ['GET', `/api/me/files/${nadia.actorId}/versions`],
    ];
    for (const [m, p, b] of calls) {
      expect((await w.call(lena, m, p, b)).status, `${m} ${p}`).toBe(403);
      expect((await w.call(null, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
    expect((await w.uploadPersonal(lena, 'Notes', 'x', { name: 'a.md' })).status).toBe(403);
  });
});

describe('folders', () => {
  it('makes a folder, will not remove a starting one or one with content, removes an empty one', async () => {
    expect(ok<{ path: string }>(await w.call(nadia, 'POST', '/api/me/files/folders', { path: 'Ideas/Drafts' })).path).toBe('Ideas/Drafts');
    expect((await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Notes')).status).toBe(409);
    expect((await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Ideas')).status).toBe(409);
    expect(ok<{ deleted: boolean }>(await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Ideas/Drafts')).deleted).toBe(true);
    expect(ok<{ deleted: boolean }>(await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Ideas')).deleted).toBe(true);
    await put(nadia, 'Keep/Inside', 'x', 'k.md');
    expect((await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Keep')).status).toBe(409);
    expect((await w.call(nadia, 'DELETE', '/api/me/files/folders?path=Nope')).status).toBe(404);
  });
});
