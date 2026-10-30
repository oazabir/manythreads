import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-04 (`pnpm test:events`): `reminders.reminder.due` has a registered v1 schema that accepts its documented payload and
// refuses what breaks it. The reminders plugin's own events test proves the real code path stores this shape.

const valid = { type: 'reminders.reminder.due', schemaVersion: 1, workspaceId: uuid(1), personId: uuid(2), itemId: uuid(3), messageId: uuid(4), channelId: uuid(5) };

describe('reminders.reminder.due', () => {
  it('is registered at version 1 and parses its payload', () => {
    expect(latestVersion('reminders.reminder.due')).toBe(1);
    expect(Object.keys(eventRegistry['reminders.reminder.due'])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ personId: uuid(2), messageId: uuid(4) });
  });

  it('refuses a missing id, a malformed id and another schema version', () => {
    for (const key of ['personId', 'itemId', 'messageId', 'channelId'] as const) expect(() => parseEvent({ ...valid, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...valid, messageId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
  });

  it('carries no text: an extra field with a message body does not come through', () => {
    const parsed = parseEvent({ ...valid, body: 'secret text' }) as unknown as Record<string, unknown>;
    expect(parsed['body']).toBeUndefined();
  });
});
