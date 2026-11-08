import { describe, expect, it } from 'vitest';
import { eventRegistry, latestVersion, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Event contract of P15-01 (`pnpm test:events`): the seven voice-room events have a registered v1 schema, carry ids and times (never a title, a word spoken or a
// note), and refuse what breaks them. The meetings plugin's own test proves the real code path writes these shapes.

const base = { schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), channelId: uuid(3), meetingId: uuid(4), at: '2026-11-03T10:00:00.000Z' };
const SAMPLES = {
  'meetings.meeting.started': { ...base, type: 'meetings.meeting.started', startedBy: uuid(5) },
  'meetings.meeting.ended': { ...base, type: 'meetings.meeting.ended', endedBy: uuid(5), reason: 'person', durationSeconds: 600, participantCount: 3 },
  'meetings.participant.joined': { ...base, type: 'meetings.participant.joined', actorId: uuid(5), rejoined: false },
  'meetings.participant.left': { ...base, type: 'meetings.participant.left', actorId: uuid(5), how: 'kicked' },
  'meetings.consent.changed': { ...base, type: 'meetings.consent.changed', actorId: uuid(5), subject: 'transcribe', value: 'yes' },
  'meetings.transcript.written': { ...base, type: 'meetings.transcript.written', path: 'meetings/2026-11-03-standup.md', store: 'repo', lineCount: 42 },
  'meetings.notes.written': { ...base, type: 'meetings.notes.written', writtenBy: uuid(6), path: 'meetings/2026-11-03-standup-notes.md', store: 'files', actionOwnerIds: [] },
  'meetings.notetaker.added': { ...base, type: 'meetings.notetaker.added', botId: uuid(7), addedBy: uuid(5) },
  'meetings.notetaker.removed': { ...base, type: 'meetings.notetaker.removed', botId: uuid(7), removedBy: null },
  'meetings.recording.started': { ...base, type: 'meetings.recording.started', startedBy: uuid(5), people: 3 },
  'meetings.recording.stopped': { ...base, type: 'meetings.recording.stopped', reason: 'consent_withdrawn', stoppedBy: null },
  'meetings.notes.shared': { ...base, type: 'meetings.notes.shared', sharedBy: uuid(5), granteeKind: 'person', granteeId: uuid(8), revoked: false },
  'meetings.notes.saved': { ...base, type: 'meetings.notes.saved', savedBy: uuid(5), path: 'meetings/2026/11/03-1000-standup', toMemory: true },
} as const;
const TYPES = Object.keys(SAMPLES) as (keyof typeof SAMPLES)[];

describe('voice room events', () => {
  it.each(TYPES)('%s is registered at version 1 and parses its payload unchanged', (type) => {
    expect(latestVersion(type)).toBe(1);
    expect(Object.keys(eventRegistry[type])).toEqual(['1']);
    expect(parseEvent(SAMPLES[type])).toEqual(SAMPLES[type]);
  });

  it.each(TYPES)('%s refuses a missing id, a malformed id, a bad time and another schema version', (type) => {
    for (const key of ['workspaceId', 'meetingId', 'at'] as const) expect(() => parseEvent({ ...SAMPLES[type], [key]: undefined }), key).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], meetingId: 'not-a-uuid' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], at: 'yesterday' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES[type], schemaVersion: 2 })).toThrow();
  });

  it.each(TYPES)('%s carries no title, spoken text or note text', (type) => {
    const keys = Object.keys(SAMPLES[type]);
    for (const forbidden of ['title', 'text', 'body', 'transcript', 'notes', 'token']) expect(keys).not.toContain(forbidden);
    const parsed = parseEvent({ ...SAMPLES[type], title: 'secret plan', text: 'secret', token: 'abc' }) as unknown as Record<string, unknown>;
    for (const forbidden of ['title', 'text', 'token']) expect(parsed[forbidden]).toBeUndefined();
  });

  it('notes written name who owns the action items, and older events without the list still parse', () => {
    const older: Record<string, unknown> = { ...SAMPLES['meetings.notes.written'] };
    delete older.actionOwnerIds;
    expect(parseEvent(older)).toMatchObject({ actionOwnerIds: [] });
    expect(parseEvent({ ...SAMPLES['meetings.notes.written'], actionOwnerIds: [uuid(5)] })).toMatchObject({ actionOwnerIds: [uuid(5)] });
    expect(() => parseEvent({ ...SAMPLES['meetings.notes.written'], actionOwnerIds: ['x'] })).toThrow();
  });

  it('recording stops for a known reason only; sharing names a person or a channel', () => {
    expect(() => parseEvent({ ...SAMPLES['meetings.recording.stopped'], reason: 'bored' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.notes.shared'], granteeKind: 'bot' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.recording.started'], people: 0 })).toThrow();
  });

  it('a call in a direct message has no team and may have no channel yet', () => {
    expect(parseEvent({ ...SAMPLES['meetings.meeting.started'], teamId: null })).toMatchObject({ teamId: null });
    expect(parseEvent({ ...SAMPLES['meetings.meeting.started'], channelId: null })).toMatchObject({ channelId: null });
  });

  it('closed by itself has no closer; the reason is a person or empty', () => {
    expect(parseEvent({ ...SAMPLES['meetings.meeting.ended'], endedBy: null, reason: 'empty' })).toMatchObject({ endedBy: null, reason: 'empty' });
    expect(() => parseEvent({ ...SAMPLES['meetings.meeting.ended'], reason: 'admin' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.meeting.ended'], durationSeconds: -1 })).toThrow();
  });

  it('a person leaves by leaving, being kicked, being dropped or the room ending', () => {
    for (const how of ['left', 'kicked', 'dropped', 'ended']) expect(parseEvent({ ...SAMPLES['meetings.participant.left'], how })).toMatchObject({ how });
    expect(() => parseEvent({ ...SAMPLES['meetings.participant.left'], how: 'vanished' })).toThrow();
  });

  it('consent answers are a known subject and a known value', () => {
    expect(() => parseEvent({ ...SAMPLES['meetings.consent.changed'], subject: 'camera' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.consent.changed'], value: 'maybe' })).toThrow();
  });

  it('written transcripts and notes name a known place', () => {
    expect(() => parseEvent({ ...SAMPLES['meetings.transcript.written'], store: 'dropbox' })).toThrow();
    expect(() => parseEvent({ ...SAMPLES['meetings.notes.written'], path: '' })).toThrow();
  });
});
