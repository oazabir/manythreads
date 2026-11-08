import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of Bundle D (P16-12, `pnpm test:events`): the connector events have a registered v1 schema, carry ids, counts and times (never a title, an agenda, an
// address, a token or a message), and refuse what breaks them. Each plugin's own test proves its real code path writes these shapes.

const at = '2026-11-08T10:00:00.000Z';
const ws = { schemaVersion: 1, workspaceId: uuid(1), at } as const;
const SAMPLES = {
  'meetings.scheduled.created': { ...ws, type: 'meetings.scheduled.created', teamId: uuid(2), channelId: uuid(3), scheduledMeetingId: uuid(4), organizerId: uuid(5), provider: 'google', startsAt: at, attendeeCount: 3, outsideCount: 1 },
  'meetings.scheduled.changed': { ...ws, type: 'meetings.scheduled.changed', teamId: uuid(2), channelId: uuid(3), scheduledMeetingId: uuid(4), changedBy: uuid(5), fields: ['time', 'title'], startsAt: at },
  'meetings.scheduled.cancelled': { ...ws, type: 'meetings.scheduled.cancelled', teamId: null, channelId: uuid(3), scheduledMeetingId: uuid(4), cancelledBy: null, reason: 'calendar_deleted' },
  'meetings.scheduled.starting_soon': { ...ws, type: 'meetings.scheduled.starting_soon', teamId: uuid(2), channelId: uuid(3), scheduledMeetingId: uuid(4), attendeePersonIds: [uuid(5), uuid(6)], startsAt: at },
  'knowledge.source.synced': { ...ws, type: 'knowledge.source.synced', teamId: uuid(2), ownerPersonId: null, baseId: uuid(7), sourceId: uuid(8), provider: 'notion', added: 3, updated: 1, removed: 0, skippedLimited: 2, status: 'ready' },
  'webhooks.provider_endpoint.changed': { ...ws, type: 'webhooks.provider_endpoint.changed', teamId: uuid(2), channelId: uuid(3), webhookId: uuid(9), provider: 'github', change: 'created', actorId: uuid(5) },
  'webhooks.provider_event.received': { ...ws, type: 'webhooks.provider_event.received', teamId: uuid(2), channelId: uuid(3), webhookId: uuid(9), eventId: uuid(10), provider: 'github', kind: 'unknown' },
  'webhooks.provider_event.refused': { ...ws, type: 'webhooks.provider_event.refused', teamId: uuid(2), channelId: uuid(3), webhookId: uuid(9), provider: 'github', reason: 'bad_signature', count: 4 },
  'bridges.account.changed': { ...ws, type: 'bridges.account.changed', accountId: uuid(11), provider: 'telegram', change: 'switched', status: 'on', actorId: uuid(5) },
  'bridges.channel.linked': { ...ws, type: 'bridges.channel.linked', teamId: uuid(2), channelId: uuid(3), accountId: uuid(11), linkId: uuid(12), provider: 'slack', actorId: uuid(5) },
  'bridges.channel.unlinked': { ...ws, type: 'bridges.channel.unlinked', teamId: uuid(2), channelId: uuid(3), accountId: uuid(11), linkId: uuid(12), provider: 'slack', actorId: null, reason: 'channel_private' },
  'bridges.identity.linked': { ...ws, type: 'bridges.identity.linked', accountId: uuid(11), provider: 'whatsapp', personId: uuid(13) },
  'bridges.identity.unlinked': { ...ws, type: 'bridges.identity.unlinked', accountId: uuid(11), provider: 'whatsapp', personId: uuid(13), how: 'offboarded', actorId: null },
  'bridges.message.refused': { ...ws, type: 'bridges.message.refused', accountId: uuid(11), provider: 'teams', reason: 'unverified', count: 2 },
  'connections.person.offboarded': { ...ws, type: 'connections.person.offboarded', personId: uuid(13), revoked: 4, providerRevoked: 3, providerFailed: 1, moved: 2, newOwnerIds: [uuid(5)], actorId: uuid(5) },
} as const;
const TYPES = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

describe('connector events (Bundle D)', () => {
  it.each(TYPES)('%s is registered at version 1 and parses its payload unchanged', (type) => {
    expect(latestVersion(type)).toBe(1);
    expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    expect(parseEvent(SAMPLES[type])).toEqual(SAMPLES[type]);
  });

  it.each(TYPES)('%s refuses a missing workspace, a bad time and another schema version', (type) => {
    expect(() => parseEvent({ ...SAMPLES[type], workspaceId: undefined })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], workspaceId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], at: 'yesterday' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], schemaVersion: 2 })).toThrow();
  });

  it.each(TYPES)('%s carries no text field and drops one that is sent', (type) => {
    const keys = Object.keys(SAMPLES[type]);
    for (const forbidden of ['title', 'text', 'body', 'agenda', 'email', 'address', 'token', 'secret', 'name']) expect(keys).not.toContain(forbidden);
    const parsed = parseEvent({ ...SAMPLES[type], title: 'secret plan', text: 'secret', token: 'abc', email: 'a@b.c' }) as unknown as Record<string, unknown>;
    for (const forbidden of ['title', 'text', 'token', 'email']) expect(parsed[forbidden]).toBeUndefined();
  });

  it('a planned room names a known calendar service and a changed field list that is never empty', () => {
    expect(() => parseEvent({ ...SAMPLES['meetings.scheduled.created'], provider: 'zoom' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.scheduled.created'], attendeeCount: 51 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.scheduled.changed'], fields: [] })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.scheduled.changed'], fields: ['password'] })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.scheduled.cancelled'], reason: 'bored' })).toThrow();
  });

  it('a connector source pass reports counts for a known service and status', () => {
    expect(() => parseEvent({ ...SAMPLES['knowledge.source.synced'], provider: 'evernote' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['knowledge.source.synced'], added: -1 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['knowledge.source.synced'], status: 'fine' })).toThrow();
  });

  it('provider webhooks name a known service and a known refusal; a refusal is counted at least once', () => {
    expect(() => parseEvent({ ...SAMPLES['webhooks.provider_endpoint.changed'], provider: 'bitbucket' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['webhooks.provider_endpoint.changed'], change: 'peeked' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['webhooks.provider_event.refused'], reason: 'rude' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['webhooks.provider_event.refused'], count: 0 })).toThrow();
    expect(parseEvent({ ...SAMPLES['webhooks.provider_event.refused'], webhookId: null, provider: null, channelId: null, teamId: null, reason: 'unknown_endpoint' })).toMatchObject({ webhookId: null });
  });

  it('chat bridges name a known service; an unlink says why and may have no actor', () => {
    expect(() => parseEvent({ ...SAMPLES['bridges.account.changed'], provider: 'signal' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['bridges.account.changed'], status: 'maybe' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['bridges.channel.unlinked'], reason: 'moody' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['bridges.identity.unlinked'], how: 'magic' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['bridges.message.refused'], reason: 'rude' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['bridges.message.refused'], count: 0 })).toThrow();
  });

  it('an offboarding reports counts and ids only; the admin is empty when a suspension did it', () => {
    expect(parseEvent({ ...SAMPLES['connections.person.offboarded'], actorId: null })).toMatchObject({ actorId: null });
    expect(() => parseEvent({ ...SAMPLES['connections.person.offboarded'], revoked: -1 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['connections.person.offboarded'], newOwnerIds: ['x'] })).toThrow();
  });
});
