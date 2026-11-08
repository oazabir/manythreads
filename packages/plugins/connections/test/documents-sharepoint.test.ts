import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AdapterCtx } from '../src/documents/adapter.ts';
import { Memo, createDocHttp } from '../src/documents/http.ts';
import { sharePoint } from '../src/documents/sharepoint.ts';
import { caught, drain, ids, LATER } from './documents-helpers.ts';

// SharePoint (P16-08, WP-D1). The workspace stand-in of fake-saas has no sites, so this file stands up its own small Graph: one site with one library, a `delta` feed that
// pages and hands back a delta link, and the item, content and permission calls. What it checks is the reader: ids carry the drive, the feed is followed by path only, a
// link that points elsewhere is refused, and sharing is read as the team rule needs.

interface Item {
  id: string;
  name: string;
  text: string;
  etag: string;
  deleted?: boolean;
  folder?: boolean;
  perms: Array<Record<string, unknown>>;
}

let server: Server;
let base = '';
let seq = 0;
let items: Item[] = [];
let log: Array<{ seq: number; id: string }> = [];
let evilNext = false;
const seen: string[] = [];

const reset = (): void => {
  seq = 10;
  log = [];
  evilNext = false;
  items = [
    { id: 'i1', name: 'Plan.docx', text: 'plan', etag: '"1"', perms: [{ id: 'p', roles: ['owner'], grantedToV2: { user: { email: 'omar@kahf.example' } } }] },
    { id: 'i2', name: 'Notes.md', text: '# notes', etag: '"1"', perms: [{ id: 'p', roles: ['read'], link: { scope: 'organization', type: 'view' } }] },
    { id: 'i3', name: 'Folder', text: '', etag: '"1"', folder: true, perms: [] },
    { id: 'i4', name: 'Open.txt', text: 'open', etag: '"1"', perms: [{ id: 'p', roles: ['read'], link: { scope: 'anonymous', type: 'view' } }] },
    { id: 'i5', name: 'Group.txt', text: 'group', etag: '"1"', perms: [{ id: 'p', roles: ['read'], grantedToV2: { siteGroup: { id: '3', displayName: 'Members' } } }] },
  ];
};
const row = (i: Item): Record<string, unknown> =>
  i.deleted
    ? { id: i.id, deleted: { state: 'deleted' }, parentReference: { driveId: 'b!lib1' } }
    : { id: i.id, name: i.name, eTag: i.etag, webUrl: `https://kahf.sharepoint.example/${i.id}`, size: i.text.length, ...(i.folder ? { folder: {} } : { file: { mimeType: 'text/plain' } }), parentReference: { driveId: 'b!lib1' } };

beforeAll(async () => {
  reset();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    seen.push(`${req.method ?? ''} ${url.pathname}`);
    const send = (status: number, doc: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc));
    };
    const p = decodeURIComponent(url.pathname).replace(/^\/v1\.0/, '');
    if (p === '/me') return send(200, { mail: 'omar@kahf.example' });
    if (p === '/sites') return send(200, { value: [{ id: 'host,guid1,guid2', displayName: 'Team Site' }] });
    if (p === '/sites/host,guid1,guid2/drives') return send(200, { value: [{ id: 'b!lib1', name: 'Documents' }] });
    if (p === '/drives/b!lib1/root/delta') {
      const token = url.searchParams.get('token');
      const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
      const since = url.searchParams.get('since') ?? token;
      if (token !== null && Number(token) > seq) return send(410, { error: { code: 'resyncRequired' } });
      const rows = since === null ? items.filter((i) => !i.deleted).map(row) : [...new Set(log.filter((l) => l.seq > Number(since)).map((l) => l.id))].map((id) => row(items.find((i) => i.id === id)!));
      const page = rows.slice(skip, skip + 2);
      const origin = evilNext ? 'http://169.254.169.254' : base;
      return send(200, {
        value: page,
        ...(skip + 2 < rows.length
          ? { '@odata.nextLink': `${origin}/v1.0/drives/b!lib1/root/delta?$skiptoken=${String(skip + 2)}${since === null ? '' : `&since=${since}`}` }
          : { '@odata.deltaLink': `${origin}/v1.0/drives/b!lib1/root/delta?token=${String(seq)}` }),
      });
    }
    const item = /^\/drives\/b!lib1\/items\/([^/]+)(\/content|\/permissions)?$/.exec(p);
    const found = item ? items.find((i) => i.id === item[1] && !i.deleted) : undefined;
    if (!item || !found) return send(404, { error: 'not_found' });
    if (item[2] === '/content') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return void res.end(found.text);
    }
    if (item[2] === '/permissions') return send(200, { value: found.perms });
    return send(200, row(found));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ctx = (): AdapterCtx => ({
  http: createDocHttp({ label: 'Microsoft', apiBase: `${base}/v1.0`, token: async () => 'tok-secret' }),
  memo: new Memo(60_000, 100),
  prefix: 't',
  now: () => LATER,
});
const edit = (id: string, change: Partial<Item>): void => {
  Object.assign(items.find((i) => i.id === id)!, change);
  log.push({ seq: ++seq, id });
};

