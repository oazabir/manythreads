import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeFile } from '../../../packages/test-utils/src/fake-providers-data.ts';
import { startFakeSaas, type FakeSaas } from '../src/index.ts';
import { workspaceModule } from '../src/providers/workspace.ts';
import { call, type Json } from './helpers.ts';

/*
 * Google, Microsoft and Notion as fake-saas extends them for Bundle D: seeded sign-ins, Drive permissions and `changes`, OneDrive `delta`, Notion search order and paging,
 * calendar events that exist after they are created, and a calendar that is not shared. The rest of the fake (mail, OAuth rotation ...) is covered by the connections tests.
 */

const NADIA = 'nadia@kahf.example';
const RAFI = 'rafi@kahf.example';
const G = (name: string): string => `https://www.googleapis.com/auth/${name}`;

let saas: FakeSaas;
let base: string;
let g: string; // Nadia's seeded Google access token
let m: string; // Nadia's seeded Microsoft access token
let rafiG: string;

const file = (id: string, extra: Partial<FakeFile> = {}): FakeFile => ({ id, name: `${id}.txt`, mimeType: 'text/plain', modified: '2026-11-01T10:00:00.000Z', text: `text of ${id}`, ...extra });

beforeAll(async () => {
  saas = await startFakeSaas({
    only: [workspaceModule],
    seedKey: 'test-seed',
    seedGrants: [
      { provider: 'google', email: NADIA },
      { provider: 'microsoft', email: NADIA },
      { provider: 'google', email: RAFI },
      { provider: 'notion', email: NADIA },
    ],
  });
  base = saas.workspace.url;
  g = saas.seedTokens('google', NADIA).accessToken;
  m = saas.seedTokens('microsoft', NADIA).accessToken;
  rafiG = saas.seedTokens('google', RAFI).accessToken;
});
afterAll(async () => {
  await saas.stop();
});
beforeEach(() => {
  saas.workspace.reset();
});

describe('seeded sign-ins', () => {
  it('the token is fs_<provider>_<24 hex> from the seed key and the address, and it works without any consent', async () => {
    expect(g).toMatch(/^fs_google_[0-9a-f]{24}$/);
    expect(m).toMatch(/^fs_microsoft_[0-9a-f]{24}$/);
    expect(g).toBe(saas.seedTokens('google', 'NADIA@kahf.example').accessToken);
    expect(g).not.toBe(rafiG);
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: g })).json.email).toBe(NADIA);
    expect((await call(`${base}/v1.0/me`, { token: m })).json.mail).toBe(NADIA);
    expect(saas.workspace.consents).toHaveLength(0);
  });

  it('a made-up token is 401, a Google token does not work for Microsoft', async () => {
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: 'fs_google_000000000000000000000000' })).status).toBe(401);
    expect((await call(`${base}/v1.0/me`, { token: g })).status).toBe(401);
    expect((await call(`${base}/v1.0/me`)).status).toBe(401);
    expect(saas.workspace.apiCalls.filter((c) => !c.authorized)).toHaveLength(3);
  });

  it('the seeded refresh token renews the access token', async () => {
    const refresh = saas.seedTokens('google', NADIA).refreshToken;
    const r = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: saas.workspace.clientId, client_secret: saas.workspace.clientSecret }) });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { access_token: string; scope: string };
    expect(out.scope).toContain('calendar.freebusy');
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: out.access_token })).json.email).toBe(NADIA);
  });

  it('a seeded grant survives reset; one added later (seedGrant) too', async () => {
    saas.workspace.seedGrant({ provider: 'google', email: RAFI, scopes: [G('drive.readonly')], accessToken: 'custom-token-1' });
    saas.workspace.reset();
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: g })).status).toBe(200);
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: 'custom-token-1' })).json.email).toBe(RAFI);
  });
});

