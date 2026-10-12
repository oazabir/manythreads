import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { MemoryRetainLogEntry, eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P5-13 (`pnpm test:events`): the run-closed event the memory feed reads, and the retain log entry the API returns.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('bots.run.closed', () => {
  const valid = { type: 'bots.run.closed', schemaVersion: 1, workspaceId: uuid(1), teamId: uuid(2), botId: uuid(3), runId: uuid(4), trigger: 'mention', status: 'done' };

  it('is registered at version 1 and carries ids, the trigger and how the run ended', () => {
    expect(Object.keys(eventRegistry['bots.run.closed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    for (const status of ['done', 'failed', 'stopped']) expect(parseEvent({ ...valid, status })).toMatchObject({ status });
  });

  it.each([
    ['status', { status: 'running' }], // a run that is still going has not closed
    ['status', { status: 'cancelled' }],
    ['runId', { runId: 'not-a-uuid' }],
    ['teamId', { teamId: null }],
    ['trigger', { trigger: '' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('MemoryRetainLogEntry', () => {
  const valid = {
    id: uuid(9),
    workspaceId: uuid(1),
    teamId: uuid(2),
    store: 'team_bank',
    bank: 'team:kahf:engineering',
    sourceKind: 'message',
    sourceId: uuid(5),
    documentId: `feed:message:${uuid(5)}:0123456789abcdef`,
    contentHash: 'a'.repeat(64),
    outcome: 'retained',
    reason: '',
    runId: null,
    sourceScopes: [],
    actorId: uuid(6),
    link: '/t/engineering/c/dev?message=x',
    createdAt: '2026-10-12T09:00:00.000Z',
  };

  it('accepts a retained line and a withheld run line', () => {
    expect(MemoryRetainLogEntry.parse(valid)).toEqual(valid);
    const withheld = { ...valid, sourceKind: 'run', outcome: 'withheld', reason: 'person_source', documentId: null, contentHash: null, runId: uuid(4), sourceScopes: ['team', 'person'] };
    expect(MemoryRetainLogEntry.parse(withheld)).toEqual(withheld);
  });

  it.each([
    ['outcome', { outcome: 'kept' }],
    ['sourceKind', { sourceKind: 'email' }],
    ['store', { store: 'cloud' }],
    ['sourceScopes', { sourceScopes: ['workspace'] }],
    ['createdAt', { createdAt: 'yesterday' }],
  ])('refuses a bad %s', (field, over) => {
    const parsed = MemoryRetainLogEntry.safeParse({ ...valid, ...over });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((i) => i.path.join('.')).some((p) => p.startsWith(field))).toBe(true);
  });
});
