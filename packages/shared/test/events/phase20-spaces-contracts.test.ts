import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CreatePersonalInboxNoteRequest,
  ListBotConsentsResponse,
  SendToMemoryRequest,
  SetBotConsentRequest,
  WritePersonalMemoryRequest,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P20-04 to P20-09 (`pnpm test:events`): the events of Personal memory, the Personal inbox, Personal knowledge and bot consents, and the bodies of the
// routes under /api/me. None of the events carries a name, a path, a title or any text.

const AT = '2026-11-06T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};
const base = { schemaVersion: 1, workspaceId: uuid(1), personId: uuid(2), at: AT };

describe('the Personal space events', () => {
  const events = {
    'memory.personal.written': { type: 'memory.personal.written', ...base, op: 'put', versionNo: 3, authorKind: 'bot' },
    'memory.personal_item.changed': { type: 'memory.personal_item.changed', ...base, itemId: uuid(3), state: 'held', origin: 'person', kind: 'pdf', size: 1200, duplicate: false },
    'knowledge.personal_base.changed': { type: 'knowledge.personal_base.changed', ...base, baseId: uuid(4), change: 'document_added', documents: 2 },
    'bots.personal_consent.changed': { type: 'bots.personal_consent.changed', ...base, botId: uuid(5), allowed: false },
  } as const;

  it.each(Object.entries(events))('%s is registered at version 1 and round-trips', (type, payload) => {
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(payload)).toEqual(payload);
  });

  it.each(Object.entries(events))('%s carries no name, path, title or text', (_type, payload) => {
    const keys = Object.keys(payload);
    for (const banned of ['name', 'path', 'title', 'text', 'content', 'slug', 'reason']) expect(keys).not.toContain(banned);
  });

  it.each([
    ['memory.personal.written', 'op', { op: 'rename' }],
    ['memory.personal.written', 'versionNo', { versionNo: 0 }],
    ['memory.personal_item.changed', 'state', { state: 'lost' }],
    ['knowledge.personal_base.changed', 'change', { change: 'renamed' }],
    ['bots.personal_consent.changed', 'allowed', { allowed: 'yes' }],
  ] as const)('%s refuses a bad %s', (type, path, patch) => {
    expect(failsAt({ ...events[type], ...patch })).toContain(path);
  });
});

describe('the bodies of the routes under /api/me', () => {
  it('a Personal memory write is strict and bounded', () => {
    expect(WritePersonalMemoryRequest.safeParse({ path: 'people/nadia.md', content: '---\ntype: Person\n---\n' }).success).toBe(true);
    expect(WritePersonalMemoryRequest.safeParse({ path: 'a.md', content: 'x', extra: 1 }).success).toBe(false);
    expect(WritePersonalMemoryRequest.safeParse({ path: 'a.md', content: '' }).success).toBe(false);
  });
  it('a note and a consent are strict', () => {
    expect(CreatePersonalInboxNoteRequest.safeParse({ text: 'remember the milk' }).success).toBe(true);
    expect(CreatePersonalInboxNoteRequest.safeParse({ text: 'x', teamOnly: true }).success).toBe(false);
    expect(SetBotConsentRequest.safeParse({ allowed: true }).success).toBe(true);
    expect(SetBotConsentRequest.safeParse({ allowed: true, botId: uuid(1) }).success).toBe(false);
    expect(ListBotConsentsResponse.safeParse({ items: [] }).success).toBe(true);
  });
  it('send to memory defaults to the team and accepts the person', () => {
    expect(SendToMemoryRequest.parse({}).target).toBe('team');
    expect(SendToMemoryRequest.parse({ target: 'personal' }).target).toBe('personal');
    expect(SendToMemoryRequest.safeParse({ target: 'elsewhere' }).success).toBe(false);
  });
});
