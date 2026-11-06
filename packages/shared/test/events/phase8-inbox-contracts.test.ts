import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CreateInboxNoteRequest,
  InboxItem,
  InboxItemChangedPush,
  InboxKind,
  InboxState,
  ListInboxItemsQuery,
  SendToMemoryRequest,
  TeamMemoryInboxConfig,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P8-14 to P8-17 (`pnpm test:events`): the six memory inbox events (ids, codes and counts only: never a file name, its text or the plain-language
// reason, which is on the item) and the shapes of an item and of the routes' bodies.

const AT = '2026-11-02T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};
const base = { schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), itemId: uuid(3), at: AT };

describe('the memory inbox events', () => {
  const events = {
    'memory.item.dropped': { type: 'memory.item.dropped', ...base, origin: 'person', kind: 'pdf', size: 1200, teamOnly: false, duplicate: false, droppedBy: uuid(4) },
    'memory.item.held': { type: 'memory.item.held', ...base, origin: 'email', reason: 'unknown_sender', droppedBy: null },
    'memory.item.failed': { type: 'memory.item.failed', ...base, origin: 'person', stage: 'extract', attempts: 2, droppedBy: uuid(4) },
    'memory.item.filed': { type: 'memory.item.filed', ...base, origin: 'message', concepts: 3, commitSha: 'a'.repeat(40), distilled: true, droppedBy: uuid(4) },
    'memory.item.released': { type: 'memory.item.released', ...base, reason: 'review_all', releasedBy: uuid(5) },
    'memory.item.discarded': { type: 'memory.item.discarded', ...base, reason: null, discardedBy: uuid(5) },
  } as const;

  it.each(Object.entries(events))('%s is registered at version 1 and round-trips', (type, payload) => {
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(payload)).toEqual(payload);
  });

  it.each([
    ['memory.item.dropped', 'origin', { origin: 'carrier-pigeon' }],
    ['memory.item.dropped', 'kind', { kind: 'exe' }],
    ['memory.item.dropped', 'size', { size: -1 }],
    ['memory.item.held', 'reason', { reason: 'because' }],
    ['memory.item.failed', 'stage', { stage: 'hold' }],
    ['memory.item.failed', 'attempts', { attempts: 0 }],
    ['memory.item.filed', 'concepts', { concepts: 0 }],
    ['memory.item.filed', 'commitSha', { commitSha: 'not-a-sha' }],
    ['memory.item.released', 'releasedBy', { releasedBy: null }],
    ['memory.item.discarded', 'itemId', { itemId: 'x' }],
  ] as const)('%s refuses a bad %s', (type, field, over) => expect(failsAt({ ...events[type], ...over })).toContain(field));

  it('carry ids, short codes and counts only: no name, text, title or sentence', () => {
    for (const payload of Object.values(events)) {
      const keys = Object.keys(payload);
      expect(keys.filter((k) => /name|text|title|body|content|message|sentence/i.test(k))).toEqual([]);
    }
  });
});

describe('inbox shapes', () => {
  const item = {
    id: uuid(3),
    teamId: uuid(2),
    origin: 'person',
    state: 'filed',
    kind: 'docx',
    name: 'Q3 planning.docx',
    size: 4096,
    sha256: 'f'.repeat(64),
    droppedBy: uuid(4),
    droppedByName: 'Nadia',
    teamOnly: false,
    reason: null,
    holdReason: null,
    duplicateOf: null,
    parentId: null,
    sender: null,
    senderCheck: null,
    filedPaths: ['memory/references/q3-planning-0123abcd.md'],
    commitSha: 'a'.repeat(40),
    originalKept: true,
    attempts: 1,
    createdAt: AT,
    updatedAt: AT,
    filedAt: AT,
  };

  it('an item round-trips, and every state and kind of the database is one the shape knows', () => {
    expect(InboxItem.parse(item)).toEqual(item);
    expect(InboxState.options).toEqual(['queued', 'extracting', 'filing', 'filed', 'held', 'failed', 'duplicate', 'needs_review', 'discarded']);
    expect(InboxKind.options).toContain('bundle');
  });

  it('refuses an item with a bad hash, a negative size or an unknown state', () => {
    for (const bad of [{ sha256: 'xyz' }, { size: -1 }, { state: 'pending' }, { reason: 'x'.repeat(401) }]) expect(InboxItem.safeParse({ ...item, ...bad }).success).toBe(false);
  });

  it('a note needs text, takes a title, and refuses a field it does not know', () => {
    expect(CreateInboxNoteRequest.parse({ text: '  hello  ' })).toEqual({ text: 'hello', teamOnly: false });
    expect(CreateInboxNoteRequest.safeParse({ text: '   ' }).success).toBe(false);
    expect(CreateInboxNoteRequest.safeParse({ text: 'x', origin: 'email' }).success).toBe(false);
  });

  it('Send to memory defaults to one message, public, not team-only; and refuses an unknown field', () => {
    expect(SendToMemoryRequest.parse({})).toEqual({ confirmPrivate: false, teamOnly: false, thread: false, target: 'team' });
    expect(SendToMemoryRequest.safeParse({ everyone: true }).success).toBe(false);
  });

  it('the list query bounds its page, and the team’s settings are all optional and bounded', () => {
    expect(ListInboxItemsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListInboxItemsQuery.safeParse({ limit: '500' }).success).toBe(false);
    expect(TeamMemoryInboxConfig.parse({})).toMatchObject({ review: 'external', keepOriginals: 'forever', allowEmailFrom: [] });
    for (const bad of [{ review: 'sometimes' }, { keepOriginals: 0 }, { keepOriginals: 'never' }, { maxBytes: 10 }, { unknown: 1 }]) expect(TeamMemoryInboxConfig.safeParse(bad).success).toBe(false);
  });

  it('the live push says which item changed and to what', () => {
    expect(InboxItemChangedPush.parse({ teamId: uuid(2), itemId: uuid(3), state: 'held' })).toEqual({ teamId: uuid(2), itemId: uuid(3), state: 'held' });
    expect(InboxItemChangedPush.safeParse({ teamId: uuid(2), itemId: uuid(3), state: 'gone' }).success).toBe(false);
  });
});
