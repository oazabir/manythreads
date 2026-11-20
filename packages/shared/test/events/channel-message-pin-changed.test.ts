import { describe, expect, it } from 'vitest';
import { MessagePinChangedPush, eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P31-07 (`pnpm test:events`): `channel.message.pin_changed` is registered at version 1 and carries ids and the new state only, never the
// message's words. The channels plugin's own test proves the pin routes write this shape once per real change.

const sample = { type: 'channel.message.pin_changed', schemaVersion: 1, workspaceId: uuid(1), channelId: uuid(2), teamId: uuid(3), messageId: uuid(4), threadRootId: null, actorId: uuid(5), pinned: true } as const;

describe('channel.message.pin_changed', () => {
  it('is registered at version 1 and parses its payload unchanged', () => {
    expect(latestVersion('channel.message.pin_changed')).toBe(1);
    expect(Object.keys(eventRegistry['channel.message.pin_changed'])).toEqual(['1']);
    expect(parseEvent(sample)).toEqual(sample);
  });

  it('takes a DM (no team), a thread reply and an unpin', () => {
    expect(parseEvent({ ...sample, teamId: null })).toMatchObject({ teamId: null });
    expect(parseEvent({ ...sample, threadRootId: uuid(6) })).toMatchObject({ threadRootId: uuid(6) });
    expect(parseEvent({ ...sample, pinned: false })).toMatchObject({ pinned: false });
  });

  it('refuses a missing or malformed id, a missing state and another schema version', () => {
    for (const key of ['workspaceId', 'channelId', 'messageId', 'actorId', 'pinned'] as const) expect(() => parseEvent({ ...sample, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...sample, messageId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...sample, schemaVersion: 2 })).toThrow();
  });

  it('carries no words', () => {
    const parsed = parseEvent({ ...sample, body: 'secret words' }) as unknown as Record<string, unknown>;
    expect(parsed['body']).toBeUndefined();
  });

  it('the live push says the pin now, or null once it is taken off', () => {
    const push = { channelId: uuid(2), messageId: uuid(4), threadRootId: null, pinned: { by: uuid(5), at: '2026-11-20T10:00:00.000Z' } };
    expect(MessagePinChangedPush.parse(push)).toEqual(push);
    expect(MessagePinChangedPush.parse({ ...push, pinned: null }).pinned).toBeNull();
    expect(() => MessagePinChangedPush.parse({ ...push, pinned: undefined })).toThrow();
  });
});
