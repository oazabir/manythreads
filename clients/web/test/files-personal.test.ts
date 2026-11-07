import { beforeEach, describe, expect, it } from 'vitest';
import { rowEntries } from '../src/screens/files/actions';
import type { Perms } from '../src/screens/files/backend';
import { bytesLabel, DEFAULT_SORT, firstDir, rowKey, sortRowsBy, treeShows, type FileRow, type Sort } from '../src/screens/files/model';
import { createPersonalBackend, CURRENT_VERSION } from '../src/screens/files/personalBackend';
import { mockOpenSpace, mockOpens, mockPersonalTransport, resetMockPersonal } from '../src/screens/files/personalMock';
import { lockReason, WHY } from '../src/screens/files/ReadOnlyWhy';
import { NONE, all, only, prune, range, toggle } from '../src/screens/files/selection';
import { adminViewKey, adminViewPerson, isPersonalKey, parsePanelId, personalPanelId, spaceHref } from '../src/screens/files/spaces';
import type { TeamFiles } from '../src/screens/files/store';

const perms = (id = 'p1'): Perms => ({ leadsTeam: false, isAdmin: false, personId: id, personName: 'Nadia', who: (a) => (a ? { id: a, name: 'Nadia', kind: 'person' } : null) });

const row = (over: Partial<FileRow> & { path: string }): FileRow => ({
  name: over.path.slice(over.path.lastIndexOf('/') + 1), kind: 'file', store: 'personal', size: 1, mime: 'text/markdown', modifiedAt: null, by: null, where: null,
  readOnly: false, readOnlyReason: null, managedBy: null, fileId: 'f1', channelId: null, blobSha: null, contentUrl: 'data:text/plain,x', ...over,
});

const store = (personId = 'p1', admin = false) => {
  const p = perms(personId);
  return createPersonalBackend(mockPersonalTransport(p, admin), p, admin ? { admin: true } : {});
};

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];
  it('toggles one row and remembers where the range starts', () => {
    const s = toggle(NONE, 'b');
    expect([...s.keys]).toEqual(['b']);
    expect(s.anchor).toBe('b');
    expect(toggle(s, 'b').keys.size).toBe(0);
  });
  it('picks a range between the anchor and the clicked row, both ways', () => {
    const s = only('b');
    expect([...range(s, order, 'd').keys]).toEqual(['b', 'c', 'd']);
    expect([...range(only('d'), order, 'b').keys].sort()).toEqual(['b', 'c', 'd']);
  });
  it('keeps the earlier picks when a range is added to them', () => {
    const s = toggle(toggle(NONE, 'a'), 'e');
    expect([...range({ ...s, anchor: 'c' }, order, 'd', true).keys].sort()).toEqual(['a', 'c', 'd', 'e']);
  });
  it('selects everything and drops what left the folder', () => {
    const everything = all(order);
    expect(everything.keys.size).toBe(5);
    const pruned = prune(everything, ['a', 'c']);
    expect([...pruned.keys]).toEqual(['a', 'c']);
    expect(prune(pruned, ['a', 'c'])).toBe(pruned);
    expect(prune(only('z'), ['a']).keys.size).toBe(0);
  });
});