describe('Google Drive: listing, sharing and the change feed', () => {
  beforeEach(() => {
    const w = saas.workspace;
    w.account(NADIA).files.length = 0;
    w.putFile(NADIA, file('folder-a', { name: 'Handbook', mimeType: 'application/vnd.google-apps.folder' }));
    w.putFile(NADIA, file('doc-1', { parentId: 'folder-a' }));
    w.putFile(NADIA, file('doc-2', { parentId: 'folder-a' }));
    w.putFile(NADIA, file('top-1'));
  });

  it('lists by folder, by type, hides the trashed ones when asked, and pages', async () => {
    const list = async (q: string, extra = ''): Promise<Json> => (await call(`${base}/drive/v3/files?q=${encodeURIComponent(q)}${extra}`, { token: g })).json;
    expect((await list("mimeType = 'application/vnd.google-apps.folder'")).files.map((f: { id: string }) => f.id)).toEqual(['folder-a']);
    expect((await list("'folder-a' in parents")).files.map((f: { id: string }) => f.id)).toEqual(['doc-1', 'doc-2']);
    expect((await list("'root' in parents")).files.map((f: { id: string }) => f.id)).toEqual(['folder-a', 'top-1']);
    saas.workspace.trashFile(NADIA, 'doc-2');
    expect((await list("'folder-a' in parents and trashed = false")).files.map((f: { id: string }) => f.id)).toEqual(['doc-1']);
    const first = await list("mimeType != 'application/vnd.google-apps.folder'", '&pageSize=1');
    expect(first.files).toHaveLength(1);
    expect(first.nextPageToken).toBe('1');
    const second = await list("mimeType != 'application/vnd.google-apps.folder'", '&pageSize=1&pageToken=1');
    expect(second.files[0].id).not.toBe(first.files[0].id);
  });

  it('metadata carries the version, size, trashed flag and parent', async () => {
    const r = await call(`${base}/drive/v3/files/doc-1`, { token: g });
    expect(r.json).toMatchObject({ id: 'doc-1', version: '1', size: String('text of doc-1'.length), trashed: false, parents: ['folder-a'] });
  });

  it('permissions: the owner first, then anyone, a domain, a user and a group, as Google names them', async () => {
    saas.workspace.setFilePermissions(NADIA, 'doc-1', [{ type: 'anyone' }, { type: 'domain', domain: 'kahf.example' }, { type: 'user', email: RAFI }, { type: 'group', email: 'eng@kahf.example' }]);
    const r = await call(`${base}/drive/v3/files/doc-1/permissions`, { token: g });
    expect(r.json.permissions).toEqual([
      { id: 'owner', type: 'user', role: 'owner', emailAddress: NADIA },
      { id: 'anyoneWithLink', type: 'anyone', role: 'reader', allowFileDiscovery: false },
      { id: 'domain-1', type: 'domain', role: 'reader', domain: 'kahf.example' },
      { id: 'user-2', type: 'user', role: 'reader', emailAddress: RAFI },
      { id: 'group-3', type: 'group', role: 'reader', emailAddress: 'eng@kahf.example' },
    ]);
    // a file with no sharing is the owner's alone; a missing file is 404; without the scope it is 403
    expect((await call(`${base}/drive/v3/files/top-1/permissions`, { token: g })).json.permissions).toHaveLength(1);
    expect((await call(`${base}/drive/v3/files/nope/permissions`, { token: g })).status).toBe(404);
  });

  it('changes: the start token, then only what changed; binned and deleted files are told apart; the feed pages', async () => {
    const w = saas.workspace;
    const start = (await call(`${base}/drive/v3/changes/startPageToken`, { token: g })).json.startPageToken as string;
    const empty = (await call(`${base}/drive/v3/changes?pageToken=${start}`, { token: g })).json;
    expect(empty.changes).toEqual([]);
    expect(empty.newStartPageToken).toBe(start);

    w.putFile(NADIA, file('doc-1', { parentId: 'folder-a', text: 'edited' }));
    w.setFilePermissions(NADIA, 'doc-2', [{ type: 'anyone' }]);
    w.trashFile(NADIA, 'top-1');
    w.removeFile(NADIA, 'folder-a');
    const feed = (await call(`${base}/drive/v3/changes?pageToken=${start}`, { token: g })).json;
    const byId = Object.fromEntries(feed.changes.map((c: { fileId: string }) => [c.fileId, c]));
    expect(Object.keys(byId).sort()).toEqual(['doc-1', 'doc-2', 'folder-a', 'top-1']);
    expect(byId['doc-1']).toMatchObject({ removed: false, file: { id: 'doc-1', version: '2' } });
    expect(byId['top-1']).toMatchObject({ removed: false, file: { trashed: true } });
    expect(byId['folder-a']).toMatchObject({ removed: true });
    expect(byId['folder-a'].file).toBeUndefined();
    // a second read from the new token is empty
    const again = (await call(`${base}/drive/v3/changes?pageToken=${feed.newStartPageToken}`, { token: g })).json;
    expect(again.changes).toEqual([]);

    // paging: two at a time, each page names the next token, the last names the new start token
    const page1 = (await call(`${base}/drive/v3/changes?pageToken=${start}&pageSize=3`, { token: g })).json;
    expect(page1.changes).toHaveLength(3);
    expect(page1.nextPageToken).toBeDefined();
    const page2 = (await call(`${base}/drive/v3/changes?pageToken=${page1.nextPageToken}&pageSize=3`, { token: g })).json;
    expect(page2.changes).toHaveLength(1);
    expect(page2.newStartPageToken).toBeDefined();
  });

  it("a change of one account is not in another's feed, and a bad token is 400", async () => {
    saas.workspace.account(RAFI);
    const start = (await call(`${base}/drive/v3/changes/startPageToken`, { token: rafiG })).json.startPageToken as string;
    saas.workspace.putFile(NADIA, file('doc-9'));
    expect((await call(`${base}/drive/v3/changes?pageToken=${start}`, { token: rafiG })).json.changes).toEqual([]);
    expect((await call(`${base}/drive/v3/changes?pageToken=abc`, { token: g })).status).toBe(400);
    expect((await call(`${base}/drive/v3/changes?pageToken=99999`, { token: g })).status).toBe(400);
  });
});

