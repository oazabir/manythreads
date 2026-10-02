import { describe, expect, it } from 'vitest';
import {
  FilesTreeEntry,
  GetFilesTreeQuery,
  GetRepoDiffQuery,
  GetRepoHistoryQuery,
  PagePath,
  RestoreRepoFileRequest,
  WritePageRequest,
  repoMimeOf,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

// The shapes of the Files tree, history, diff, restore and pages.write (PLAN P4-06..P4-08).

const repoRow = {
  kind: 'file',
  path: 'pages/a.md',
  name: 'a.md',
  size: 3,
  mime: 'text/markdown',
  updatedAt: '2026-10-02T10:00:00.000Z',
  updatedBy: uuid(1),
  source: 'repo',
  readOnly: false,
  readOnlyReason: null,
  managedBy: null,
  fileId: null,
  channelId: null,
  blobSha: 'a'.repeat(40),
  contentUrl: '/api/teams/engineering/repo/content?path=pages%2Fa.md',
};

describe('FilesTreeEntry', () => {
  it('has one row shape for repo entries and attachments', () => {
    expect(FilesTreeEntry.parse(repoRow)).toEqual(repoRow);
    const attachment = { ...repoRow, path: 'channels/dev/spec.pdf', name: 'spec.pdf', mime: 'application/pdf', source: 'attachment', readOnly: true, readOnlyReason: 'attachment', fileId: uuid(2), channelId: uuid(3), blobSha: null, contentUrl: `/api/files/${uuid(2)}/content` };
    expect(Object.keys(FilesTreeEntry.parse(attachment)).sort()).toEqual(Object.keys(FilesTreeEntry.parse(repoRow)).sort());
  });
  it('refuses an unknown reason, kind or source', () => {
    expect(FilesTreeEntry.safeParse({ ...repoRow, readOnlyReason: 'because' }).success).toBe(false);
    expect(FilesTreeEntry.safeParse({ ...repoRow, kind: 'dir' }).success).toBe(false);
    expect(FilesTreeEntry.safeParse({ ...repoRow, source: 'git' }).success).toBe(false);
  });
});

describe('queries and requests', () => {
  it('reads a folder path strictly', () => {
    expect(GetFilesTreeQuery.parse({}).path).toBe('');
    expect(GetFilesTreeQuery.parse({ path: 'channels/dev/' }).path).toBe('channels/dev');
    expect(GetFilesTreeQuery.safeParse({ path: '../x' }).success).toBe(false);
    expect(GetRepoHistoryQuery.parse({ path: 'pages/a.md', limit: '5' }).limit).toBe(5);
    expect(GetRepoDiffQuery.parse({ path: 'pages/a.md' }).to).toBe('main');
  });
  it('restore and pages.write are strict', () => {
    expect(RestoreRepoFileRequest.safeParse({ path: 'pages/a.md', sha: 'b'.repeat(40), extra: 1 }).success).toBe(false);
    expect(WritePageRequest.parse({ mode: 'create', path: 'pages/x.md', content: 'hi' }).mode).toBe('create');
    expect(WritePageRequest.safeParse({ mode: 'create', path: 'pages/x.md', content: 'hi', teamId: 'x' }).success).toBe(false);
    expect(WritePageRequest.safeParse({ mode: 'merge', path: 'pages/x.md', content: 'hi' }).success).toBe(false);
  });
  it('a page lives under pages/', () => {
    expect(PagePath.parse('pages/a/b.md')).toBe('pages/a/b.md');
    for (const bad of ['TEAM.md', 'bots/x/BOT.md', 'pages', 'pages/', 'pagesx/a.md', 'pages/../TEAM.md', 'Pages/a.md']) expect(PagePath.safeParse(bad).success, bad).toBe(false);
  });
  it('maps extensions to types', () => {
    expect(repoMimeOf('pages/a.md')).toBe('text/markdown');
    expect(repoMimeOf('pages/logo.SVG')).toBe('image/svg+xml');
    expect(repoMimeOf('Makefile')).toBe('text/plain');
    expect(repoMimeOf('a/.hidden')).toBe('text/plain');
  });
});
