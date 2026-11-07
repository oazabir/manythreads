import { GetFilesTreeResponse, ListPersonalFileVersionsResponse, PersonalFile } from '@manythreads/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, personas, type ApiResult, type FilesWorld } from './world.ts';

// P20-T1: edges of the Personal files routes that personal.test.ts does not reach: how a name arrives and is cleaned, what a rename or a move does when
// nothing changes or the target is new, the tree's limit and the Memory marker, how the bytes are served (never as a page), parallel uploads of one
// name, a restore that does not fit the allowance, and a deactivated person.

const { nadia, sameera, tariq } = personas;

let w: FilesWorld;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});
afterEach(() => {
  delete process.env['MANYTHREADS_PERSONAL_QUOTA_BYTES'];
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const put = async (who: typeof nadia, folder: string, body: string | Uint8Array, name: string, opts: { type?: string; conflict?: 'rename' | 'version' } = {}): Promise<PersonalFile> =>
  PersonalFile.parse(ok(await w.uploadPersonal(who, folder, body, { name, type: opts.type ?? 'text/markdown', ...(opts.conflict ? { conflict: opts.conflict } : {}) }), opts.conflict === 'version' ? undefined : 201));
const tree = async (who: typeof nadia, path = '', extra = ''): Promise<GetFilesTreeResponse> =>
  GetFilesTreeResponse.parse(ok(await w.call(who, 'GET', `/api/me/files/tree?path=${encodeURIComponent(path)}${extra}`)));

describe('how a name arrives', () => {
  it('takes the name from the query when no header is sent, and the header wins when both are', async () => {
    const asActor = { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }) };
    const viaQuery = await fetch(`${w.server.url}/api/me/files?folderPath=Notes&name=${encodeURIComponent('from query.md')}`, { method: 'POST', headers: { ...asActor, 'content-type': 'text/markdown' }, body: 'q' });
    expect(viaQuery.status).toBe(201);
    expect(PersonalFile.parse(await viaQuery.json()).name).toBe('from query.md');
    const both = await fetch(`${w.server.url}/api/me/files?folderPath=Notes&name=ignored.md`, {
      method: 'POST',
      headers: { ...asActor, 'content-type': 'text/markdown', 'x-file-name': encodeURIComponent('from header.md') },
      body: 'h',
    });
    expect(PersonalFile.parse(await both.json()).name).toBe('from header.md');
  });

  it('stores a percent-encoded non-Latin name as written', async () => {
    const f = await put(nadia, 'Notes', 'x', 'خطة الإطلاق.md');
    expect(f.name).toBe('خطة الإطلاق.md');
    expect((await tree(nadia, 'Notes')).entries.map((e) => e.name)).toContain('خطة الإطلاق.md');
  });

  it('keeps only the last segment of a name that looks like a path, and cleans characters other systems refuse', async () => {
    const f = await put(nadia, 'Notes', 'x', '..\\..\\evil:name?.md');
    expect(f.name).toBe('evil_name_.md');
    expect(f.folderPath).toBe('Notes');
  });

  it('a name that cleans down to nothing becomes "file"', async () => {
    expect((await put(nadia, 'Meetings', 'x', '...')).name).toBe('file');
  });
});

