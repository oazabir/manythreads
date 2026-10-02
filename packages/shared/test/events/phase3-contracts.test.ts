import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, latestVersion, parseEvent, upcast, type EventType } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contracts of phase 3 (PLAN P3-15, `pnpm test:events`): every channel, message, reaction, mention, read-state, notification and
// file event has a registered v1 schema that accepts its documented payload, refuses what breaks the contract, and carries ids, never
// text. The plugins' own `test/events` files prove each event is stored in this shape by the real code path; the last test makes sure
// none of these types is missing one.

const base = { schemaVersion: 1, workspaceId: uuid(1) };
const channel = { channelId: uuid(2), teamId: uuid(3) };

/** One valid payload per event type, written the way the plugins emit it. */
const SAMPLES = {
  'channel.message.posted': { ...base, ...channel, messageId: uuid(4), authorId: uuid(5), threadRootId: null },
  'channel.message.edited': { ...base, ...channel, messageId: uuid(4), editorId: uuid(5), threadRootId: uuid(6) },
  'channel.message.deleted': { ...base, ...channel, messageId: uuid(4), deletedBy: uuid(5), threadRootId: null },
  'channel.reaction.changed': { ...base, ...channel, messageId: uuid(4), actorId: uuid(5), emoji: '👍', added: true },
  'channel.channel.created': { ...base, ...channel, name: 'dev', kind: 'channel', private: false },
  'channel.channel.updated': { ...base, ...channel, changes: { purpose: 'Engineering chat' } },
  'channel.channel.archived': { ...base, ...channel, archived: true },
  'channel.member.added': { ...base, ...channel, personId: uuid(7), self: false },
  'channel.member.removed': { ...base, ...channel, personId: uuid(7), self: true },
  'channel.mention.created': { ...base, ...channel, messageId: uuid(4), threadRootId: null, authorId: uuid(5), kind: 'person', mentionedId: uuid(8), personId: uuid(7) },
  'reading.state.changed': {
    ...base,
    targetType: 'channel',
    targetId: uuid(2),
    reason: 'posted',
    changes: [{ personId: uuid(7), lastReadId: null, unreadCount: 3, followed: false }],
  },
  'notifications.notification.created': {
    ...base,
    notificationId: uuid(9),
    personId: uuid(7),
    kind: 'mention',
    refType: 'message',
    refId: uuid(4),
    channelId: uuid(2),
    actorId: uuid(5),
  },
  'files.file.uploaded': { ...base, channelId: uuid(2), teamId: uuid(3), fileId: uuid(10), uploaderId: uuid(5), name: 'report.pdf', size: 2_100_000, mime: 'application/pdf' },
  'files.file.deleted': { ...base, channelId: uuid(2), teamId: uuid(3), fileId: uuid(10), deletedBy: uuid(5) },
} as const satisfies Partial<Record<EventType, Record<string, unknown>>>;