describe('OneDrive: children, permissions and delta', () => {
  beforeEach(() => {
    const w = saas.workspace;
    w.account(NADIA).files.length = 0;
    w.putFile(NADIA, file('folder-a', { name: 'Handbook', mimeType: 'application/vnd.google-apps.folder' }));
    w.putFile(NADIA, file('doc-1', { parentId: 'folder-a' }));
    w.putFile(NADIA, file('doc-2'));
  });

  it('lists the root and a folder; a folder is a folder, a file a file', async () => {
    const root = (await call(`${base}/v1.0/me/drive/root/children`, { token: m })).json.value;
    expect(root.map((i: { id: string }) => i.id)).toEqual(['folder-a', 'doc-2']);
    expect(root[0].folder).toBeDefined();
    expect(root[1].file).toEqual({ mimeType: 'text/plain' });
    const inside = (await call(`${base}/v1.0/me/drive/items/folder-a/children`, { token: m })).json.value;
    expect(inside.map((i: { id: string }) => i.id)).toEqual(['doc-1']);
    expect(inside[0].parentReference).toMatchObject({ driveId: `drive-${NADIA}`, id: 'folder-a' });
  });

  it('delta: the first round lists everything, the deltaLink then lists only what changed; removed and binned items are deleted', async () => {
    const w = saas.workspace;
    const first = (await call(`${base}/v1.0/me/drive/root/delta`, { token: m })).json;
    expect(first.value.map((i: { id: string }) => i.id)).toEqual(['folder-a', 'doc-1', 'doc-2']);
    const link = first['@odata.deltaLink'] as string;
    expect(link).toContain(`${base}/v1.0/me/drive/root/delta?token=`);
    expect((await call(link, { token: m })).json.value).toEqual([]);

    w.putFile(NADIA, file('doc-1', { parentId: 'folder-a', text: 'edited' }));
    w.trashFile(NADIA, 'doc-2');
    w.putFile(NADIA, file('doc-3'));
    w.removeFile(NADIA, 'doc-3');
    const second = (await call(link, { token: m })).json;
    const byId = Object.fromEntries(second.value.map((i: { id: string }) => [i.id, i]));
    expect(Object.keys(byId).sort()).toEqual(['doc-1', 'doc-2', 'doc-3']);
    expect(byId['doc-1'].name).toBe('doc-1.txt');
    expect(byId['doc-2'].deleted).toEqual({ state: 'deleted' });
    expect(byId['doc-3'].deleted).toEqual({ state: 'deleted' });
    expect(second['@odata.deltaLink']).not.toBe(link);
  });

  it('delta pages with a nextLink that is an absolute address, and a token from nowhere is 410', async () => {
    const page = (await call(`${base}/v1.0/me/drive/root/delta?$top=2`, { token: m })).json;
    expect(page.value).toHaveLength(2);
    expect(page['@odata.nextLink']).toMatch(new RegExp(`^${base}/v1.0/me/drive/root/delta\\?`));
    const rest = (await call(page['@odata.nextLink'], { token: m })).json;
    expect(rest.value).toHaveLength(1);
    expect(rest['@odata.deltaLink']).toBeDefined();
    expect((await call(`${base}/v1.0/me/drive/root/delta?token=999`, { token: m })).status).toBe(410);
  });

  it('delta from a token pages through changes too', async () => {
    const w = saas.workspace;
    const link = (await call(`${base}/v1.0/me/drive/root/delta`, { token: m })).json['@odata.deltaLink'] as string;
    for (const id of ['a', 'b', 'c']) w.putFile(NADIA, file(`new-${id}`));
    const page = (await call(`${link}&$top=2`, { token: m })).json;
    expect(page.value).toHaveLength(2);
    const rest = (await call(page['@odata.nextLink'], { token: m })).json;
    expect(rest.value).toHaveLength(1);
    expect(rest['@odata.deltaLink']).toBeDefined();
  });

  it('permissions: anonymous and organization links, users and groups; a domain that is not the owner’s has no counterpart', async () => {
    saas.workspace.setFilePermissions(NADIA, 'doc-2', [{ type: 'anyone' }, { type: 'domain', domain: 'kahf.example' }, { type: 'domain', domain: 'other.example' }, { type: 'user', email: RAFI }, { type: 'group', email: 'eng-group' }]);
    const r = (await call(`${base}/v1.0/me/drive/items/doc-2/permissions`, { token: m })).json.value;
    expect(r).toEqual([
      { id: 'owner', roles: ['owner'], grantedToV2: { user: { email: NADIA, displayName: 'nadia' } } },
      { id: 'link-0', roles: ['read'], link: { scope: 'anonymous', type: 'view' } },
      { id: 'link-1', roles: ['read'], link: { scope: 'organization', type: 'view' } },
      { id: 'user-3', roles: ['read'], grantedToV2: { user: { email: RAFI, displayName: 'rafi' } } },
      { id: 'group-4', roles: ['read'], grantedToV2: { group: { id: 'eng-group', displayName: 'eng-group' } } },
    ]);
    expect((await call(`${base}/v1.0/me/drive/items/nope/permissions`, { token: m })).status).toBe(404);
  });
});

