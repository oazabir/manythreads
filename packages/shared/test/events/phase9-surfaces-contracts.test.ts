import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P9-04 (`pnpm test:events`): the three surface events have a registered v1 schema, carry ids, counts and times (never the text of a screen,
// a title or what a person sent), and refuse what breaks them. The surfaces plugin's own test proves the real code path writes these shapes.

const base = { schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), channelId: uuid(3), surfaceId: uuid(4), version: 2, at: '2026-11-03T10:00:00.000Z' };
const SAMPLES = {
  'surfaces.surface.rendered': { ...base, type: 'surfaces.surface.rendered', botId: uuid(5), runId: uuid(6), problemCount: 0 },
  'surfaces.surface.updated': { ...base, type: 'surfaces.surface.updated', botId: uuid(5), runId: uuid(6), replacedCount: 1, addedCount: 2 },
  'surfaces.surface.event_posted': { ...base, type: 'surfaces.surface.event_posted', eventId: uuid(7), actorId: uuid(8), nodeId: 'go', eventName: 'press' },
} as const;
const TYPES = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

describe('surface events', () => {
  it.each(TYPES)('%s is registered at version 1 and parses its payload unchanged', (type) => {
    expect(latestVersion(type)).toBe(1);
    expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    expect(parseEvent(SAMPLES[type])).toEqual(SAMPLES[type]);
  });

  it.each(TYPES)('%s refuses a missing id, a malformed id, a bad time, a zero version and another schema version', (type) => {
    for (const key of ['workspaceId', 'surfaceId', 'channelId', 'at', 'version'] as const) expect(() => parseEvent({ ...SAMPLES[type], [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], surfaceId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], at: 'yesterday' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], version: 0 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], schemaVersion: 2 })).toThrow();
  });

  it.each(TYPES)('%s carries no screen text, title or payload, and drops one that is sent', (type) => {
    const keys = Object.keys(SAMPLES[type]);
    for (const forbidden of ['source', 'patch', 'title', 'text', 'body', 'payload', 'data']) expect(keys).not.toContain(forbidden);
    const parsed = parseEvent({ ...SAMPLES[type], source: 'root = Text("secret")', title: 'secret', payload: { a: 1 } }) as unknown as Record<string, unknown>;
    for (const forbidden of ['source', 'title', 'payload']) expect(parsed[forbidden]).toBeUndefined();
  });

  it('a screen in a private channel or a direct message has no team', () => {
    for (const type of TYPES) expect(parseEvent({ ...SAMPLES[type], teamId: null })).toMatchObject({ teamId: null });
  });

  it('an answer names a part and an event, both short', () => {
    const t = 'surfaces.surface.event_posted';
    expect(() => parseEvent({ ...SAMPLES[t], nodeId: '' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[t], nodeId: 'x'.repeat(65) })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[t], eventName: 'x'.repeat(33) })).toThrow();
  });

  it('counts are never negative', () => {
    expect(() => parseEvent({ ...SAMPLES['surfaces.surface.rendered'], problemCount: -1 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['surfaces.surface.updated'], addedCount: -1 })).toThrow();
  });
});