describe('sorting by column', () => {
  const rows = [
    row({ path: 'F/b.md', size: 30, modifiedAt: '2026-10-02T10:00:00Z', by: { id: '1', name: 'Zed', kind: 'person' } }),
    row({ path: 'F/a.md', size: 10, modifiedAt: '2026-10-03T10:00:00Z', by: { id: '2', name: 'Amy', kind: 'bot' } }),
    row({ path: 'F/c.md', size: null as unknown as number, modifiedAt: null }),
    row({ path: 'F/dir', kind: 'folder', size: null, fileId: null }),
  ];
  const names = (sort: Sort): string[] => sortRowsBy(rows, sort).map((r) => r.name);
  it('keeps folders first whatever the column', () => {
    expect(names({ key: 'name', dir: 'asc' })).toEqual(['dir', 'a.md', 'b.md', 'c.md']);
    expect(names({ key: 'name', dir: 'desc' })).toEqual(['dir', 'c.md', 'b.md', 'a.md']);
  });
  it('sorts When newest first by default and puts a missing value last in either direction', () => {
    expect(names(DEFAULT_SORT)).toEqual(['dir', 'a.md', 'b.md', 'c.md']);
    expect(names({ key: 'modified', dir: 'asc' })).toEqual(['dir', 'b.md', 'a.md', 'c.md']);
  });
  it('sorts by size and by who last changed it', () => {
    expect(names({ key: 'size', dir: 'asc' })).toEqual(['dir', 'a.md', 'b.md', 'c.md']);
    expect(names({ key: 'size', dir: 'desc' })).toEqual(['dir', 'b.md', 'a.md', 'c.md']);
    expect(names({ key: 'by', dir: 'asc' })).toEqual(['dir', 'a.md', 'b.md', 'c.md']);
  });
  it('starts text columns A to Z and When and Size biggest first', () => {
    expect(firstDir('name')).toBe('asc');
    expect(firstDir('modified')).toBe('desc');
    expect(firstDir('size')).toBe('desc');
  });
  it('keys a row by its file id, else its path', () => {
    expect(rowKey(row({ path: 'A/x.md', fileId: 'abc' }))).toBe('abc');
    expect(rowKey(row({ path: 'A/x', kind: 'folder', fileId: null }))).toBe('A/x');
  });
});

describe('sizes and spaces', () => {
  it('names bytes in the unit a person reads', () => {
    expect(bytesLabel(512)).toBe('512 B');
    expect(bytesLabel(12_300)).toBe('12 KB');
    expect(bytesLabel(4_400_000)).toBe('4.2 MB');
    expect(bytesLabel(310 * 1_048_576)).toBe('310 MB');
    expect(bytesLabel(5 * 1_073_741_824)).toBe('5.0 GB');
  });
  it('tells Personal, a team and an admin view apart', () => {
    expect(isPersonalKey('~me')).toBe(true);
    expect(isPersonalKey('engineering')).toBe(false);
    expect(adminViewPerson(adminViewKey('p9'))).toBe('p9');
    expect(adminViewPerson('~me')).toBeNull();
  });
  it('builds the link of each space', () => {
    expect(spaceHref('~me')).toBe('/files');
    expect(spaceHref('~me', { folder: 'Notes', open: 'Notes/a.md' })).toBe('/files?path=Notes&open=Notes%2Fa.md');
    expect(spaceHref('engineering', { folder: 'pages' })).toBe('/t/engineering/files?path=pages');
  });
  it('names a Personal file in a panel entry by ~me/<path>', () => {
    expect(personalPanelId('Notes/a.md')).toBe('~me/Notes/a.md');
    expect(parsePanelId('~me/Notes/a.md')).toEqual({ space: 'personal', path: 'Notes/a.md' });
    expect(parsePanelId('pages/a.md')).toEqual({ space: 'team', path: 'pages/a.md' });
  });
  it('keeps channel attachments out of the tree but shows Personal files there', () => {
    expect(treeShows(row({ path: 'channels/dev/a.pdf', store: 'attachments' }))).toBe(false);
    expect(treeShows(row({ path: 'Notes/a.md' }))).toBe(true);
    expect(treeShows(row({ path: 'channels/dev', kind: 'folder', store: 'attachments' }))).toBe(true);
  });
});

