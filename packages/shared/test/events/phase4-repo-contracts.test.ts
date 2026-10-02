import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of the team repo (PLAN P4-02, `pnpm test:events`): `repo.repo.committed` has a registered v1 schema that accepts what the writer
// emits (ids, the subject line and the changed paths), refuses what breaks the contract, and never carries file content. The repo-git plugin's
// own `test/events` file proves the writer stores this shape.

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const valid = {
  type: 'repo.repo.committed',
  schemaVersion: 1,
  workspaceId: uuid(1),
  teamId: uuid(2),
  sha: sha(10),
  parentSha: sha(9),
  authorId: uuid(3),
  coAuthorIds: [uuid(4)],
  subject: 'Add the runbook',
  paths: [
    { path: 'pages/runbook.md', op: 'put' },
    { path: 'pages/old.md', op: 'delete' },
  ],
};
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('repo.repo.committed', () => {
  it('is registered at version 1 and accepts what the writer emits', () => {
    expect(Object.keys(eventRegistry['repo.repo.committed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });

  it('accepts a first commit made by the system (no author, no parent, no co-authors)', () => {
    expect(parseEvent({ ...valid, parentSha: null, authorId: null, coAuthorIds: [] })).toMatchObject({ authorId: null, parentSha: null });
  });

  it.each([
    ['sha', { sha: 'main' }],
    ['sha', { sha: sha(10).toUpperCase() }],
    ['parentSha', { parentSha: 'abc' }],
    ['teamId', { teamId: 'engineering' }],
    ['authorId', { authorId: 'omar' }],
    ['coAuthorIds.0', { coAuthorIds: ['tariq'] }],
    ['paths.0.op', { paths: [{ path: 'a.md', op: 'append' }] }],
    ['paths.0.path', { paths: [{ path: '', op: 'put' }] }],
    ['subject', { subject: undefined }],
    ['workspaceId', { workspaceId: undefined }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });

  it('refuses a schema version that does not exist', () => {
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
  });
});
