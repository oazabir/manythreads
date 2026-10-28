import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-01 (`pnpm test:events`): `presence.dnd.changed` has a registered v1 schema that accepts its documented payload and
// refuses what breaks it. The presence plugin's own events test proves the real code path stores this shape.

const valid = { type: 'presence.dnd.changed', schemaVersion: 1, workspaceId: uuid(1), personId: uuid(2), active: true, until: '2026-06-10T13:00:00.000Z' };

describe('presence.dnd.changed', () => {
  it('is registered at version 1 and parses its payload, with or without an end', () => {
    expect(latestVersion('presence.dnd.changed')).toBe(1);
    expect(Object.keys(eventRegistry['presence.dnd.changed'])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ active: true });
    expect(parseEvent({ ...valid, active: false, until: null })).toMatchObject({ until: null });
  });

  it('refuses a missing person, a non-boolean flag and a malformed end', () => {
    for (const bad of [{ ...valid, personId: undefined }, { ...valid, active: 'yes' }, { ...valid, until: 'tonight' }, { ...valid, schemaVersion: 2 }]) {
      expect(() => parseEvent(bad)).toThrow();
    }
    expect(() => parseEvent({ ...valid, personId: 'not-a-uuid' })).toThrow(ZodError);
  });
});