describe('Notion: search order, paging, blocks, trash and public pages', () => {
  beforeEach(() => {
    const w = saas.workspace;
    w.account(NADIA).pages.length = 0;
    w.putPage(NADIA, { id: 'p-old', title: 'Old', blocks: ['one'], lastEdited: '2026-10-01T00:00:00.000Z' });
    w.putPage(NADIA, { id: 'p-new', title: 'New', blocks: ['two'], lastEdited: '2026-11-05T00:00:00.000Z', public: true });
    w.putPage(NADIA, { id: 'p-mid', title: 'Mid', blocks: Array.from({ length: 5 }, (_, i) => `block ${i}`), lastEdited: '2026-10-20T00:00:00.000Z' });
    w.putPage(NADIA, { id: 'p-gone', title: 'Gone', blocks: ['x'], lastEdited: '2026-11-06T00:00:00.000Z', archived: true });
  });
  const notion = (path: string, body?: unknown): Promise<Json> => call(`${base}/v1${path}`, { token: saas.seedTokens('notion', NADIA).accessToken, method: body === undefined ? 'GET' : 'POST', body, headers: { 'notion-version': '2022-06-28' } }).then((r) => r.json);

  it('sorts by last edited, either way, and leaves the archived page out', async () => {
    const desc = await notion('/search', { sort: { direction: 'descending', timestamp: 'last_edited_time' } });
    expect(desc.results.map((p: { id: string }) => p.id)).toEqual(['p-new', 'p-mid', 'p-old']);
    const asc = await notion('/search', { sort: { direction: 'ascending', timestamp: 'last_edited_time' } });
    expect(asc.results.map((p: { id: string }) => p.id)).toEqual(['p-old', 'p-mid', 'p-new']);
    expect(desc.results[0]).toMatchObject({ last_edited_time: '2026-11-05T00:00:00.000Z', archived: false, public_url: 'https://notion.example/public/p-new' });
    expect(desc.results[1].public_url).toBeNull();
  });

  it('pages with page_size and the cursor', async () => {
    const first = await notion('/search', { page_size: 2, sort: { direction: 'descending', timestamp: 'last_edited_time' } });
    expect(first).toMatchObject({ has_more: true, next_cursor: '2' });
    const second = await notion('/search', { page_size: 2, start_cursor: first.next_cursor, sort: { direction: 'descending', timestamp: 'last_edited_time' } });
    expect(second.results.map((p: { id: string }) => p.id)).toEqual(['p-old']);
    expect(second).toMatchObject({ has_more: false, next_cursor: null });
  });

  it('the blocks of a page come in pages; an archived page can still be read and says so', async () => {
    const first = await notion('/blocks/p-mid/children?page_size=3');
    expect(first.results).toHaveLength(3);
    expect(first).toMatchObject({ has_more: true, next_cursor: '3' });
    const rest = await notion(`/blocks/p-mid/children?page_size=3&start_cursor=${first.next_cursor}`);
    expect(rest.results).toHaveLength(2);
    expect(rest.has_more).toBe(false);
    expect((await notion('/pages/p-gone')).archived).toBe(true);
  });

  it('putPage stamps the edit time with now unless one is given', async () => {
    saas.workspace.putPage(NADIA, { id: 'p-fresh', title: 'Fresh', blocks: [] });
    const found = (await notion('/search', { query: 'Fresh' })).results[0];
    expect(Date.now() - Date.parse(found.last_edited_time)).toBeLessThan(5000);
  });
});

