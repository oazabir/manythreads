import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of pages (PLAN P4-07, `pnpm test:events`): `pages.page.written` has a registered v1 schema, carries ids, the path and sizes, never content.

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const valid = {
  type: 'pages.page.written',
  schemaVersion: 1,
  workspaceId: uuid(1),
  teamId: uuid(2),
  path: 'pages/reports/week-37.md',
  mode: 'replace',
  sha: sha(10),
  blobSha: sha(11),
  size: 120,
  authorId: uuid(3),
  actorKind: 'bot',
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

describe('pages.page.written', () => {
  it('is registered at version 1 and accepts what pages.write emits', () => {
    expect(Object.keys(eventRegistry['pages.page.written'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });

  it.each([
    ['mode', { mode: 'delete' }],
    ['sha', { sha: 'main' }],
    ['blobSha', { blobSha: null }],
    ['authorId', { authorId: null }],
    ['actorKind', { actorKind: 'robot' }],
    ['path', { path: '' }],
    ['size', { size: -1 }],
    ['teamId', { teamId: 'engineering' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});
