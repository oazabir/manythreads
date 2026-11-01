import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P14-13 (`pnpm test:events`): the five import events have a registered v1 schema that accepts the documented payload and refuses what
// breaks it. They carry counts and ids only, never a name, an email address or message text. The import plugin's own tests prove the real code path writes
// these shapes.

const at = '2026-11-02T09:00:00.000Z';
const base = { schemaVersion: 1, workspaceId: uuid(1), at };
const samples = {
  'import.run.uploaded': { ...base, type: 'import.run.uploaded', runId: uuid(2), source: 'slack', teamId: uuid(3), size: 1234, uploadedBy: uuid(4) },
  'import.run.analysed': { ...base, type: 'import.run.analysed', runId: uuid(2), source: 'mattermost', requestedBy: uuid(4), ok: true, people: 5, channels: 3, messages: 200, skipped: 2 },
  'import.run.started': { ...base, type: 'import.run.started', runId: uuid(2), source: 'slack', teamId: uuid(3), startedBy: uuid(4) },
  'import.run.finished': { ...base, type: 'import.run.finished', runId: uuid(2), source: 'slack', teamId: uuid(3), startedBy: uuid(4), outcome: 'done', channels: 3, messages: 200, matchedPeople: 4, placeholders: 2, skipped: 1 },
  'import.person.claimed': { ...base, type: 'import.person.claimed', source: 'slack', personId: uuid(5), placeholderActorId: uuid(6), messages: 42 },
} as const;

describe.each(Object.entries(samples))('%s', (type, valid) => {
  it('is registered at version 1 and parses its payload', () => {
    expect(latestVersion(type as keyof typeof eventRegistry)).toBe(1);
    expect(Object.keys(eventRegistry[type as keyof typeof eventRegistry])).toEqual(['1']);
    expect(parseEvent(valid)).toMatchObject({ type });
  });

  it('refuses a missing field, a negative count, an unknown source and another schema version', () => {
    for (const key of Object.keys(valid).filter((k) => k !== 'type' && k !== 'schemaVersion')) {
      expect(() => parseEvent({ ...valid, [key]: undefined }), key).toThrow();
    }
    expect(() => parseEvent({ ...valid, source: 'teams' })).toThrow();
    expect(() => parseEvent({ ...valid, schemaVersion: 2 })).toThrow();
    for (const key of ['size', 'people', 'channels', 'messages', 'skipped', 'matchedPeople', 'placeholders'] as const) {
      if (key in valid) expect(() => parseEvent({ ...valid, [key]: -1 }), key).toThrow();
    }
  });

  it('carries no name, address or text: extra fields do not come through', () => {
    const parsed = parseEvent({ ...valid, email: 'jon@outside.example', name: 'Jon', fileName: 'export.zip', body: 'secret' }) as unknown as Record<string, unknown>;
    for (const key of ['email', 'name', 'fileName', 'body']) expect(parsed[key], key).toBeUndefined();
  });
});

describe('import.run.finished', () => {
  it('names only the three ways a run ends', () => {
    for (const outcome of ['done', 'failed', 'cancelled']) expect(parseEvent({ ...samples['import.run.finished'], outcome })).toMatchObject({ outcome });
    expect(() => parseEvent({ ...samples['import.run.finished'], outcome: 'running' })).toThrow();
  });
});