describe('rename and move', () => {
  it('changing nothing answers 200 and leaves the file as it was', async () => {
    const f = await put(nadia, 'Notes', 'same', 'steady-name.md');
    const again = PersonalFile.parse(ok(await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'steady-name.md', folderPath: 'Notes' })));
    expect(again).toEqual(f);
  });

  it('a new name with a slash in it is cleaned to its last segment, not turned into a folder', async () => {
    const f = await put(nadia, 'Notes', 'x', 'slash-me.md');
    const renamed = PersonalFile.parse(ok(await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'Elsewhere/slashed.md' })));
    expect(renamed).toMatchObject({ name: 'slashed.md', folderPath: 'Notes', path: 'Notes/slashed.md' });
    expect((await tree(nadia, '')).entries.map((e) => e.name)).not.toContain('Elsewhere');
  });

  it('moving to a folder that does not exist yet makes it, parents included, and the tree shows it', async () => {
    const f = await put(nadia, 'Notes', 'x', 'wanderer.md');
    const moved = PersonalFile.parse(ok(await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { folderPath: 'Trips/2027/Lisbon' })));
    expect(moved.path).toBe('Trips/2027/Lisbon/wanderer.md');
    expect((await tree(nadia, 'Trips')).entries.map((e) => e.path)).toEqual(['Trips/2027']);
    expect((await tree(nadia, 'Trips/2027/Lisbon')).entries.map((e) => e.path)).toEqual(['Trips/2027/Lisbon/wanderer.md']);
    expect((await tree(nadia, 'Notes')).entries.map((e) => e.name)).not.toContain('wanderer.md');
  });

  it('an empty folder path or an empty body is a 400, and a deleted file is gone for the rename too', async () => {
    const f = await put(nadia, 'Notes', 'x', 'bad-patch.md');
    expect((await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { folderPath: '' })).status).toBe(400);
    expect((await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, {})).status).toBe(400);
    ok(await w.call(nadia, 'DELETE', `/api/me/files/${f.id}`));
    expect((await w.call(nadia, 'PATCH', `/api/me/files/${f.id}`, { name: 'back.md' })).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/me/files/${f.id}`)).status).toBe(403);
    expect((await w.call(nadia, 'GET', `/api/me/files/${f.id}/versions`)).status).toBe(403);
  });
});

describe('the tree', () => {
  it('lists a folder\'s files in name order, folders before files, and says when the limit cut the list', async () => {
    for (const n of ['c.md', 'a.md', 'b.md']) await put(tariq, 'Notes', n, n);
    await w.call(tariq, 'POST', '/api/me/files/folders', { path: 'Notes/Sub' });
    const all = await tree(tariq, 'Notes');
    expect(all.entries.map((e) => `${e.kind}:${e.name}`)).toEqual(['folder:Sub', 'file:a.md', 'file:b.md', 'file:c.md']);
    expect(all.truncated).toBe(false);
    const cut = await tree(tariq, 'Notes', '&limit=2');
    expect(cut.entries).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });

  it('marks Memory and every folder below it as kept by the person\'s memory, and no other folder', async () => {
    await w.call(nadia, 'POST', '/api/me/files/folders', { path: 'Memory/People' });
    const memory = await tree(nadia, 'Memory');
    expect(memory.folder.managedBy).toBe('personal_memory');
    expect(memory.entries.find((e) => e.name === 'People')?.managedBy).toBe('personal_memory');
    expect((await tree(nadia, 'Notes')).folder.managedBy).toBeNull();
    const root = await tree(nadia, '');
    expect(root.entries.find((e) => e.name === 'Memory')?.managedBy).toBe('personal_memory');
    expect(root.entries.find((e) => e.name === 'Notes')?.managedBy).toBeNull();
  });

  it('a path that is not a folder of the caller is 404 even when someone else has it', async () => {
    await w.call(sameera, 'POST', '/api/me/files/folders', { path: 'OnlySameera' });
    expect((await w.call(nadia, 'GET', '/api/me/files/tree?path=OnlySameera')).status).toBe(404);
    expect((await tree(sameera, 'OnlySameera')).path).toBe('OnlySameera');
  });
});

describe('how the bytes are served', () => {
  it('a page is served as opaque bytes that cannot run, and ?download=1 forces a download', async () => {
    const f = await put(nadia, 'Notes', '<script>alert(1)</script>', 'trap.html', { type: 'text/html' });
    const shown = await w.raw(nadia, 'GET', f.contentUrl);
    expect(shown.status).toBe(200);
    expect(shown.headers.get('content-type')).not.toMatch(/html/);
    expect(shown.headers.get('x-content-type-options')).toBe('nosniff');
    expect(shown.headers.get('content-security-policy')).toContain('sandbox');
    expect(shown.headers.get('content-disposition')).toMatch(/^attachment/);
    // only an image whose first bytes confirm its type is shown inline; a note downloads, and ?download=1 makes an image download too
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    const pic = await put(nadia, 'Notes', png, 'picture.png', { type: 'image/png' });
    const inline = await w.raw(nadia, 'GET', pic.contentUrl);
    expect(inline.headers.get('content-type')).toBe('image/png');
    expect(inline.headers.get('content-disposition')).toMatch(/^inline/);
    const forced = await w.raw(nadia, 'GET', `${pic.contentUrl}?download=1`);
    expect(forced.headers.get('content-disposition')).toMatch(/^attachment; filename="picture\.png"/);
    expect(forced.headers.get('cache-control')).toBe('private, no-cache');
    const note = await put(nadia, 'Notes', '# hi', 'readable.md');
    expect((await w.raw(nadia, 'GET', note.contentUrl)).headers.get('content-disposition')).toMatch(/^attachment/);
  });

  it('an old version downloads with the file\'s name, and only as an attachment when asked', async () => {
    const f = await put(nadia, 'Notes', 'one', 'versioned-name.md');
    await put(nadia, 'Notes', 'two', 'versioned-name.md', { conflict: 'version' });
    const list = ListPersonalFileVersionsResponse.parse(ok(await w.call(nadia, 'GET', `/api/me/files/${f.id}/versions`)));
    const old = list.items[1]!;
    const res = await w.raw(nadia, 'GET', `${old.contentUrl}?download=1`);
    expect(res.status).toBe(200);
    expect(res.bytes.toString()).toBe('one');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="versioned-name\.md"/);
  });
});

describe('uploads that arrive together and the allowance', () => {
  it('two uploads of one name at the same moment (the most one person may send) both land, each under its own name', async () => {
    const results = await Promise.all(Array.from({ length: 2 }, (_, i) => w.uploadPersonal(tariq, 'Inbox', `body ${i}`, { name: 'race.md', type: 'text/markdown' })));
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const names = results.map((r) => PersonalFile.parse(r.body).name).sort();
    expect(names).toEqual(['race (2).md', 'race.md']);
    expect(new Set(names).size).toBe(2);
  });

  it('a restore that would not fit is 413 and changes nothing', async () => {
    const f = await put(sameera, 'Notes', 'a'.repeat(40), 'tight.md');
    await put(sameera, 'Notes', 'b'.repeat(30), 'tight.md', { conflict: 'version' });
    const list = ListPersonalFileVersionsResponse.parse(ok(await w.call(sameera, 'GET', `/api/me/files/${f.id}/versions`)));
    const versionId = list.items[1]!.id!;
    // the file (30) and its one version (40) fill 70 of 80 bytes; restoring puts 40 more on the shelf
    process.env['MANYTHREADS_PERSONAL_QUOTA_BYTES'] = '80';
    const res = await w.call(sameera, 'POST', `/api/me/files/${f.id}/versions/${versionId}/restore`);
    expect(res.status).toBe(413);
    expect(JSON.stringify(res.body)).toMatch(/Personal space/);
    expect((await w.raw(sameera, 'GET', f.contentUrl)).bytes.toString()).toBe('b'.repeat(30));
    const after = ListPersonalFileVersionsResponse.parse(ok(await w.call(sameera, 'GET', `/api/me/files/${f.id}/versions`)));
    expect(after.items).toHaveLength(2);
  });
});

describe('a deactivated person', () => {
  it('reaches nothing under /api/me/files while deactivated, and everything again after', async () => {
    const f = await put(tariq, 'Notes', 'mine', 'kept-while-away.md');
    await w.system((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [tariq.personId]));
    try {
      for (const path of ['/api/me/files/tree', '/api/me/files/usage', `/api/me/files/${f.id}/versions`]) {
        expect([401, 403, 404], path).toContain((await w.call(tariq, 'GET', path)).status);
      }
      expect([401, 403, 404]).toContain((await w.uploadPersonal(tariq, 'Notes', 'x', { name: 'late.md' })).status);
    } finally {
      await w.system((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [tariq.personId]));
    }
    expect((await w.call(tariq, 'GET', '/api/me/files/usage')).status).toBe(200);
    expect((await w.raw(tariq, 'GET', f.contentUrl)).bytes.toString()).toBe('mine');
  });
});