const TYPES = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];
const event = (type: keyof typeof SAMPLES, over: Record<string, unknown> = {}): Record<string, unknown> => ({ type, ...SAMPLES[type], ...over });
const failsAt = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('phase 3 event contracts', () => {
  it.each(TYPES)('%s is registered at version 1 only and its documented payload parses unchanged', (type) => {
    expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    expect(latestVersion(type)).toBe(1);
    const raw = event(type);
    expect(parseEvent(raw)).toEqual(raw);
    expect(upcast(raw)).toEqual(raw);
  });

  it.each(TYPES)('%s refuses a missing workspace, a foreign version, a type mismatch and a malformed id', (type) => {
    expect(failsAt(() => parseEvent(event(type, { workspaceId: undefined })))).toContain('workspaceId');
    expect(failsAt(() => parseEvent(event(type, { workspaceId: 'not-a-uuid' })))).toContain('workspaceId');
    expect(() => parseEvent(event(type, { schemaVersion: 2 }))).toThrow(/schemaVersion/);
    expect(() => parseEvent(event(type, { type: 'channel.message.unknown' }))).toThrow(/unknown event type/);
    expect(failsAt(() => eventRegistry[type][1].parse({ ...event(type), type: 'other.thing.happened' }))).toContain('type');
  });

  it.each(TYPES)('%s carries ids and facts, never message text', (type) => {
    const keys = Object.keys(SAMPLES[type]);
    for (const forbidden of ['body', 'bodyPlain', 'text', 'preview', 'content', 'bytes', 'token']) expect(keys).not.toContain(forbidden);
    // an extra field a sender adds does not become part of the stored shape
    const parsed = parseEvent(event(type, { body: 'secret text' })) as Record<string, unknown>;
    expect(parsed['body']).toBeUndefined();
  });

  it('message events name the message, its channel (and team, null in a DM) and the thread root', () => {
    for (const type of ['channel.message.posted', 'channel.message.edited', 'channel.message.deleted'] as const) {
      expect(parseEvent(event(type, { teamId: null }))).toMatchObject({ teamId: null });
      expect(failsAt(() => parseEvent(event(type, { messageId: undefined })))).toContain('messageId');
      expect(failsAt(() => parseEvent(event(type, { channelId: undefined })))).toContain('channelId');
      expect(failsAt(() => parseEvent(event(type, { threadRootId: undefined })))).toContain('threadRootId');
      expect(failsAt(() => parseEvent(event(type, { threadRootId: 'x' })))).toContain('threadRootId');
    }
    expect(failsAt(() => parseEvent(event('channel.message.posted', { authorId: undefined })))).toContain('authorId');
    expect(failsAt(() => parseEvent(event('channel.message.edited', { editorId: undefined })))).toContain('editorId');
    expect(failsAt(() => parseEvent(event('channel.message.deleted', { deletedBy: undefined })))).toContain('deletedBy');
  });

  it('a reaction event says who, what and whether it was added; the emoji is bounded', () => {
    expect(parseEvent(event('channel.reaction.changed', { added: false }))).toMatchObject({ added: false });
    for (const bad of [{ emoji: '' }, { emoji: 'x'.repeat(65) }, { added: 'yes' }, { actorId: undefined }]) {
      expect(failsAt(() => parseEvent(event('channel.reaction.changed', bad))).length).toBeGreaterThan(0);
    }
  });

  it('a channel event names its kind; a DM has no team', () => {
    expect(parseEvent(event('channel.channel.created', { kind: 'dm', private: true, teamId: null }))).toMatchObject({ kind: 'dm', teamId: null });
    expect(failsAt(() => parseEvent(event('channel.channel.created', { kind: 'room' })))).toContain('kind');
    expect(failsAt(() => parseEvent(event('channel.channel.created', { private: undefined })))).toContain('private');
    expect(parseEvent(event('channel.channel.updated', { changes: {} }))).toMatchObject({ changes: {} });
    expect(parseEvent(event('channel.channel.updated', { changes: { groupId: null } }))).toMatchObject({ changes: { groupId: null } });
    expect(failsAt(() => parseEvent(event('channel.channel.archived', { archived: undefined })))).toContain('archived');
  });

  it('a mention event distinguishes the mentioned actor from the person, and allows only people and bots', () => {
    expect(parseEvent(event('channel.mention.created', { kind: 'bot', personId: null }))).toMatchObject({ kind: 'bot', personId: null });
    expect(failsAt(() => parseEvent(event('channel.mention.created', { kind: 'channel' })))).toContain('kind');
    expect(failsAt(() => parseEvent(event('channel.mention.created', { mentionedId: undefined })))).toContain('mentionedId');
  });

  it('a read-state event holds at least one change, with a non-negative integer count', () => {
    expect(failsAt(() => parseEvent(event('reading.state.changed', { changes: [] })))).toContain('changes');
    for (const unreadCount of [-1, 1.5, '3']) {
      expect(failsAt(() => parseEvent(event('reading.state.changed', { changes: [{ personId: uuid(7), lastReadId: null, unreadCount, followed: false }] })))).toContain('changes.0.unreadCount');
    }
    for (const reason of ['posted', 'read', 'followed'] as const) expect(parseEvent(event('reading.state.changed', { reason }))).toMatchObject({ reason });
    expect(failsAt(() => parseEvent(event('reading.state.changed', { reason: 'deleted' })))).toContain('reason');
    expect(failsAt(() => parseEvent(event('reading.state.changed', { targetType: 'file' })))).toContain('targetType');
    expect(parseEvent(event('reading.state.changed', { targetType: 'thread' }))).toMatchObject({ targetType: 'thread' });
  });

  it('a notification event names the person told and why, in one of three kinds', () => {
    for (const kind of ['mention', 'reply', 'dm'] as const) expect(parseEvent(event('notifications.notification.created', { kind }))).toMatchObject({ kind });
    expect(failsAt(() => parseEvent(event('notifications.notification.created', { kind: 'like' })))).toContain('kind');
    expect(failsAt(() => parseEvent(event('notifications.notification.created', { refType: 'file' })))).toContain('refType');
    expect(failsAt(() => parseEvent(event('notifications.notification.created', { personId: undefined })))).toContain('personId');
  });

  it('file events name the file and the uploader; size is a non-negative integer', () => {
    expect(parseEvent(event('files.file.uploaded', { channelId: null, teamId: null }))).toMatchObject({ channelId: null });
    for (const size of [-1, 0.5, '10']) expect(failsAt(() => parseEvent(event('files.file.uploaded', { size })))).toContain('size');
    expect(failsAt(() => parseEvent(event('files.file.uploaded', { fileId: undefined })))).toContain('fileId');
    expect(failsAt(() => parseEvent(event('files.file.deleted', { deletedBy: undefined })))).toContain('deletedBy');
  });

  it('every phase 3 event type has a stored-shape test next to the code that emits it', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url)); // packages/
    const files: string[] = [];
    const walk = (dir: string, depth: number): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules') continue;
        const path = join(dir, name);
        if (!statSync(path).isDirectory()) continue;
        if (name === 'events' && dir.endsWith('/test')) files.push(...readdirSync(path).filter((f) => f.endsWith('.test.ts')).map((f) => join(path, f)));
        else if (depth < 4) walk(path, depth + 1);
      }
    };
    walk(root, 0);
    // this file is not one of them: it checks schemas, not what a code path stores
    const others = files.filter((f) => !f.endsWith('phase3-contracts.test.ts')).map((f) => readFileSync(f, 'utf8'));
    expect(others.length).toBeGreaterThanOrEqual(8);
    const untested = TYPES.filter((type) => !others.some((text) => text.includes(`'${type}'`)));
    expect(untested).toEqual([]);
  });
});
