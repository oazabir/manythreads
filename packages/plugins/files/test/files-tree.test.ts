import { FileMeta, type FilesTreeEntry, GetFilesTreeResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type FilesWorld } from './world.ts';

// The Files tree (PLAN P4-06, criteria 6 and 9): repo entries and `channels/<name>/` attachments in one listing with one row shape; access per folder
// (team membership for the repo, the channel's ACL under channels/); read-only for a member on the four guarded paths.

const { omar, nadia, priya, sameera, tariq, lena } = personas;
vi.setConfig({ testTimeout: 60_000 });

let w: FilesWorld;
let dev = '';
let secret = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  // a private channel of Omar's, with a file of its own
  const created = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'eng-leads', private: true });
  expect(created.status).toBe(201);
  secret = created.body.channel.id;
  expect((await w.upload(omar, secret, Buffer.from('salaries'), { name: 'budget.txt', type: 'text/plain' })).status).toBe(201);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const tree = (who: typeof omar | null, slug: string, path = '', extra = '') =>
  w.call(who, 'GET', `/api/teams/${slug}/files/tree?path=${encodeURIComponent(path)}${extra}`);
const ok = (res: { status: number; body: unknown }): GetFilesTreeResponse => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return GetFilesTreeResponse.parse(res.body);
};
const row = (t: GetFilesTreeResponse, name: string): FilesTreeEntry => {
  const found = t.entries.find((e) => e.name === name);
  expect(found, `${name} in ${t.entries.map((e) => e.name).join(',')}`).toBeDefined();
  return found!;
};
const commit = async (who: typeof omar, changes: unknown[], message: string): Promise<void> => {
  const res = await w.call(who, 'POST', '/api/teams/engineering/repo/commit', { changes, message });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

describe('one tree over both stores', () => {
  it('the root lists the repo layout and the channels folder, folders first, one row shape', async () => {
    const root = ok(await tree(nadia, 'engineering'));
    expect(root.path).toBe('');
    expect(root.truncated).toBe(false);
    expect(root.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'folder:bots',
      'folder:channels',
      'folder:knowledge',
      'folder:memory',
      'folder:pages',
      'folder:routines',
      'folder:skills',
      'file:TEAM.md',
    ]);
    const keys = new Set(root.entries.map((e) => Object.keys(e).sort().join(',')));
    expect(keys.size).toBe(1);
    expect(row(root, 'channels')).toMatchObject({ source: 'attachment', kind: 'folder', path: 'channels', readOnly: true, readOnlyReason: 'attachment' });
    expect(row(root, 'pages')).toMatchObject({ source: 'repo', kind: 'folder', path: 'pages', readOnly: false, readOnlyReason: null, managedBy: null, size: null, mime: null, contentUrl: null });
    expect(row(root, 'TEAM.md')).toMatchObject({ source: 'repo', kind: 'file', mime: 'text/markdown', fileId: null, channelId: null, updatedBy: null });
    expect(row(root, 'TEAM.md').blobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(root.folder).toMatchObject({ path: '', source: 'repo', readOnly: false });
  });

  it('a page and a channel attachment show up with identical rows: a repo file under pages/, an upload under channels/dev', async () => {
    await commit(nadia, [{ op: 'put', path: 'pages/runbook.md', content: '# Runbook\n' }], 'Add the runbook');
    const up = FileMeta.parse((await w.upload(nadia, dev, Buffer.from('%PDF-1.7\n% report\n'), { name: 'Q3 report.pdf', type: 'application/pdf' })).body);

    const pages = ok(await tree(nadia, 'engineering', 'pages'));
    expect(pages.entries.map((e) => e.name)).toEqual(['runbook.md']);
    const page = pages.entries[0]!;
    expect(page).toMatchObject({
      kind: 'file',
      path: 'pages/runbook.md',
      size: 10,
      mime: 'text/markdown',
      updatedBy: nadia.actorId,
      source: 'repo',
      readOnly: false,
      fileId: null,
      channelId: null,
      contentUrl: '/api/teams/engineering/repo/content?path=pages%2Frunbook.md',
    });
    expect(page.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const files = ok(await tree(nadia, 'engineering', 'channels/dev'));
    expect(files.folder).toMatchObject({ path: 'channels/dev', source: 'attachment', channelId: dev, readOnly: false });
    const att = files.entries.find((e) => e.name === 'Q3 report.pdf')!;
    expect(att).toMatchObject({
      kind: 'file',
      path: 'channels/dev/Q3 report.pdf',
      size: 18,
      mime: 'application/pdf',
      updatedBy: nadia.actorId,
      source: 'attachment',
      readOnly: true,
      readOnlyReason: 'attachment',
      managedBy: null,
      fileId: up.id,
      channelId: dev,
      blobSha: null,
      contentUrl: `/api/files/${up.id}/content`,
    });
    expect(Object.keys(att).sort()).toEqual(Object.keys(page).sort());

    // the URLs work
    const attBytes = await w.download(nadia, up.id);
    expect(attBytes.status).toBe(200);
    const pageBytes = await fetch(`${w.server.url}${page.contentUrl}`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }) } });
    expect(await pageBytes.text()).toBe('# Runbook\n');
    expect(pageBytes.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  });

  it('channels/ lists the channels the caller can read (a private channel only for its members), each a folder with its newest upload', async () => {
    const asNadia = ok(await tree(nadia, 'engineering', 'channels'));
    expect(asNadia.folder).toMatchObject({ path: 'channels', readOnly: true });
    expect(asNadia.entries.every((e) => e.kind === 'folder' && e.source === 'attachment' && e.channelId !== null)).toBe(true);
    const names = asNadia.entries.map((e) => e.name);
    expect(names).toContain('dev');
    expect(names).not.toContain('eng-leads');
    expect(row(asNadia, 'dev').updatedBy).toBe(nadia.actorId);
    const asOmar = ok(await tree(omar, 'engineering', 'channels'));
    expect(asOmar.entries.map((e) => e.name)).toContain('eng-leads');
  });

  it('memory/ shows its two subfolders, managed by the team memory; facts stay editable', async () => {
    const memory = ok(await tree(nadia, 'engineering', 'memory'));
    expect(memory.entries.map((e) => e.name)).toEqual(['facts', 'journal']);
    expect(memory.folder).toMatchObject({ managedBy: 'team_memory', readOnly: false });
    expect(memory.entries.every((e) => e.managedBy === 'team_memory' && e.readOnly === false)).toBe(true);
    expect(row(ok(await tree(nadia, 'engineering')), 'memory').managedBy).toBe('team_memory');
    // an empty folder (only its placeholder) lists nothing
    expect(ok(await tree(nadia, 'engineering', 'memory/facts')).entries).toEqual([]);
  });
});