describe('SharePoint', () => {
  it('offers the libraries of the sites, named by site and library', async () => {
    reset();
    expect(await sharePoint.listRoots(ctx())).toEqual([{ id: 'b!lib1', name: 'Team Site / Documents', kind: 'library', parent: 'Team Site' }]);
  });

  it('lists the library on the first pass with ids that carry the drive, then only what changed or was deleted', async () => {
    reset();
    const first = await drain(sharePoint, ctx(), 'b!lib1');
    expect(first.calls).toBe(3);
    expect(ids(first.items)).toEqual(['b!lib1/i1', 'b!lib1/i2', 'b!lib1/i4', 'b!lib1/i5']);
    expect(first.items.find((i) => i.remoteId === 'b!lib1/i2')).toMatchObject({ name: 'Notes.md', kind: 'md', version: '"1"', removed: false });

    expect((await drain(sharePoint, ctx(), 'b!lib1', first.cursor)).items).toEqual([]);

    edit('i1', { etag: '"2"', text: 'plan v2' });
    edit('i4', { deleted: true });
    edit('i3', { name: 'Renamed folder' });
    const second = await drain(sharePoint, ctx(), 'b!lib1', first.cursor);
    expect(ids(second.items)).toEqual(['-b!lib1/i4', 'b!lib1/i1']);
    expect((await drain(sharePoint, ctx(), 'b!lib1', second.cursor)).items).toEqual([]);
  });

  it('a delta point the service no longer knows means a full listing', async () => {
    reset();
    const stale = Buffer.from(JSON.stringify({ k: 'delta', p: '/drives/b!lib1/root/delta?token=999999' })).toString('base64url');
    expect(ids((await drain(sharePoint, ctx(), 'b!lib1', `v1.${stale}`)).items)).toEqual(['b!lib1/i1', 'b!lib1/i2', 'b!lib1/i4', 'b!lib1/i5']);
  });

  it('a cursor that points at another library, or any other address, is not followed', async () => {
    reset();
    seen.length = 0;
    const other = Buffer.from(JSON.stringify({ k: 'delta', p: '/drives/other/root/delta?token=1' })).toString('base64url');
    expect(ids((await drain(sharePoint, ctx(), 'b!lib1', `v1.${other}`)).items)).toHaveLength(4);
    expect(seen.some((s) => s.includes('/drives/other'))).toBe(false);
  });

  it('refuses a feed link that is not on the service\'s own address, and says nothing of it', async () => {
    reset();
    evilNext = true;
    const err = await caught(() => drain(sharePoint, ctx(), 'b!lib1'));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain('169.254');
    expect(err?.message).not.toContain('tok-secret');
  });

  it('fetches a file by its drive and item, and refuses an id without a drive', async () => {
    reset();
    expect(Buffer.from((await sharePoint.fetch(ctx(), 'b!lib1/i2')).bytes).toString('utf8')).toBe('# notes');
    expect((await caught(() => sharePoint.fetch(ctx(), 'i2')))?.code).toBe('not_found');
    expect((await caught(() => sharePoint.fetch(ctx(), 'b!lib1/i3')))?.code).toBe('not_found');
    expect((await caught(() => sharePoint.fetch(ctx(), 'b!lib1/zzz')))?.code).toBe('not_found');
    expect((await caught(() => sharePoint.fetch(ctx(), 'b!lib1/../x')))?.code).toBe('not_found');
  });

  it('reads sharing: a named person, an organisation link as the owner\'s domain, an anonymous link as anyone, a site group as not everyone', async () => {
    reset();
    expect(await sharePoint.access(ctx(), 'b!lib1/i1')).toEqual({ anyone: false, domains: [], users: ['omar@kahf.example'], groups: false });
    expect(await sharePoint.access(ctx(), 'b!lib1/i2')).toEqual({ anyone: false, domains: ['kahf.example'], users: [], groups: false });
    expect(await sharePoint.access(ctx(), 'b!lib1/i4')).toMatchObject({ anyone: true });
    expect(await sharePoint.access(ctx(), 'b!lib1/i5')).toMatchObject({ anyone: false, groups: true });
    expect(await sharePoint.access(ctx(), 'b!lib1/missing')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    expect(await sharePoint.access(ctx(), 'no-drive')).toEqual({ anyone: false, domains: [], users: [], groups: true });
  });
});
