import { WorkshopReassessmentClosedEvent, WorkshopReassessmentCreatedEvent, WorkshopReplayStartedEvent, eventRegistry, latestVersion, parseEvent } from '../../src/events/index.ts';
import { describe, expect, it } from 'vitest';

// The events of replay and re-assessment (PLAN P7-07): registered at version 1, ids, names and a number only (never a message, a reply or a secret).

const ids = {
  workspaceId: '00000000-0000-7000-8000-00000000a001',
  teamId: '00000000-0000-7000-8000-0000000b0001',
  botId: '00000000-0000-7000-8000-0000000f0002',
  slug: 'tester',
  at: '2026-10-31T00:00:00.000Z',
};

const samples = {
  'workshop.reassessment.created': {
    type: 'workshop.reassessment.created',
    schemaVersion: 1,
    ...ids,
    reassessmentId: '00000000-0000-7000-8000-0000000f0020',
    reason: 'runner_revoked',
    subject: 'office-box',
  },
  'workshop.reassessment.closed': {
    type: 'workshop.reassessment.closed',
    schemaVersion: 1,
    ...ids,
    reassessmentId: '00000000-0000-7000-8000-0000000f0020',
    answer: 'dismissed',
  },
  'workshop.replay.started': {
    type: 'workshop.replay.started',
    schemaVersion: 1,
    ...ids,
    runId: '00000000-0000-7000-8000-0000000f0030',
    sessionId: '00000000-0000-7000-8000-0000000f0031',
    tokens: 1840,
  },
} as const;

describe.each(Object.entries(samples))('%s', (type, sample) => {
  it('is registered at version 1 and parses', () => {
    expect(eventRegistry[type as keyof typeof eventRegistry]).toBeDefined();
    expect(latestVersion(type as keyof typeof eventRegistry)).toBe(1);
    expect(parseEvent({ ...sample })).toMatchObject({ type, slug: 'tester' });
  });

  it('refuses a missing field, and the type has three parts', () => {
    const without: Record<string, unknown> = { ...sample };
    delete without['workspaceId'];
    expect(() => parseEvent({ ...without })).toThrow();
    expect(type.split('.').length).toBeGreaterThanOrEqual(3);
  });

  it('drops a field it does not know, so nothing extra rides along', () => {
    const parsed = parseEvent({ ...sample, body: 'a message that must never be carried' }) as Record<string, unknown>;
    expect(parsed['body']).toBeUndefined();
  });
});

describe('the fields', () => {
  it('refuses a reason or an answer outside the list', () => {
    expect(() => WorkshopReassessmentCreatedEvent.parse({ ...samples['workshop.reassessment.created'], reason: 'because' })).toThrow();
    expect(() => WorkshopReassessmentClosedEvent.parse({ ...samples['workshop.reassessment.closed'], answer: 'open' })).toThrow();
    expect(WorkshopReassessmentCreatedEvent.parse({ ...samples['workshop.reassessment.created'], reason: 'eval_dropped', subject: '' }).subject).toBe('');
  });

  it('refuses a negative cost and a name that is not a slug', () => {
    expect(() => WorkshopReplayStartedEvent.parse({ ...samples['workshop.replay.started'], tokens: -1 })).toThrow();
    expect(() => WorkshopReplayStartedEvent.parse({ ...samples['workshop.replay.started'], slug: 'Not A Slug' })).toThrow();
  });
});
