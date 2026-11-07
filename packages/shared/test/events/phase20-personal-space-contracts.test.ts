import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { UpdateWorkspaceMemberRequest, eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P20-02 and P20-13 (`pnpm test:events`): the events of a Personal space. None carries a file name, a path, bytes or the reason an admin gave.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('personal.space.opened', () => {
  const valid = {
    type: 'personal.space.opened',
    schemaVersion: 1,
    workspaceId: uuid(1),
    personId: uuid(2),
    adminActorId: uuid(3),
    accessId: uuid(4),
    validUntil: '2026-11-06T11:00:00.000Z',
  };
  it('is registered at version 1 and has no field for the reason', () => {
    expect(Object.keys(eventRegistry['personal.space.opened'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(Object.keys(valid)).not.toContain('reason');
  });
  it.each([['personId', { personId: 'x' }], ['accessId', { accessId: 7 }], ['validUntil', { validUntil: 'soon' }]])('refuses a bad %s', (path, patch) => {
    expect(failsAt({ ...valid, ...patch })).toContain(path);
  });
});

describe('personal.space.exported', () => {
  const valid = { type: 'personal.space.exported', schemaVersion: 1, workspaceId: uuid(1), personId: uuid(2), adminActorId: uuid(3), accessId: uuid(4), fileCount: 12, bytes: 4096 };
  it('carries counts only', () => {
    expect(Object.keys(eventRegistry['personal.space.exported'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });
  it.each([['fileCount', { fileCount: -1 }], ['bytes', { bytes: 1.5 }]])('refuses a bad %s', (path, patch) => {
    expect(failsAt({ ...valid, ...patch })).toContain(path);
  });
});

describe('files.file.restored and the space field of uploads and deletes', () => {
  const restored = { type: 'files.file.restored', schemaVersion: 1, workspaceId: uuid(1), fileId: uuid(2), versionId: uuid(3), space: `person:${uuid(4)}`, restoredBy: uuid(5) };
  it('restored has ids and a space, no name', () => {
    expect(parseEvent(restored)).toEqual(restored);
    expect(failsAt({ ...restored, space: 'person:x' })).toContain('space');
  });
  it('upload and delete accept an optional space and still parse without one', () => {
    const uploaded = { type: 'files.file.uploaded', schemaVersion: 1, workspaceId: uuid(1), channelId: null, teamId: null, fileId: uuid(2), uploaderId: uuid(3), name: '', size: 3, mime: 'text/plain' };
    expect(parseEvent(uploaded)).toEqual(uploaded);
    expect(parseEvent({ ...uploaded, space: `person:${uuid(4)}` })).toMatchObject({ space: `person:${uuid(4)}` });
    const deleted = { type: 'files.file.deleted', schemaVersion: 1, workspaceId: uuid(1), channelId: null, teamId: null, fileId: uuid(2), deletedBy: uuid(3) };
    expect(parseEvent(deleted)).toEqual(deleted);
    expect(failsAt({ ...deleted, space: 'nope' })).toContain('space');
  });
});

describe('workspace.member.status_changed and the deactivate request', () => {
  const valid = { type: 'workspace.member.status_changed', schemaVersion: 1, workspaceId: uuid(1), personId: uuid(2), previousStatus: 'active', status: 'suspended', changedBy: uuid(3) };
  it('parses and refuses an unknown status', () => {
    expect(parseEvent(valid)).toEqual(valid);
    expect(failsAt({ ...valid, status: 'deleted' })).toContain('status');
  });

  it('deactivating is a status on the member route; the body must change something', () => {
    expect(UpdateWorkspaceMemberRequest.parse({ status: 'suspended' })).toEqual({ status: 'suspended' });
    expect(UpdateWorkspaceMemberRequest.parse({ role: 'member', status: 'active' }).role).toBe('member');
    expect(UpdateWorkspaceMemberRequest.safeParse({}).success).toBe(false);
    expect(UpdateWorkspaceMemberRequest.safeParse({ status: 'gone' }).success).toBe(false);
  });
});
