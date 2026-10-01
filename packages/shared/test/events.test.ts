import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, latestVersion, parseEvent, upcast } from '../src/index.ts';
import { uuid } from './fixtures.ts';

const posted = {
  type: 'channel.message.posted',
  schemaVersion: 1,
  workspaceId: uuid(1),
  channelId: uuid(2),
  teamId: null,
  messageId: uuid(3),
  authorId: uuid(4),
  threadRootId: null,
};
const pingedV1 = { type: 'kernel.test.pinged', schemaVersion: 1, workspaceId: uuid(1), note: 'hi' };

const issuePaths = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('parseEvent', () => {
  it('parses a valid event', () => {
    expect(parseEvent(posted)).toEqual(posted);
  });

  it('names the failing field', () => {
    expect(issuePaths(() => parseEvent({ ...posted, messageId: 'not-a-uuid' }))).toEqual(['messageId']);
    expect(issuePaths(() => parseEvent({ ...pingedV1, note: 7 }))).toEqual(['note']);
  });

  it('names type / schemaVersion when unknown or missing', () => {
    expect(issuePaths(() => parseEvent({ ...posted, type: 'nope.nope.nope' }))).toEqual(['type']);
    expect(issuePaths(() => parseEvent({ ...posted, schemaVersion: 9 }))).toEqual(['schemaVersion']);
    expect(issuePaths(() => parseEvent({ type: 'channel.message.posted' }))).toEqual(['schemaVersion']);
    expect(issuePaths(() => parseEvent('x'))).not.toEqual([]);
  });
});

describe('registry', () => {
  it('lists versions per type', () => {
    expect(Object.keys(eventRegistry['kernel.test.pinged'])).toEqual(['1', '2']);
    expect(latestVersion('channel.message.posted')).toBe(1);
    expect(latestVersion('kernel.test.pinged')).toBe(2);
  });

  it('every registered schema is keyed by its own type and version', () => {
    for (const [type, versions] of Object.entries(eventRegistry)) {
      for (const [version, schema] of Object.entries(versions)) {
        expect(schema.shape.type.value).toBe(type);
        expect(schema.shape.schemaVersion.value).toBe(Number(version));
      }
    }
  });
});

describe('upcast', () => {
  it('upcasts kernel.test.pinged v1 to v2', () => {
    expect(upcast(pingedV1)).toEqual({ ...pingedV1, schemaVersion: 2, count: 0 });
  });

  it('leaves the newest version untouched', () => {
    const v2 = { ...pingedV1, schemaVersion: 2, count: 5 };
    expect(upcast(v2)).toEqual(v2);
    expect(upcast(posted)).toEqual(posted);
  });

  it('still validates input before upcasting', () => {
    expect(issuePaths(() => upcast({ ...pingedV1, workspaceId: 'x' }))).toEqual(['workspaceId']);
  });
});