describe('what a row offers', () => {
  const files = { slug: '~me', teamName: 'Personal', space: 'personal', personal: {} } as unknown as TeamFiles;
  const ids = (r: FileRow): string[] => rowEntries(r, files, { start: () => undefined, history: () => undefined }).map((e) => e.id);
  it('offers a Personal note version history, download, rename, move, send to a team and delete', () => {
    expect(ids(row({ path: 'Notes/a.md' }))).toEqual(['history', 'download', 'rename', 'move', 'share', 'delete']);
  });
  it('offers nothing that changes anything in an admin view', () => {
    const r = row({ path: 'Notes/a.md', readOnly: true, readOnlyReason: 'admin_view' });
    expect(ids(r)).toEqual(['history', 'download']);
    expect(lockReason(r)).toBe('admin_view');
  });
  it('lets a starting folder stay and an empty one go', () => {
    expect(ids(row({ path: 'Notes', kind: 'folder', fileId: null }))).toEqual([]);
    expect(ids(row({ path: 'Projects', kind: 'folder', fileId: null }))).toEqual(['delete']);
  });
  it('shows a lock for a file that cannot be changed, but not for an attachment', () => {
    expect(lockReason(row({ path: 'a', readOnly: true, readOnlyReason: 'change_by_pull_request' }))).toBe('change_by_pull_request');
    expect(lockReason(row({ path: 'a', readOnly: true, readOnlyReason: 'attachment' }))).toBeNull();
    expect(lockReason(row({ path: 'a' }))).toBeNull();
    for (const w of Object.values(WHY)) expect(w.body.length).toBeGreaterThan(20);
  });
});

