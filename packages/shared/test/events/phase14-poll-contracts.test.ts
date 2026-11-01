import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-07 (`pnpm test:events`): the three poll events have a registered v1 schema, carry no vote choices of an anonymous poll, and
// refuse what breaks them. The channels plugin's own test proves the real code path writes these shapes (and writes no `voted` event for an anonymous poll).

const base = { schemaVersion: 1, workspaceId: uuid(1), channelId: uuid(2), teamId: uuid(3), pollId: uuid(4), messageId: uuid(5) };
const SAMPLES = {
  'channel.poll.created': { ...base, type: 'channel.poll.created', authorId: uuid(6), optionCount: 3, multiple: false, anonymous: true, closesAt: '2026-11-01T11:00:00.000Z' },
  'channel.poll.voted': { ...base, type: 'channel.poll.voted', voterId: uuid(7), anonymous: false, options: [0, 2] },
  'channel.poll.closed': { ...base, type: 'channel.poll.closed', reason: 'time', closedBy: null, voters: 5, resultMessageId: uuid(8) },
} as const;
const TYPES = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

describe('poll events', () => {
  it.each(TYPES)('%s is registered at version 1 and parses its payload unchanged', (type) => {
    expect(latestVersion(type)).toBe(1);
    expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    expect(parseEvent(SAMPLES[type])).toEqual(SAMPLES[type]);
  });

  it.each(TYPES)('%s refuses a missing id, a malformed id and another schema version', (type) => {
    for (const key of ['workspaceId', 'channelId', 'pollId', 'messageId'] as const) expect(() => parseEvent({ ...SAMPLES[type], [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], pollId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], schemaVersion: 2 })).toThrow();
  });

  it.each(TYPES)('%s carries no question, option text or message text', (type) => {
    const keys = Object.keys(SAMPLES[type]);
    for (const forbidden of ['question', 'options_text', 'body', 'bodyPlain', 'text', 'content']) expect(keys).not.toContain(forbidden);
    const parsed = parseEvent({ ...SAMPLES[type], question: 'secret?', body: 'secret' }) as unknown as Record<string, unknown>;
    expect(parsed['question']).toBeUndefined();
    expect(parsed['body']).toBeUndefined();
  });

  it('a vote event can only describe a named poll: an anonymous one is refused by the schema itself', () => {
    expect(() => parseEvent({ ...SAMPLES['channel.poll.voted'], anonymous: true })).toThrow();
  });

  it('created and closed events hold no vote choices, in any poll', () => {
    for (const type of ['channel.poll.created', 'channel.poll.closed'] as const) {
      const parsed = parseEvent({ ...SAMPLES[type], options: [1], voterId: uuid(9), choices: [1] }) as unknown as Record<string, unknown>;
      expect(parsed['options']).toBeUndefined();
      expect(parsed['voterId']).toBeUndefined();
      expect(parsed['choices']).toBeUndefined();
    }
  });

  it('bounds: two to ten options on creation, a closing reason of author or time, option numbers 0 to 9', () => {
    expect(() => parseEvent({ ...SAMPLES['channel.poll.created'], optionCount: 1 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['channel.poll.created'], optionCount: 11 })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['channel.poll.closed'], reason: 'admin' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['channel.poll.voted'], options: [10] })).toThrow();
    expect(parseEvent({ ...SAMPLES['channel.poll.voted'], options: [] })).toMatchObject({ options: [] });
  });
});
