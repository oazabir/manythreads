import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { confluence } from '../src/documents/confluence.ts';
import { notion } from '../src/documents/notion.ts';
import type { FakeConfluence } from '../../../../tools/fake-saas/src/providers/confluence.ts';
import { caught, drain, ids, OWNER, startRig, type Rig } from './documents-helpers.ts';

// Notion and Confluence against fake-saas (P16-08, WP-D1): pages come newest edit first and a pass stops at the first page not edited since the last one.

let rig: Rig;
beforeAll(async () => {
  rig = await startRig();
});
afterAll(async () => {
  await rig.stop();
});
const ws = () => rig.saas.workspace;
const cf = () => rig.saas.standIns['confluence']!.api as FakeConfluence;
beforeEach(() => {
  ws().reset();
  cf().reset();
});
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8');

describe('Notion', () => {
  const ctx = () => rig.ctx('notion');

  it('lists every page on the first pass, then only the pages edited since', async () => {
    const first = await drain(notion, ctx(), 'workspace');
    expect(ids(first.items)).toEqual(['page-handbook', 'page-ideas']);
    expect(first.items[0]).toMatchObject({ kind: 'md', removed: false });
    expect(first.items.find((i) => i.remoteId === 'page-handbook')).toMatchObject({ name: 'Team handbook', version: '2026-10-30T12:00:00.000Z' });

    expect((await drain(notion, ctx(), 'workspace', first.cursor)).items).toEqual([]);

    ws().putPage(OWNER, { id: 'page-ideas', title: 'Ideas shelf', blocks: ['Ideas for next quarter.'], lastEdited: '2026-11-02T10:00:00.000Z' });
    ws().putPage(OWNER, { id: 'page-new', title: 'New page', blocks: ['hello'], lastEdited: '2026-11-02T11:00:00.000Z' });
    const second = await drain(notion, ctx(), 'workspace', first.cursor);
    expect(ids(second.items)).toEqual(['page-ideas', 'page-new']);
    expect((await drain(notion, ctx(), 'workspace', second.cursor)).items).toEqual([]);
  });

  it('holds the mark back two minutes from now: a page edited just before the pass is listed once more rather than missed', async () => {
    const recent = new Date(LATER_MINUS(30_000)).toISOString();
    ws().putPage(OWNER, { id: 'page-recent', title: 'Recent', blocks: ['x'], lastEdited: recent });
    const c = ctx();
    c.now = () => new Date(LATER_MINUS(0));
    const first = await drain(notion, c, 'workspace');
    expect(ids(first.items)).toContain('page-recent');
    const again = await drain(notion, c, 'workspace', first.cursor);
    expect(ids(again.items)).toEqual(['page-recent']);
  });

  it('reads a page as markdown, and refuses a page in the trash', async () => {
    const page = await notion.fetch(ctx(), 'page-handbook');
    expect(page.kind).toBe('md');
    const md = text(page.bytes);
    expect(md).toContain('# Team handbook');
    expect(md).toContain('## Escalation');
    expect(md).toContain('- Page the on-call engineer first');
    ws().putPage(OWNER, { id: 'page-ideas', title: 'Ideas shelf', blocks: [], archived: true });
    expect((await caught(() => notion.fetch(ctx(), 'page-ideas')))?.code).toBe('not_found');
    expect((await caught(() => notion.fetch(ctx(), 'no-such-page')))?.code).toBe('not_found');
  });

  it('a page is "not everyone" unless it is published to the web', async () => {
    expect(await notion.access(ctx(), 'page-handbook')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    ws().putPage(OWNER, { id: 'page-handbook', title: 'Team handbook', blocks: [], public: true });
    expect(await notion.access(ctx(), 'page-handbook')).toMatchObject({ anyone: true, groups: false });
    expect(await notion.access(ctx(), 'no-such-page')).toMatchObject({ anyone: false, groups: true });
  });

  it('a database root keeps to the pages of that database', async () => {
    expect((await drain(notion, ctx(), 'some-database')).items).toEqual([]);
    const roots = await notion.listRoots(ctx());
    expect(roots[0]).toMatchObject({ id: 'workspace', kind: 'workspace' });
  });

  it('errors never carry the token', async () => {
    const c = ctx();
    ws().failNextApi(500, 1);
    const err = await caught(() => notion.listChanges(c, { root: 'workspace', cursor: null }));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain(c.token);
    const dead = await caught(() => notion.listChanges(rig.ctx('notion', { token: 'nobody-issued-this' }), { root: 'workspace', cursor: null }));
    expect(dead?.code).toBe('not_connected');
    expect(dead?.message).not.toContain('nobody-issued-this');
  });
});

function LATER_MINUS(ms: number): number {
  return new Date('2030-01-01T00:00:00.000Z').getTime() - ms;
}

describe('Confluence', () => {
  const ctx = () => rig.ctx('confluence');

  it('offers the spaces of the site', async () => {
    const roots = await confluence.listRoots(ctx());
    expect(roots.map((r) => [r.id, r.name, r.kind])).toEqual([
      ['1001', 'Engineering', 'space'],
      ['1002', 'Public handbook', 'space'],
    ]);
  });

  it('lists a space on the first pass (across several pages), then only what changed or went to the trash', async () => {
    for (let i = 0; i < 60; i++) cf().putPage({ id: `3${String(100 + i)}`, spaceId: '1001', title: `Page ${String(i)}`, body: '<p>x</p>', modified: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z` });
    const first = await drain(confluence, ctx(), '1001');
    expect(first.items).toHaveLength(63);
    expect(first.calls).toBe(2);
    expect(first.items[0]).toMatchObject({ remoteId: '2003', kind: 'md', removed: false }); // newest edit first
    expect(first.items.find((i) => i.remoteId === '2001')).toMatchObject({ name: 'Release process', version: '2026-10-01T09:00:00.000Z' });
    expect(first.items.find((i) => i.remoteId === '2001')!.url).toMatch(/^https?:\/\/.*\/wiki\/spaces\/ENG\/pages\/2001$/);

    expect((await drain(confluence, ctx(), '1001', first.cursor)).items).toEqual([]);

    cf().editPage('2002', { body: '<p>The phone rotates on Mondays and Fridays.</p>' }, '2026-11-01T00:00:00.000Z');
    cf().trashPage('2001', '2026-11-02T00:00:00.000Z');
    const second = await drain(confluence, ctx(), '1001', first.cursor);
    expect(ids(second.items)).toEqual(['-2001', '2002']);
    expect((await drain(confluence, ctx(), '1001', second.cursor)).items).toEqual([]);
    // another space is not touched by any of this
    expect(ids((await drain(confluence, ctx(), '1002')).items)).toEqual(['2004']);
  });

  it('a pass that stops part-way resumes from its cursor', async () => {
    for (let i = 0; i < 60; i++) cf().putPage({ id: `3${String(100 + i)}`, spaceId: '1001', title: `Page ${String(i)}`, body: '<p>x</p>', modified: `2026-09-01T00:${String(i).padStart(2, '0')}:00.000Z` });
    const one = await confluence.listChanges(ctx(), { root: '1001', cursor: null });
    expect(one.next).not.toBeNull();
    const rest = await drain(confluence, ctx(), '1001', one.next);
    expect(one.items.length + rest.items.length).toBe(63);
    expect(new Set([...one.items, ...rest.items].map((i) => i.remoteId)).size).toBe(63);
  });

  it('reads a page as markdown and refuses a trashed one', async () => {
    const page = await confluence.fetch(ctx(), '2001');
    expect(page.kind).toBe('md');
    const md = text(page.bytes);
    expect(md).toContain('# Release process');
    expect(md).toContain('**Tuesdays**');
    expect(md).toContain('- Cut the branch');
    cf().trashPage('2001');
    expect((await caught(() => confluence.fetch(ctx(), '2001')))?.code).toBe('not_found');
  });

  it('is open to everyone only in a public space, with no restriction on the page or above it', async () => {
    const c = ctx();
    // a space for the site's own users only: a group, so not everyone
    expect(await confluence.access(c, '2001')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    // a space anonymous readers may open
    expect(await confluence.access(c, '2004')).toEqual({ anyone: true, domains: [], users: [], groups: false });
    // a restriction on the page itself
    // (a reader context keeps what it learned for a minute, so each question below gets a fresh one)
    cf().restrictPage('2004', true);
    expect(await confluence.access(ctx(), '2004')).toMatchObject({ anyone: false, groups: true });
    cf().restrictPage('2004', false);
    // a restriction on a page above it
    cf().putPage({ id: '2005', spaceId: '1002', title: 'Child', body: '<p>c</p>', parentId: '2003' });
    expect(await confluence.access(ctx(), '2005')).toEqual({ anyone: false, domains: [], users: [], groups: true });
    // gone
    expect(await confluence.access(ctx(), '9999')).toEqual({ anyone: false, domains: [], users: [], groups: true });
  });

  it('a space that cannot be read for its permissions is "not everyone"', async () => {
    const c = ctx();
    cf().data.spaces = cf().data.spaces.filter((s) => s.id !== '1002');
    expect(await confluence.access(c, '2004')).toEqual({ anyone: false, domains: [], users: [], groups: true });
  });

  it('errors never carry the token', async () => {
    const c = ctx();
    cf().server.failNextApi(503, 1);
    const err = await caught(() => confluence.listChanges(c, { root: '1001', cursor: null }));
    expect(err?.code).toBe('provider_down');
    expect(err?.message).not.toContain(c.token);
    const dead = await caught(() => confluence.listRoots(rig.ctx('confluence', { token: 'nobody-issued-this' })));
    expect(dead?.code).toBe('not_connected');
    expect(dead?.message).not.toContain('nobody-issued-this');
  });
});
