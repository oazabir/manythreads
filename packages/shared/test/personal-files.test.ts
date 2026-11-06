import { describe, expect, it } from 'vitest';
import {
  CopyPersonalFileToTeamRequest,
  CreatePersonalFolderRequest,
  DEFAULT_PERSONAL_QUOTA_BYTES,
  OpenPersonalSpaceRequest,
  PERSONAL_SEED_FOLDERS,
  PersonFilesTreeResponse,
  PersonalFile,
  PersonalFileVersionPathParams,
  PersonalShareCheckRequest,
  UpdatePersonalFileRequest,
  UploadPersonalFileQuery,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

// The shapes of P20-02 (Personal files), P20-13 (admin open, deactivate) and P20-14 (sharing out of Personal).

describe('Personal files contract', () => {
  it('seeds the seven folders and a 5 GiB allowance', () => {
    expect(PERSONAL_SEED_FOLDERS).toEqual(['Notes', 'Meetings', 'Inbox', 'Memory', 'Knowledge', 'Routines', 'Action items']);
    expect(DEFAULT_PERSONAL_QUOTA_BYTES).toBe(5 * 1024 ** 3);
  });

  it('an upload names a non-empty folder without dots; conflict defaults to rename', () => {
    expect(UploadPersonalFileQuery.parse({ folderPath: 'Notes/' })).toEqual({ folderPath: 'Notes', conflict: 'rename' });
    expect(UploadPersonalFileQuery.parse({ folderPath: 'Notes/2026', name: 'a.md', conflict: 'version' }).conflict).toBe('version');
    for (const folderPath of ['', '/', '../x', 'a/../b', '.git/x']) expect(UploadPersonalFileQuery.safeParse({ folderPath }).success).toBe(false);
  });

  it('a change names something and refuses extra fields', () => {
    expect(UpdatePersonalFileRequest.safeParse({}).success).toBe(false);
    expect(UpdatePersonalFileRequest.safeParse({ name: 'b.md', owner: 'x' }).success).toBe(false);
    expect(UpdatePersonalFileRequest.parse({ name: ' b.md ' }).name).toBe('b.md');
    expect(UpdatePersonalFileRequest.parse({ folderPath: 'Meetings' }).folderPath).toBe('Meetings');
    expect(CreatePersonalFolderRequest.safeParse({ path: '' }).success).toBe(false);
  });

  it('a version path needs two ids', () => {
    expect(PersonalFileVersionPathParams.safeParse({ fileId: uuid(1), versionId: uuid(2) }).success).toBe(true);
    expect(PersonalFileVersionPathParams.safeParse({ fileId: uuid(1) }).success).toBe(false);
  });

  it('sharing out: strict bodies, two destinations', () => {
    expect(PersonalShareCheckRequest.safeParse({ destination: 'team_files', teamSlug: 'eng' }).success).toBe(true);
    expect(PersonalShareCheckRequest.safeParse({ destination: 'public', teamSlug: 'eng' }).success).toBe(false);
    expect(CopyPersonalFileToTeamRequest.safeParse({ teamSlug: 'eng', path: 'docs/a.md' }).success).toBe(true);
    expect(CopyPersonalFileToTeamRequest.safeParse({ teamSlug: 'eng', path: '../a.md' }).success).toBe(false);
    expect(CopyPersonalFileToTeamRequest.safeParse({ teamSlug: 'eng', path: 'a.md', extra: 1 }).success).toBe(false);
  });

  it('an open needs a reason of 1 to 300 characters', () => {
    expect(OpenPersonalSpaceRequest.parse({ reason: '  Offboarding review ' }).reason).toBe('Offboarding review');
    expect(OpenPersonalSpaceRequest.safeParse({ reason: '   ' }).success).toBe(false);
    expect(OpenPersonalSpaceRequest.safeParse({ reason: 'x'.repeat(301) }).success).toBe(false);
    expect(OpenPersonalSpaceRequest.safeParse({ reason: 'ok', until: 'tomorrow' }).success).toBe(false);
  });

  it('a Personal file and the admin tree carry what the screens need', () => {
    const file = {
      id: uuid(1),
      ownerPersonId: uuid(2),
      space: `person:${uuid(2)}`,
      folderPath: 'Notes',
      name: 'a.md',
      path: 'Notes/a.md',
      size: 3,
      mime: 'text/markdown',
      sha256: 'a'.repeat(64),
      createdAt: '2026-11-06T10:00:00.000Z',
      updatedAt: '2026-11-06T10:00:00.000Z',
      updatedBy: uuid(3),
      versionCount: 0,
      contentUrl: `/api/files/${uuid(1)}/content`,
    };
    expect(PersonalFile.parse(file)).toEqual(file);
    expect(PersonalFile.safeParse({ ...file, space: 'person:nope' }).success).toBe(false);
    const tree = {
      path: '',
      validUntil: '2026-11-06T11:00:00.000Z',
      displayName: 'Nadia',
      folder: { path: '', source: 'attachment', readOnly: true, readOnlyReason: 'admin_view', managedBy: null, channelId: null },
      entries: [],
      truncated: false,
    };
    expect(PersonFilesTreeResponse.parse(tree)).toEqual(tree);
  });
});
