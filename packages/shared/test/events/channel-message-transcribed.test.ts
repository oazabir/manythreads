import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P32-04 (`pnpm test:events`): `channel.message.transcribed` is registered at version 1, says how a voice message's transcript ended
// (`server`, `failed`, `none`) and carries ids only: never the words. The channels plugin's own test proves the real code path writes this shape once.

const sample = { type: 'channel.message.transcribed', schemaVersion: 1, workspaceId: uuid(1), channelId: uuid(2), teamId: uuid(3), messageId: uuid(4), authorId: uuid(5), threadRootId: null, state: 'server', transcriptEndMs: 20_000 } as const;

describe('channel.message.transcribed', () => {
  it('is registered at version 1 and parses its payload unchanged', () => {
    expect(latestVersion('channel.message.transcribed')).toBe(1);
    expect(Object.keys(eventRegistry['channel.message.transcribed'])).toEqual(['1']);
    expect(parseEvent(sample)).toEqual(sample);
  });

  it('takes a DM (no team), a thread reply, and each way the transcript can end', () => {
    expect(parseEvent({ ...sample, teamId: null })).toMatchObject({ teamId: null });
    expect(parseEvent({ ...sample, threadRootId: uuid(6) })).toMatchObject({ threadRootId: uuid(6) });
    for (const state of ['server', 'failed', 'none']) expect(parseEvent({ ...sample, state, transcriptEndMs: state === 'server' ? 5000 : null })).toMatchObject({ state });
  });

  it('refuses a missing or malformed id, another state, a negative time and another schema version', () => {
    for (const key of ['workspaceId', 'channelId', 'messageId', 'authorId'] as const) expect(() => parseEvent({ ...sample, [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...sample, messageId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...sample, state: 'pending' })).toThrow();
    expect(() => parseEvent({ ...sample, transcriptEndMs: -1 })).toThrow();
    expect(() => parseEvent({ ...sample, schemaVersion: 2 })).toThrow();
  });

  it('carries no words: the transcript is read from the message', () => {
    const parsed = parseEvent({ ...sample, body: 'secret words', text: 'secret words', transcript: 'secret words' }) as unknown as Record<string, unknown>;
    for (const key of ['body', 'text', 'transcript']) expect(parsed[key]).toBeUndefined();
  });
});
