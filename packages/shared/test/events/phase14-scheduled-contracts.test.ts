import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-05 (`pnpm test:events`): `channel.scheduled_message.changed` has a registered v1 schema that accepts its documented
// payload and refuses what breaks it. The channels plugin's own scheduled-send test proves the real code path stores this shape.

const valid = {
  type: 'channel.scheduled_message.changed',
  schemaVersion: 1,
  workspaceId: uuid(1),
  channelId: uuid(2),
  teamId: null,
  scheduledId: uuid(3),
  authorId: uuid(4),
  change: 'scheduled',
  messageId: null,
};

describe('channel.scheduled_message.changed', () => {
  it('is registered at version 1 and parses its payload', () => {
    expect(latestVersion('channel.scheduled_message.changed')).toBe(1);
    expect(Object.keys(eventRegistry['channel.scheduled_message.changed'])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ scheduledId: uuid(3), change: 'scheduled' });
    expect(parseEvent({ ...valid, change: 'sent', messageId: uuid(5) })).toMatchObject({ messageId: uuid(5) });
    expect(parseEvent({ ...valid, change: 'refused' })).toMatchObject({ change: 'refused' });
  });

  it('refuses a missing id, an unknown change and another schema version', () => {
    for (const key of ['channelId', 'scheduledId', 'authorId', 'change'] as const) expect(() => parseEvent({ ...valid, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...valid, change: 'moved' })).toThrow();
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
  });

  it('carries no text, no time and no reason: extra fields do not come through', () => {
    const parsed = parseEvent({ ...valid, body: 'secret text', sendAt: '2026-11-02T09:00:00.000Z', reason: 'You can no longer post in this channel.' }) as unknown as Record<string, unknown>;
    expect(parsed['body']).toBeUndefined();
    expect(parsed['sendAt']).toBeUndefined();
    expect(parsed['reason']).toBeUndefined();
  });
});