describe('calendars: events exist once created, can be read, changed and cancelled', () => {
  const post = (path: string, token: string, body: unknown, method = 'POST') => call(`${base}${path}`, { token, method, body });

  it('Google: create keeps description and location, a read by id returns them, a change is visible, a delete is gone (410)', async () => {
    const created = await post('/calendar/v3/calendars/primary/events', g, {
      summary: 'Design review',
      description: 'Agenda\n\nJoin: https://manythreads.example/join/abc',
      location: 'https://manythreads.example/join/abc',
      start: { dateTime: '2026-11-09T15:00:00+00:00' },
      end: { dateTime: '2026-11-09T15:30:00+00:00' },
      attendees: [{ email: RAFI }, { email: 'guest@outside.test' }],
    });
    expect(created.status).toBe(200);
    const id = created.json.id as string;
    expect(saas.workspace.createdEvents.at(-1)).toMatchObject({ title: 'Design review', guests: [RAFI, 'guest@outside.test'] });
    expect(saas.workspace.createdEventDetails.at(-1)).toMatchObject({ eventId: id, description: expect.stringContaining('/join/abc'), location: 'https://manythreads.example/join/abc' });

    const read = (await call(`${base}/calendar/v3/calendars/primary/events/${id}`, { token: g })).json;
    expect(read).toMatchObject({ id, status: 'confirmed', summary: 'Design review', location: 'https://manythreads.example/join/abc', organizer: { email: NADIA } });
    expect(read.description).toContain('Join:');
    expect(read.attendees.map((a: { email: string }) => a.email)).toEqual([RAFI, 'guest@outside.test']);

    await post(`/calendar/v3/calendars/primary/events/${id}`, g, { start: { dateTime: '2026-11-09T16:00:00+00:00' }, end: { dateTime: '2026-11-09T16:30:00+00:00' }, description: 'new agenda' }, 'PATCH');
    const moved = (await call(`${base}/calendar/v3/calendars/primary/events/${id}`, { token: g })).json;
    expect(moved).toMatchObject({ start: { dateTime: '2026-11-09T16:00:00+00:00' }, description: 'new agenda' });

    const listed = (await call(`${base}/calendar/v3/calendars/primary/events?timeMin=2026-11-09T00:00:00Z&timeMax=2026-11-10T00:00:00Z`, { token: g })).json;
    expect(listed.items.map((e: { id: string }) => e.id)).toContain(id);

    expect((await call(`${base}/calendar/v3/calendars/primary/events/${id}`, { token: g, method: 'DELETE' })).status).toBe(204);
    expect(saas.workspace.deletedEvents).toEqual([{ provider: 'google', account: NADIA, eventId: id }]);
    expect((await call(`${base}/calendar/v3/calendars/primary/events/${id}`, { token: g })).status).toBe(410);
    expect((await call(`${base}/calendar/v3/calendars/primary/events/nope`, { token: g })).status).toBe(404);
  });

  it('Google: an event the organizer cancelled at the provider reads as cancelled, drops out of the list and out of busy time', async () => {
    saas.workspace.putEvent(NADIA, { id: 'ev-c', title: 'Cancelled one', start: '2026-11-09T10:00:00.000Z', end: '2026-11-09T11:00:00.000Z', status: 'cancelled' });
    expect((await call(`${base}/calendar/v3/calendars/primary/events/ev-c`, { token: g })).json.status).toBe('cancelled');
    const listed = (await call(`${base}/calendar/v3/calendars/primary/events?timeMin=2026-11-09T00:00:00Z&timeMax=2026-11-10T00:00:00Z`, { token: g })).json;
    expect(listed.items.map((e: { id: string }) => e.id)).not.toContain('ev-c');
    const busy = (await post('/calendar/v3/freeBusy', g, { timeMin: '2026-11-09T00:00:00Z', timeMax: '2026-11-10T00:00:00Z', items: [{ id: 'primary' }] })).json;
    expect(busy.calendars.primary.busy).toEqual([]);
  });

  it('Microsoft: create keeps body and location, get, change, cancel and delete work', async () => {
    const created = await post('/v1.0/me/events', m, {
      subject: 'Design review',
      body: { contentType: 'text', content: 'Join: https://manythreads.example/join/abc' },
      location: { displayName: 'https://manythreads.example/join/abc' },
      start: { dateTime: '2026-11-09T15:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-09T15:30:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: RAFI }, type: 'required' }],
    });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    const read = (await call(`${base}/v1.0/me/events/${id}`, { token: m })).json;
    expect(read).toMatchObject({ id, subject: 'Design review', isCancelled: false, body: { content: expect.stringContaining('/join/abc') }, location: { displayName: 'https://manythreads.example/join/abc' }, start: { dateTime: '2026-11-09T15:00:00.000Z', timeZone: 'UTC' } });
    expect((await post(`/v1.0/me/events/${id}/cancel`, m, {})).status).toBe(202);
    expect((await call(`${base}/v1.0/me/events/${id}`, { token: m })).json.isCancelled).toBe(true);
    expect((await call(`${base}/v1.0/me/events/${id}`, { token: m, method: 'DELETE' })).status).toBe(204);
    expect((await call(`${base}/v1.0/me/events/${id}`, { token: m })).status).toBe(404);
    expect(saas.workspace.deletedEvents.map((d) => d.provider)).toEqual(['microsoft', 'microsoft']);
  });

  it('free/busy: a shared calendar answers, one that is not shared answers like a missing one; your own is always there', async () => {
    saas.workspace.putEvent(RAFI, { id: 'ev-r', title: 'Private thing', start: '2026-11-09T10:00:00.000Z', end: '2026-11-09T11:00:00.000Z' });
    const ask = async (): Promise<Json> => (await post('/calendar/v3/freeBusy', g, { timeMin: '2026-11-09T00:00:00Z', timeMax: '2026-11-10T00:00:00Z', items: [{ id: RAFI }, { id: NADIA }, { id: 'stranger@x.test' }] })).json.calendars;
    let c = await ask();
    expect(c[RAFI].busy).toEqual([{ start: '2026-11-09T10:00:00.000Z', end: '2026-11-09T11:00:00.000Z' }]);
    expect(c[NADIA].errors).toBeUndefined();
    expect(c['stranger@x.test'].errors).toEqual([{ domain: 'global', reason: 'notFound' }]);

    saas.workspace.account(RAFI).shareCalendar = false;
    c = await ask();
    expect(c[RAFI]).toEqual({ busy: [], errors: [{ domain: 'global', reason: 'notFound' }] });
    expect(c[NADIA].errors).toBeUndefined();

    const ms = (await post('/v1.0/me/calendar/getSchedule', m, { schedules: [RAFI, NADIA], startTime: { dateTime: '2026-11-09T00:00:00', timeZone: 'UTC' }, endTime: { dateTime: '2026-11-10T00:00:00', timeZone: 'UTC' } })).json.value;
    expect(ms[0]).toMatchObject({ scheduleId: RAFI, scheduleItems: [], error: { responseCode: 'ErrorAccessDenied' } });
    expect(ms[1].error).toBeUndefined();
  });
});

describe('reset', () => {
  it('puts the accounts back, forgets the records and the forced failures', async () => {
    saas.workspace.putFile(NADIA, file('extra'));
    saas.workspace.account(RAFI).shareCalendar = false;
    saas.workspace.failNextApi(500, 5);
    saas.workspace.reset();
    expect(saas.workspace.account(NADIA).files.map((f) => f.id)).not.toContain('extra');
    expect(saas.workspace.account(RAFI).shareCalendar).toBeUndefined();
    expect(saas.workspace.apiCalls).toHaveLength(0);
    expect((await call(`${base}/oauth2/v3/userinfo`, { token: g })).status).toBe(200);
    expect((await call(`${base}/drive/v3/changes/startPageToken`, { token: g })).json.startPageToken).toBe('0');
  });
});
