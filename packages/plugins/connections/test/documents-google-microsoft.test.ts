import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FOLDER } from '../../../test-utils/src/fake-providers-data.ts';
import { googleDrive } from '../src/documents/google-drive.ts';
import { oneDrive } from '../src/documents/onedrive.ts';
import { caught, drain, ids, OWNER, startRig, type Rig } from './documents-helpers.ts';

// Google Drive and OneDrive against the workspace stand-in of fake-saas (P16-08, WP-D1): a first pass lists everything, a pass with the cursor lists only what changed or
// was removed, sizes are cut, and an access answer that cannot be read is "not everyone". No database: the readers take their token from a function.

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
});
afterAll(async () => {
  await rig.stop();
});
beforeEach(() => {
  rig.saas.workspace.reset();
});

const ws = () => rig.saas.workspace;
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

for (const [name, adapter, provider] of [
  ['Google Drive', googleDrive, 'google'],
  ['OneDrive', oneDrive, 'microsoft'],
] as const) {
  describe(name, () => {
    const ctx = () => rig.ctx(provider);

    it('lists every readable file on the first pass (pictures are left out), then only what changed or was removed', async () => {
      const c = ctx();
      ws().putFile(OWNER, { id: 'folder-a', name: 'Plans', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
      ws().putFile(OWNER, { id: 'file-inside', name: 'inside.md', mimeType: 'text/markdown', modified: '2026-10-01T00:00:00.000Z', text: '# inside', parentId: 'folder-a' });
      const first = await drain(adapter, c, 'root');
      expect(ids(first.items)).toEqual(['file-budget', 'file-inside', 'file-notes', 'file-roadmap']);
      expect(first.items.find((i) => i.remoteId === 'file-inside')).toMatchObject({ name: 'inside.md', kind: 'md', removed: false });
      expect(first.items.every((i) => i.version !== '' && !i.removed)).toBe(true);

      const quiet = await drain(adapter, c, 'root', first.cursor);
      expect(quiet.items).toEqual([]);

      ws().putFile(OWNER, { id: 'file-notes', name: 'Customer call notes.txt', mimeType: 'text/plain', modified: '2026-11-01T00:00:00.000Z', text: 'edited' });
      ws().putFile(OWNER, { id: 'file-new', name: 'New.txt', mimeType: 'text/plain', modified: '2026-11-01T00:00:00.000Z', text: 'new' });
      ws().trashFile(OWNER, 'file-budget');
      ws().removeFile(OWNER, 'file-roadmap');
      const second = await drain(adapter, c, 'root', quiet.cursor);
      expect(ids(second.items)).toEqual(['-file-budget', '-file-roadmap', 'file-new', 'file-notes']);
      const before = first.items.find((i) => i.remoteId === 'file-notes')!;
      expect(second.items.find((i) => i.remoteId === 'file-notes')!.version).not.toBe(before.version);

      const third = await drain(adapter, c, 'root', second.cursor);
      expect(third.items).toEqual([]);
    });

    it('a pass that stops part-way resumes from its cursor and reaches the same end', async () => {
      const c = ctx();
      ws().putFile(OWNER, { id: 'folder-a', name: 'Plans', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
      ws().putFile(OWNER, { id: 'file-inside', name: 'inside.md', mimeType: 'text/markdown', modified: '2026-10-01T00:00:00.000Z', text: '# inside', parentId: 'folder-a' });
      const whole = await drain(adapter, c, 'root');
      // the same pass, taken one call at a time with a new reader context each time (nothing is kept between calls but the cursor)
      const seen: string[] = [];
      let cursor: string | null = null;
      let last = '';
      for (let i = 0; i < 20; i++) {
        const page: Awaited<ReturnType<typeof adapter.listChanges>> = await adapter.listChanges(ctx(), { root: 'root', cursor });
        seen.push(...page.items.map((x) => x.remoteId));
        last = page.cursor;
        if (page.next === null) break;
        cursor = page.next;
      }
      expect(seen.sort()).toEqual(ids(whole.items));
      expect((await drain(adapter, ctx(), 'root', last)).items).toEqual([]);
    });

    it('a folder root keeps to that folder', async () => {
      const c = ctx();
      ws().putFile(OWNER, { id: 'folder-a', name: 'Plans', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
      ws().putFile(OWNER, { id: 'folder-b', name: 'Deep', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '', parentId: 'folder-a' });
      ws().putFile(OWNER, { id: 'file-inside', name: 'inside.md', mimeType: 'text/markdown', modified: '2026-10-01T00:00:00.000Z', text: '# inside', parentId: 'folder-a' });
      ws().putFile(OWNER, { id: 'file-deep', name: 'deep.txt', mimeType: 'text/plain', modified: '2026-10-01T00:00:00.000Z', text: 'deep', parentId: 'folder-b' });
      const first = await drain(adapter, c, 'folder-a');
      expect(ids(first.items)).toEqual(['file-deep', 'file-inside']);
      // an edit outside the folder is not reported; one inside, at any depth, is
      ws().putFile(OWNER, { id: 'file-notes', name: 'Customer call notes.txt', mimeType: 'text/plain', modified: '2026-11-01T00:00:00.000Z', text: 'edited outside' });
      ws().putFile(OWNER, { id: 'file-deep', name: 'deep.txt', mimeType: 'text/plain', modified: '2026-11-01T00:00:00.000Z', text: 'deeper', parentId: 'folder-b' });
      const second = await drain(adapter, c, 'folder-a', first.cursor);
      expect(ids(second.items)).toEqual(['file-deep']);
    });

    it('a cursor that is not ours, or no longer valid at the service, means a full listing', async () => {
      const c = ctx();
      const garbage = await drain(adapter, c, 'root', 'not-a-cursor');
      expect(ids(garbage.items)).toEqual(['file-budget', 'file-notes', 'file-roadmap']);
      // a well-formed cursor whose point the service no longer knows
      const stale = Buffer.from(JSON.stringify(provider === 'google' ? { k: 'chg', t: '99999' } : { k: 'delta', p: '/me/drive/root/delta?token=99999' })).toString('base64url');
      const again = await drain(adapter, c, 'root', `v1.${stale}`);
      expect(ids(again.items)).toEqual(['file-budget', 'file-notes', 'file-roadmap']);
    });

    it('fetches a file, cuts a long text at 10 MB and refuses a long binary file', async () => {
      const c = ctx();
      const note = await adapter.fetch(c, 'file-notes');
      expect(note.kind).toBe('text');
      expect(text(note.bytes)).toContain('Harbour Grain');
      const road = await adapter.fetch(c, 'file-roadmap');
      expect(text(road.bytes)).toContain('Lantern');
      if (provider === 'google') {
        const sheet = await adapter.fetch(c, 'file-budget');
        expect(sheet.kind).toBe('csv');
        expect(text(sheet.bytes)).toContain('servers,420');
      }
      ws().putFile(OWNER, { id: 'big-text', name: 'big.txt', mimeType: 'text/plain', modified: '2026-11-01T00:00:00.000Z', text: 'a'.repeat(11 * 1024 * 1024) });
      const big = await adapter.fetch(c, 'big-text');
      expect(big.bytes.length).toBe(10 * 1024 * 1024);
      ws().putFile(OWNER, { id: 'big-pdf', name: 'big.pdf', mimeType: 'application/pdf', modified: '2026-11-01T00:00:00.000Z', text: 'a'.repeat(11 * 1024 * 1024) });
      expect((await caught(() => adapter.fetch(c, 'big-pdf')))?.code).toBe('not_found');
      expect((await caught(() => adapter.fetch(c, 'file-photo')))?.code).toBe('not_found');
      expect((await caught(() => adapter.fetch(c, 'no-such-file')))?.code).toBe('not_found');
      expect((await caught(() => adapter.fetch(c, '../etc/passwd')))?.code).toBe('not_found');
    });

    it('says who may open a file, and anything it cannot read is "not everyone"', async () => {
      const c = ctx();
      const only = await adapter.access(c, 'file-notes');
      expect(only).toEqual({ anyone: false, domains: [], users: [OWNER], groups: false });

      ws().setFilePermissions(OWNER, 'file-notes', [{ type: 'anyone' }]);
      expect(await adapter.access(c, 'file-notes')).toMatchObject({ anyone: true, groups: false });

      ws().setFilePermissions(OWNER, 'file-notes', [{ type: 'domain', domain: 'kahf.example' }, { type: 'user', email: 'Lena@Kahf.example' }]);
      const shared = await adapter.access(c, 'file-notes');
      expect(shared.anyone).toBe(false);
      expect(shared.groups).toBe(false);
      expect(shared.users).toEqual(expect.arrayContaining([OWNER, 'lena@kahf.example']));
      expect(shared.domains).toEqual(['kahf.example']);

      ws().setFilePermissions(OWNER, 'file-notes', [{ type: 'group', email: 'eng@kahf.example' }]);
      expect((await adapter.access(c, 'file-notes')).groups).toBe(true);

      // gone, or an id that is not one of ours: unreadable, so "not everyone"
      expect(await adapter.access(c, 'no-such-file')).toEqual({ anyone: false, domains: [], users: [], groups: true });
      expect(await adapter.access(c, '../x')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    });

    // The real services answer a reader who may not see the sharing list with a refusal or with no list at all, and a long list in pages: none of these may read as "shared with the team".
    // The stand-in always answers with the full list, so the three shapes are put in front of the reader here.
    it('a refusal, an answer without a list and a list that goes on are all "not everyone" (the stand-in is kinder than the services)', async () => {
      const entry = provider === 'google' ? { type: 'domain', domain: 'kahf.example' } : { link: { scope: 'anonymous' } };
      const listKey = provider === 'google' ? 'permissions' : 'value';
      const nextKey = provider === 'google' ? 'nextPageToken' : '@odata.nextLink';
      const answering = (status: number, body: unknown) => async (url: string, init: Parameters<typeof fetch>[1]): Promise<Response> =>
        /\/permissions/.test(url) ? new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) : fetch(url, init);
      const notEveryone = { anyone: false, domains: [], users: [], groups: true };

      // 403: the person who connected may read the file but not who it is shared with
      const refused = rig.ctx(provider, { fetchImpl: answering(403, { error: { code: 403, message: 'The user does not have sufficient permissions for this file.' } }) });
      expect(await adapter.access(refused, 'file-notes')).toEqual(notEveryone);
      // 200 with no list at all
      const bare = rig.ctx(provider, { fetchImpl: answering(200, {}) });
      expect(await adapter.access(bare, 'file-notes')).toEqual(notEveryone);
      // a list that never ends: what was seen (a whole domain, or a public link) is not trusted to be all of it, so the answer carries "a group" too
      const endless = rig.ctx(provider, { fetchImpl: answering(200, { [listKey]: [entry], [nextKey]: 'more' }) });
      const long = await adapter.access(endless, 'file-notes');
      expect(long.groups).toBe(true);
    });

    it('a dead sign-in or a service that is down is an error, not an answer; no message carries the token', async () => {
      const c = ctx();
      ws().failNextApi(500, 1);
      const down = await caught(() => adapter.access(c, 'file-notes'));
      expect(down?.code).toBe('provider_down');
      const gone = await caught(() => adapter.listChanges(rig.ctx(provider, { token: 'a-token-nobody-issued' }), { root: 'root', cursor: null }));
      expect(gone?.code).toBe('not_connected');
      ws().failNextApi(500, 3);
      const listing = await caught(() => adapter.listChanges(c, { root: 'root', cursor: null }));
      for (const err of [down, gone, listing]) {
        expect(err?.message).not.toContain(c.token);
        expect(err?.message).not.toContain('a-token-nobody-issued');
        expect(err?.message).not.toContain('forced failure');
      }
    });
  });
}

describe('Google Drive roots and Google documents', () => {
  it('offers My Drive and the top folders', async () => {
    ws().putFile(OWNER, { id: 'folder-a', name: 'Plans', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
    const roots = await googleDrive.listRoots(rig.ctx('google'));
    expect(roots.map((r) => r.id)).toEqual(['root', 'folder-a']);
    expect(roots[0]).toMatchObject({ name: 'My Drive', kind: 'folder', parent: null });
    expect(roots[1]).toMatchObject({ name: 'Plans', parent: 'My Drive' });
  });

  it('reads Docs as text and Sheets as CSV by their export, and reports their kinds in the list', async () => {
    const first = await drain(googleDrive, rig.ctx('google'), 'root');
    expect(first.items.find((i) => i.remoteId === 'file-roadmap')!.kind).toBe('text');
    expect(first.items.find((i) => i.remoteId === 'file-budget')!.kind).toBe('csv');
  });
});

describe('OneDrive roots', () => {
  it('offers the whole drive and its top folders', async () => {
    ws().putFile(OWNER, { id: 'folder-a', name: 'Plans', mimeType: FOLDER, modified: '2026-10-01T00:00:00.000Z', text: '' });
    const roots = await oneDrive.listRoots(rig.ctx('microsoft'));
    expect(roots.map((r) => r.id)).toEqual(['root', 'folder-a']);
    expect(roots[0]).toMatchObject({ name: 'OneDrive', kind: 'drive' });
  });

  it('a share to another domain that Graph cannot name is not read as the owner\'s domain; an organisation link is', async () => {
    const c = rig.ctx('microsoft');
    ws().setFilePermissions(OWNER, 'file-notes', [{ type: 'domain', domain: 'kahf.example' }]);
    expect(await oneDrive.access(c, 'file-notes')).toMatchObject({ domains: ['kahf.example'], groups: false });
    ws().setFilePermissions(OWNER, 'file-notes', [{ type: 'domain', domain: 'other.example' }]);
    expect((await oneDrive.access(c, 'file-notes')).domains).toEqual([]);
  });
});