describe('read-only for a member on the four guarded paths (criterion 9)', () => {
  it('Priya (member) sees bots/, skills/, routines/ and TEAM.md as change by pull request; Omar (lead) sees them editable', async () => {
    const asPriya = ok(await tree(priya, 'engineering'));
    for (const name of ['bots', 'skills', 'routines', 'TEAM.md']) {
      expect(row(asPriya, name), name).toMatchObject({ readOnly: true, readOnlyReason: 'change_by_pull_request' });
    }
    for (const name of ['pages', 'knowledge', 'memory']) expect(row(asPriya, name), name).toMatchObject({ readOnly: false, readOnlyReason: null });
    const asOmar = ok(await tree(omar, 'engineering'));
    for (const name of ['bots', 'skills', 'routines', 'TEAM.md']) expect(row(asOmar, name), name).toMatchObject({ readOnly: false, readOnlyReason: null });
    // inside the folder, and the folder's own flag
    const bots = ok(await tree(priya, 'engineering', 'bots'));
    expect(bots.folder).toMatchObject({ path: 'bots', readOnly: true, readOnlyReason: 'change_by_pull_request' });
    expect(ok(await tree(omar, 'engineering', 'bots')).folder).toMatchObject({ readOnly: false });
    // and a write to them is 403 (the writer, not this tree, decides)
    const res = await w.call(priya, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: 'TEAM.md', content: 'x' }], message: 'x' });
    expect(res.status).toBe(403);
  });
});

describe('access per folder (criterion 6)', () => {
  it('Lena (guest) gets 403 on #dev attachments, and on the tree; Nadia gets 403 on Marketing’s tree; Sameera on Engineering’s', async () => {
    expect((await tree(lena, 'engineering', 'channels/dev')).status).toBe(403);
    expect((await tree(lena, 'engineering', 'channels')).status).toBe(403);
    expect((await tree(lena, 'engineering')).status).toBe(403);
    expect((await tree(nadia, 'marketing')).status).toBe(403);
    expect((await tree(nadia, 'marketing', 'pages')).status).toBe(403);
    expect((await tree(sameera, 'engineering', 'channels/dev')).status).toBe(403);
    expect((await tree(null, 'engineering')).status).toBe(401);
  });

  it('a channel the caller cannot read is 403 whether it is private or does not exist; a member of two teams reads both', async () => {
    expect((await tree(nadia, 'engineering', 'channels/eng-leads')).status).toBe(403);
    expect((await tree(nadia, 'engineering', 'channels/no-such-channel')).status).toBe(403);
    const leads = ok(await tree(omar, 'engineering', 'channels/eng-leads'));
    expect(leads.folder.channelId).toBe(secret);
    expect(leads.entries.map((e) => e.name)).toEqual(['budget.txt']);
    // Nadia reaches neither the folder nor, by guessing, the file
    expect((await tree(nadia, 'engineering', 'channels/eng-leads')).status).toBe(403);
    expect((await tree(priya, 'marketing')).status).toBe(200);
    expect((await tree(tariq, 'marketing', 'channels')).status).toBe(200);
  });

  it('a workspace admin gets 404 for a team that does not exist; anyone else 403', async () => {
    expect((await tree(omar, 'no-such-team')).status).toBe(404);
    expect((await tree(nadia, 'no-such-team')).status).toBe(403);
  });

  it('attachment folders have no sub-folders; a missing repo folder or a file asked as a folder is 404; paths are strict', async () => {
    expect((await tree(nadia, 'engineering', 'channels/dev/inner')).status).toBe(404);
    expect((await tree(nadia, 'engineering', 'pages/nothing')).status).toBe(404);
    expect((await tree(nadia, 'engineering', 'TEAM.md')).status).toBe(404);
    expect((await tree(nadia, 'engineering', '../etc')).status).toBe(400);
    expect((await tree(nadia, 'engineering', 'pages', '&limit=0')).status).toBe(400);
  });
});

describe('long folders', () => {
  it('limit cuts the list and says so', async () => {
    for (let i = 0; i < 4; i += 1) await w.upload(nadia, dev, Buffer.from(`file ${i}`), { name: `note-${i}.txt`, type: 'text/plain' });
    const cut = ok(await tree(nadia, 'engineering', 'channels/dev', '&limit=3'));
    expect(cut.entries).toHaveLength(3);
    expect(cut.truncated).toBe(true);
    const all = ok(await tree(nadia, 'engineering', 'channels/dev'));
    expect(all.truncated).toBe(false);
    expect(all.entries.map((e) => e.name)).toEqual([...all.entries.map((e) => e.name)].sort());
  });
});