describe('the Personal store over the in-memory transport', () => {
  beforeEach(() => resetMockPersonal());

  it('lists the starting folders at the top and the notes of a folder with their authors', async () => {
    const s = store();
    const top = await s.list('');
    expect(top.rows.every((r) => r.kind === 'folder' && r.store === 'personal')).toBe(true);
    expect(top.rows.map((r) => r.name)).toContain('Notes');
    const notes = await s.list('Notes');
    expect(notes.folder.store).toBe('personal');
    expect(notes.rows.map((r) => r.name)).toContain('standup-notes.md');
    expect(notes.rows.every((r) => r.contentUrl !== null)).toBe(true);
  });

  it('marks the Memory folder as kept by the person memory', async () => {
    const mem = (await store().list('')).rows.find((r) => r.name === 'Memory');
    expect(mem?.managedBy).toBe('personal_memory');
  });

  it('uploads a file into a folder, and keeps both when the name is taken', async () => {
    const s = store();
    await s.upload({ path: 'Notes', channelId: null }, new File(['hello'], 'plan.txt', { type: 'text/plain' }), () => undefined);
    await s.upload({ path: 'Notes', channelId: null }, new File(['again'], 'plan.txt', { type: 'text/plain' }), () => undefined);
    const names = (await s.list('Notes')).rows.map((r) => r.name);
    expect(names).toContain('plan.txt');
    expect(names).toContain('plan (2).txt');
  });

  it('refuses a file at the top, where Personal keeps only folders', async () => {
    await expect(store().upload({ path: '', channelId: null }, new File(['x'], 'a.txt'), () => undefined)).rejects.toThrow(/folder/i);
  });

  it('keeps the earlier text as a version when a note is saved', async () => {
    const s = store();
    const note = (await s.list('Notes')).rows.find((r) => r.name === 'ideas.md') as FileRow;
    const content = s.open(note);
    expect(content.save).not.toBeNull();
    await content.save?.('# Ideas\n\nChanged.\n');
    const after = (await s.list('Notes')).rows.find((r) => r.name === 'ideas.md') as FileRow;
    const history = await s.history('Notes/ideas.md');
    expect(history).toHaveLength(2);
    expect(history[0]?.sha).toBe(CURRENT_VERSION);
    expect(history[1]?.parentSha).toBeNull();
    const diff = await s.diff('Notes/ideas.md', history[0] as never);
    expect(diff.additions).toBeGreaterThan(0);
    expect(await s.version('Notes/ideas.md', history[1]?.sha ?? null)).toContain('A weekly digest');
    expect(after.fileId).toBe(note.fileId);
  });

  it('restores an earlier version and refuses to restore the current one twice', async () => {
    const s = store();
    const history = await s.history('Notes/standup-notes.md');
    expect(history.length).toBeGreaterThan(1);
    await s.restore('Notes/standup-notes.md', history[1] as never, 'x');
    const after = await s.history('Notes/standup-notes.md');
    expect(after.length).toBeGreaterThan(history.length - 1);
    await expect(s.restore('Notes/standup-notes.md', after[0] as never, 'x')).resolves.toBeUndefined();
  });

  it('renames and moves a file in one call, and says when the name is taken', async () => {
    const s = store();
    const ideas = (await s.list('Notes')).rows.find((r) => r.name === 'ideas.md') as FileRow;
    await s.move(ideas, 'Knowledge/ideas-2026.md');
    expect((await s.list('Knowledge')).rows.map((r) => r.name)).toContain('ideas-2026.md');
    expect((await s.list('Notes')).rows.map((r) => r.name)).not.toContain('ideas.md');
    const standup = (await s.list('Notes')).rows.find((r) => r.name === 'standup-notes.md') as FileRow;
    await s.upload({ path: 'Knowledge', channelId: null }, new File(['x'], 'standup-notes.md'), () => undefined);
    await expect(s.move(standup, 'Knowledge/standup-notes.md')).rejects.toThrow(/already/i);
  });

  it('removes a file, an empty folder, and keeps a starting folder', async () => {
    const s = store();
    const glossary = (await s.list('Knowledge')).rows.find((r) => r.name === 'glossary.md') as FileRow;
    await s.remove(glossary);
    expect((await s.list('Knowledge')).rows.map((r) => r.name)).not.toContain('glossary.md');
    await s.createFolder('Projects/Launch');
    const launch = (await s.list('Projects')).rows.find((r) => r.name === 'Launch') as FileRow;
    await s.remove(launch);
    expect((await s.list('Projects')).rows.map((r) => r.name)).not.toContain('Launch');
    const notes = (await s.list('')).rows.find((r) => r.name === 'Notes') as FileRow;
    await expect(s.remove(notes)).rejects.toThrow(/stays|start/i);
  });

  it('reports the allowance and what the data rules say before a file is sent to a team', async () => {
    const s = store();
    const usage = await s.personal.usage();
    expect(usage.quotaBytes).toBe(5 * 1_073_741_824);
    expect(usage.usedBytes).toBeGreaterThan(0);
    const note = (await s.list('Notes')).rows[0] as FileRow;
    const check = await s.personal.shareCheck(note, 'team_files', 'engineering');
    expect(['allow', 'redact', 'require_approval', 'block']).toContain(check.outcome);
    const copied = await s.personal.copyToTeam(note, 'engineering', 'pages/from-personal.md');
    expect(copied.path).toBe('pages/from-personal.md');
  });

  it('gives an admin a read-only tree that says who it is and until when', async () => {
    const s = store('p2', true);
    const top = await s.list('Notes');
    expect(top.rows.every((r) => r.readOnly && r.readOnlyReason === 'admin_view')).toBe(true);
    const meta = s.personal.admin?.();
    expect(meta?.displayName).toBe('Nadia');
    expect(Date.parse(meta?.validUntil ?? '')).toBeGreaterThan(Date.now());
  });

  it('keeps two people apart', async () => {
    await store('p1').upload({ path: 'Notes', channelId: null }, new File(['x'], 'mine.txt'), () => undefined);
    expect((await store('p2').list('Notes')).rows.map((r) => r.name)).not.toContain('mine.txt');
  });
});

describe('the admin open', () => {
  it('opens for an hour and shows up in the person own list with the reason', () => {
    const before = mockOpens().length;
    const open = mockOpenSpace('Priya Raman', 'Recovering the handover notes.');
    expect(Date.parse(open.validUntil) - Date.now()).toBeGreaterThan(59 * 60_000);
    const list = mockOpens();
    expect(list).toHaveLength(before + 1);
    expect(list[0]).toMatchObject({ adminName: 'Priya Raman', reason: 'Recovering the handover notes.', active: true });
  });
});
