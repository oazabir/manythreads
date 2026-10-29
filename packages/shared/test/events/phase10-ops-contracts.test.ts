import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { OpsHealthResponse, eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P10-10 (`pnpm test:events`): the one event the health watcher writes, and the shape of the System health answer.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('ops.health.changed', () => {
  const valid = {
    type: 'ops.health.changed',
    schemaVersion: 1,
    workspaceId: uuid(1),
    check: 'outbox_lag',
    state: 'breached',
    value: 95,
    threshold: 60,
    unit: 'seconds',
    since: '2026-10-29T08:00:00.000Z',
    changedAt: '2026-10-29T08:00:00.000Z',
  };

  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['ops.health.changed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(parseEvent({ ...valid, state: 'recovered', value: 3 })).toMatchObject({ state: 'recovered' });
  });

  it.each([
    ['state', { state: 'fixed' }],
    ['unit', { unit: 'bytes' }],
    ['check', { check: '' }],
    ['value', { value: 'high' }],
    ['since', { since: 'yesterday' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('OpsHealthResponse', () => {
  const snapshot = {
    takenAt: '2026-10-29T08:00:00.000Z',
    outbox: { backlog: 0, retrying: 0, oldestAgeSeconds: 0 },
    jobs: null,
    runs: { slotsUsed: 1, slotsLimit: 6, queued: 0, oldestQueuedAgeSeconds: 0 },
    approvals: null,
    budgets: null,
    database: { connectionsUsed: 5, connectionsMax: 100 },
    process: { residentBytes: 1, heapUsedBytes: 1, eventLoopLagP99Seconds: 0, uptimeSeconds: 1 },
    volumes: [{ name: 'blobs', totalBytes: 100, freeBytes: 60, usedPercent: 40 }],
  };

  it('accepts a section that could not be read as null', () => {
    const checks = [{ name: 'outbox_lag', label: 'Outbox lag', unit: 'seconds', value: null, threshold: 60, breached: false, since: null }];
    expect(OpsHealthResponse.parse({ snapshot, checks })).toMatchObject({ checks });
  });

  it('refuses a share of a volume outside 0 to 100', () => {
    expect(() => OpsHealthResponse.parse({ snapshot: { ...snapshot, volumes: [{ name: 'blobs', totalBytes: 1, freeBytes: 1, usedPercent: 140 }] }, checks: [] })).toThrow();
  });
});
