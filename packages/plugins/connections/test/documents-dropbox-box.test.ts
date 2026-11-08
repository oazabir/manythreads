import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { box } from '../src/documents/box.ts';
import { dropbox } from '../src/documents/dropbox.ts';
import type { FakeBox } from '../../../../tools/fake-saas/src/providers/box.ts';
import type { FakeDropbox } from '../../../../tools/fake-saas/src/providers/dropbox.ts';
import { caught, drain, ids, OWNER, startRig, type Rig } from './documents-helpers.ts';

// Dropbox and Box against fake-saas (P16-08, WP-D1).

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
});
afterAll(async () => {
  await rig.stop();
});
const dbx = () => rig.saas.standIns['dropbox']!.api as FakeDropbox;
const bx = () => rig.saas.standIns['box']!.api as FakeBox;
beforeEach(() => {
  dbx().reset();
  bx().reset();
});
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');
const BIG = 11 * 1024 * 1024;

describe('Dropbox', () => {
  const ctx = () => rig.ctx('dropbox');

  it('offers the whole Dropbox and its top folders', async () => {
    const roots = await dropbox.listRoots(ctx());
    expect(roots.map((r) => r.id)).toEqual(['root', '/docs', '/private']);
    expect(roots[1]).toMatchObject({ name: 'Docs', kind: 'folder', parent: 'Dropbox' });
  });

  it('lists every readable file on the first pass, then only what changed or was deleted', async () => {
    const first = await drain(dropbox, ctx(), 'root');
    expect(ids(first.items)).toEqual(['/docs/handbook/rules.txt', '/docs/report.pdf', '/docs/welcome.md', '/private/notes.txt']);
    expect(first.items.find((i) => i.remoteId === '/docs/welcome.md')).toMatchObject({ name: 'Welcome.md', kind: 'md', version: 'rev0001', removed: false });

    expect((await drain(dropbox, ctx(), 'root', first.cursor)).items).toEqual([]);

    dbx().putFile({ path: '/Docs/Welcome.md', content: '# Welcome again' });
    dbx().removeFile('/Docs/Handbook/Rules.txt');
    const second = await drain(dropbox, ctx(), 'root', first.cursor);
    expect(ids(second.items)).toEqual(['-/docs/handbook/rules.txt', '/docs/welcome.md']);
    expect(second.items.find((i) => i.remoteId === '/docs/welcome.md')!.version).not.toBe('rev0001');
    expect((await drain(dropbox, ctx(), 'root', second.cursor)).items).toEqual([]);
  });

  it('a folder root keeps to that folder', async () => {
    const first = await drain(dropbox, ctx(), '/docs');
    expect(ids(first.items)).toEqual(['/docs/handbook/rules.txt', '/docs/report.pdf', '/docs/welcome.md']);
    dbx().putFile({ path: '/Private/Notes.txt', content: 'changed' });
    expect((await drain(dropbox, ctx(), '/docs', first.cursor)).items).toEqual([]);
    expect((await caught(() => dropbox.listChanges(ctx(), { root: '/nowhere', cursor: null })))?.code).toBe('not_found');
  });

  it('a long listing arrives in pages, each cursor a valid place to resume', async () => {
    for (let i = 0; i < 450; i++) dbx().data.files.push({ path: `/Docs/bulk/file-${String(i)}.txt`, content: 'x', rev: `rb${String(i)}`, modified: '2026-10-05T00:00:00.000Z' });
    dbx().data.folders.push('/Docs/bulk');
    const one = await dropbox.listChanges(ctx(), { root: 'root', cursor: null });
    expect(one.next).toBe(one.cursor);
    const rest = await drain(dropbox, ctx(), 'root', one.next);
    expect(one.items.length + rest.items.length).toBe(454);
    expect((await drain(dropbox, ctx(), 'root', rest.cursor)).items).toEqual([]);
  });

  it('a cursor Dropbox asks to reset, or one that is not ours, means a full listing', async () => {
    const first = await drain(dropbox, ctx(), 'root');
    dbx().resetNextCursor();
    expect(ids((await drain(dropbox, ctx(), 'root', first.cursor)).items)).toEqual(ids(first.items));
    expect(ids((await drain(dropbox, ctx(), 'root', 'v1.bm90LWpzb24')).items)).toEqual(ids(first.items));
    expect(ids((await drain(dropbox, ctx(), 'root', 'junk')).items)).toEqual(ids(first.items));
  });

  it('fetches a file by its path (a name outside ASCII too), cuts a long text and refuses a long binary file', async () => {
    const c = ctx();
    expect(text((await dropbox.fetch(c, '/docs/welcome.md')).bytes)).toContain('Hello from Dropbox');
    dbx().putFile({ path: '/Docs/Ünïcode ✓.txt', content: 'unicode ok' });
    const uni = await dropbox.fetch(c, '/docs/ünïcode ✓.txt');
    expect(text(uni.bytes)).toBe('unicode ok');
    dbx().putFile({ path: '/Docs/big.txt', content: 'a'.repeat(BIG) });
    expect((await dropbox.fetch(c, '/docs/big.txt')).bytes.length).toBe(10 * 1024 * 1024);
    dbx().putFile({ path: '/Docs/big.pdf', content: Buffer.alloc(BIG, 1) });
    expect((await caught(() => dropbox.fetch(c, '/docs/big.pdf')))?.code).toBe('not_found');
    expect((await caught(() => dropbox.fetch(c, '/docs/photo.png')))?.code).toBe('not_found');
    expect((await caught(() => dropbox.fetch(c, '/docs/missing.txt')))?.code).toBe('not_found');
  });

  it('says who may open a file: members by address, a public link as anyone, a group or a team link as not everyone, anything unreadable the same', async () => {
    const c = ctx();
    expect(await dropbox.access(c, '/docs/welcome.md')).toEqual({ anyone: false, domains: [], users: [OWNER, 'lena@kahf.example'], groups: false });
    expect(await dropbox.access(c, '/docs/handbook/rules.txt')).toMatchObject({ anyone: true, groups: false });
    expect((await dropbox.access(c, '/docs/report.pdf')).groups).toBe(true);
    dbx().putFile({ path: '/Docs/Team.txt', content: 't', sharing: { teamLink: true } });
    expect(await dropbox.access(c, '/docs/team.txt')).toMatchObject({ anyone: false, groups: true });
    expect(await dropbox.access(c, '/docs/missing.txt')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    expect(await dropbox.access(c, 'not-a-path')).toEqual({ anyone: false, domains: [], users: [], groups: true });
  });

  it('errors never carry the token', async () => {
    const c = ctx();
    dbx().server.failNextApi(500, 1);
    const err = await caught(() => dropbox.fetch(c, '/docs/welcome.md'));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain(c.token);
    const dead = await caught(() => dropbox.listRoots(rig.ctx('dropbox', { token: 'nobody-issued-this' })));
    expect(dead?.code).toBe('not_connected');
    expect(dead?.message).not.toContain('nobody-issued-this');
    dbx().server.failNextApi(500, 1);
    expect(await caught(() => dropbox.access(c, '/docs/welcome.md'))).toMatchObject({ code: 'provider_down' });
  });
});

describe('Box', () => {
  const ctx = () => rig.ctx('box');

  it('offers all files and its top folders', async () => {
    const roots = await box.listRoots(ctx());
    expect(roots.map((r) => r.id)).toEqual(['0', '100', '102']);
  });

  it('lists every readable file on the first pass, then only what was edited since or went to the trash', async () => {
    const first = await drain(box, ctx(), '0');
    expect(ids(first.items)).toEqual(['201', '202', '203', '205']);
    expect(first.calls).toBeGreaterThan(1);
    expect(first.items.find((i) => i.remoteId === '201')).toMatchObject({ name: 'Welcome.md', kind: 'md', removed: false });

    expect((await drain(box, ctx(), '0', first.cursor)).items).toEqual([]);

    bx().putFile({ id: '201', name: 'Welcome.md', parentId: '100', content: '# Welcome again', modified: '2026-11-01T00:00:00-07:00' });
    bx().putFile({ id: '206', name: 'New.txt', parentId: '101', content: 'new', modified: '2026-11-01T01:00:00-07:00' });
    bx().trashFile('205', '2026-11-02T00:00:00-07:00');
    const second = await drain(box, ctx(), '0', first.cursor);
    expect(ids(second.items)).toEqual(['-205', '201', '206']);
    expect(second.items.find((i) => i.remoteId === '201')!.version).not.toBe(first.items.find((i) => i.remoteId === '201')!.version);
    expect((await drain(box, ctx(), '0', second.cursor)).items).toEqual([]);
  });

  it('a folder root keeps to that folder and the ones under it', async () => {
    expect(ids((await drain(box, ctx(), '100')).items)).toEqual(['201', '202', '203']);
    expect(ids((await drain(box, ctx(), '102')).items)).toEqual(['205']);
    expect((await caught(() => box.listChanges(ctx(), { root: '9999', cursor: null })))?.code).toBe('not_found');
  });

  it('a pass that stops part-way resumes from its cursor', async () => {
    const one = await box.listChanges(ctx(), { root: '0', cursor: null });
    expect(one.next).toBe(one.cursor);
    const rest = await drain(box, ctx(), '0', one.next);
    expect(ids([...one.items, ...rest.items])).toEqual(['201', '202', '203', '205']);
    expect((await drain(box, ctx(), '0', 'junk')).items).toHaveLength(4);
  });

  it('fetches a file, cuts a long text and refuses a long binary file', async () => {
    const c = ctx();
    expect(text((await box.fetch(c, '201')).bytes)).toContain('Hello from Box');
    bx().putFile({ id: '207', name: 'big.txt', parentId: '100', content: 'a'.repeat(BIG) });
    expect((await box.fetch(c, '207')).bytes.length).toBe(10 * 1024 * 1024);
    bx().putFile({ id: '208', name: 'big.pdf', parentId: '100', content: 'x', reportedSize: BIG });
    expect((await caught(() => box.fetch(c, '208')))?.code).toBe('not_found');
    expect((await caught(() => box.fetch(c, '204')))?.code).toBe('not_found');
    bx().trashFile('201');
    expect((await caught(() => box.fetch(c, '201')))?.code).toBe('not_found');
    expect((await caught(() => box.fetch(c, '9999')))?.code).toBe('not_found');
  });

  it('never dials an address Box sends for a download that is not a public one', async () => {
    const c = ctx();
    bx().redirectDownloadsTo('http://127.0.0.1:9/secret?token=abc');
    const err = await caught(() => box.fetch(c, '201'));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain('127.0.0.1');
    expect(err?.message).not.toContain('secret');
    expect(err?.message).not.toContain(c.token);
  });

  it('says who may open a file: the owner and the collaborators of the file and its folders, an open link as anyone, a group as not everyone', async () => {
    const c = () => ctx();
    expect(await box.access(c(), '201')).toEqual({ anyone: false, domains: [], users: [OWNER, 'lena@kahf.example'], groups: false });
    expect(await box.access(c(), '205')).toEqual({ anyone: false, domains: [], users: [OWNER], groups: false });
    expect(await box.access(c(), '202')).toMatchObject({ anyone: true });
    expect(await box.access(c(), '203')).toMatchObject({ anyone: false, groups: true });
    bx().putFile({ id: '209', name: 'Company.txt', parentId: '102', content: 'c', link: 'company' });
    expect(await box.access(c(), '209')).toMatchObject({ anyone: false, groups: true });
    expect(await box.access(c(), '9999')).toEqual({ anyone: false, domains: [], users: [], groups: true });
  });

  it('errors never carry the token', async () => {
    const c = ctx();
    bx().server.failNextApi(500, 1);
    const err = await caught(() => box.listRoots(c));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain(c.token);
    const dead = await caught(() => box.listRoots(rig.ctx('box', { token: 'nobody-issued-this' })));
    expect(dead?.code).toBe('not_connected');
    expect(dead?.message).not.toContain('nobody-issued-this');
  });
});
