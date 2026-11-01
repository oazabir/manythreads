import { describe, expect, it } from 'vitest';
import { CancelReminderResponse, CreateReminderRequest, ListRemindersQuery, eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-04 (`pnpm test:events`): `reminders.reminder.changed` has a registered v1 schema that accepts its documented payload and
// refuses what breaks it. The reminders plugin's own events test proves the real code path stores this shape.

const valid = {
  type: 'reminders.reminder.changed',
  schemaVersion: 1,
  workspaceId: uuid(1),
  reminderId: uuid(2),
  creatorId: uuid(3),
  targetKind: 'me',
  recipientId: uuid(3),
  change: 'created',
};

describe('reminders.reminder.changed', () => {
  it('is registered at version 1 and parses its payload', () => {
    expect(latestVersion('reminders.reminder.changed')).toBe(1);
    expect(Object.keys(eventRegistry['reminders.reminder.changed'])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ reminderId: uuid(2), change: 'created' });
    expect(parseEvent({ ...valid, targetKind: 'channel', recipientId: null, change: 'sent' })).toMatchObject({ recipientId: null });
    for (const change of ['created', 'cancelled', 'sent', 'refused']) expect(parseEvent({ ...valid, change })).toMatchObject({ change });
  });

  it('refuses a missing id, an unknown change or kind and another schema version', () => {
    for (const key of ['reminderId', 'creatorId', 'targetKind', 'change'] as const) expect(() => parseEvent({ ...valid, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...valid, change: 'moved' })).toThrow();
    expect(() => parseEvent({ ...valid, targetKind: 'everyone' })).toThrow();
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
  });

  it('carries no text, no time and no reason: extra fields do not come through', () => {
    const parsed = parseEvent({ ...valid, text: 'secret text', remindAt: '2026-11-02T09:00:00.000Z', reason: 'You can no longer post there.' }) as unknown as Record<string, unknown>;
    expect(parsed['text']).toBeUndefined();
    expect(parsed['remindAt']).toBeUndefined();
    expect(parsed['reason']).toBeUndefined();
  });
});

describe('the reminder routes’ schemas', () => {
  const at = '2026-11-05T09:00:00.000Z';

  it('accepts a reminder for oneself, for a person (naming the channel) and for a channel', () => {
    expect(CreateReminderRequest.parse({ target: { kind: 'me' }, text: '  call the bank ', remindAt: at }).text).toBe('call the bank');
    expect(CreateReminderRequest.safeParse({ target: { kind: 'person', personId: uuid(1), channelId: uuid(2) }, text: 'x', remindAt: at }).success).toBe(true);
    expect(CreateReminderRequest.safeParse({ target: { kind: 'channel', channelId: uuid(2) }, text: 'x', remindAt: at }).success).toBe(true);
  });

  it('refuses a person without the channel, an unknown kind, a long text, a line break and extra fields', () => {
    const ok = { target: { kind: 'me' }, text: 'x', remindAt: at };
    expect(CreateReminderRequest.safeParse({ ...ok, target: { kind: 'person', personId: uuid(1) } }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, target: { kind: 'team' } }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, target: { kind: 'me', personId: uuid(1) } }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, text: 'x'.repeat(501) }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, text: 'a\nb' }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, text: '   ' }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, remindAt: 'tomorrow' }).success).toBe(false);
    expect(CreateReminderRequest.safeParse({ ...ok, creatorId: uuid(1) }).success).toBe(false);
  });

  it('lists pending by default and answers a cancel with a flag', () => {
    expect(ListRemindersQuery.parse({}).state).toBe('pending');
    expect(ListRemindersQuery.safeParse({ state: 'all' }).success).toBe(false);
    expect(CancelReminderResponse.parse({ cancelled: false })).toEqual({ cancelled: false });
  });
});
