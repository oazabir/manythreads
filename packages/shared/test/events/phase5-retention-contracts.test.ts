import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  MemoryRunMemo,
  MemorySourceKind,
  RETENTION_MEMORY_LOG_DAYS,
  RETENTION_RUN_LOG_DAYS,
  RetentionSettings,
  SetRetentionSettingsRequest,
  eventRegistry,
  parseEvent,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P5-14 (`pnpm test:events`): the two audit events retention writes, the settings shape and its bounds, and the new source kind of
// the retain log.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('retention.sweep.completed', () => {
  const valid = {
    type: 'retention.sweep.completed',
    schemaVersion: 1,
    workspaceId: uuid(1),
    sweepId: uuid(2),
    dryRun: false,
    runLogCutoff: '2026-07-15T03:07:00.000Z',
    memoryLogCutoff: '2025-10-13T03:07:00.000Z',
    counts: { runs: 12, runsSkipped: 0, runSourceLines: 80, runTokens: 12, runMemos: 1, memoryLogLines: 40, memosRemoved: 0 },
    durationMs: 1500,
  };

  it('is registered at version 1 and carries cutoffs and counts, never an id of what was removed', () => {
    expect(Object.keys(eventRegistry['retention.sweep.completed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
    expect(JSON.stringify(Object.keys(valid))).not.toMatch(/runIds|ids|lines"/);
  });

  it.each([
    ['dryRun', { dryRun: 'no' }],
    ['counts.runs', { counts: { ...valid.counts, runs: -1 } }],
    ['counts.runMemos', { counts: { ...valid.counts, runMemos: 1.5 } }],
    ['runLogCutoff', { runLogCutoff: 'last quarter' }],
    ['sweepId', { sweepId: 'abc' }],
    ['durationMs', { durationMs: -5 }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('retention.settings.changed', () => {
  const valid = {
    type: 'retention.settings.changed',
    schemaVersion: 1,
    workspaceId: uuid(1),
    changedBy: uuid(3),
    runLogDays: { from: 90, to: 60 },
    memoryLogDays: { from: 365, to: 365 },
    changedAt: '2026-10-13T09:00:00.000Z',
  };

  it('is registered and says who changed what from what to what', () => {
    expect(Object.keys(eventRegistry['retention.settings.changed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });

  it.each([
    ['changedBy', { changedBy: null }],
    ['runLogDays.to', { runLogDays: { from: 90, to: 0 } }],
    ['memoryLogDays', { memoryLogDays: 365 }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over }).some((p) => p.startsWith(field.split('.')[0]!))).toBe(true);
  });
});

describe('RetentionSettings and its request', () => {
  it('state their bounds once', () => {
    expect(RETENTION_RUN_LOG_DAYS).toEqual({ min: 30, default: 90, max: 3650 });
    expect(RETENTION_MEMORY_LOG_DAYS).toEqual({ min: 90, default: 365, max: 3650 });
  });

  it('a request needs a field in bounds and nothing else', () => {
    expect(SetRetentionSettingsRequest.safeParse({ runLogDays: 30 }).success).toBe(true);
    expect(SetRetentionSettingsRequest.safeParse({ memoryLogDays: 3650 }).success).toBe(true);
    for (const bad of [{}, { runLogDays: 29 }, { runLogDays: 3651 }, { memoryLogDays: 89 }, { runLogDays: 60, extra: true }, { runLogDays: '60' }]) {
      expect(SetRetentionSettingsRequest.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a settings answer has no field named like a credential or a hash', () => {
    const shown = RetentionSettings.parse({ runLogDays: 90, memoryLogDays: 365, mode: 'dry-run', lastSweep: null, lastDryRun: null, updatedAt: null });
    expect(Object.keys(shown).join(' ')).not.toMatch(/hash|secret|token|key|password/i);
  });
});

describe('MemorySourceKind', () => {
  it('has concept after run_tool (the order is the SQL CHECK’s)', () => {
    expect(MemorySourceKind.options).toEqual(['message', 'thread', 'run', 'approval', 'page', 'run_tool', 'concept']);
  });
});

describe('MemoryRunMemo', () => {
  const valid = {
    runId: uuid(4),
    workspaceId: uuid(1),
    teamId: uuid(2),
    botId: uuid(3),
    startedAt: '2026-07-01T10:00:00.000Z',
    endedAt: '2026-07-01T10:05:00.000Z',
    retainRefusal: 'person_source',
    approvalIds: [uuid(9)],
    memoizedAt: '2026-10-13T03:07:00.000Z',
  };
  it('is the memo of a pruned run: window, bot, refusal and approvals', () => {
    expect(MemoryRunMemo.parse(valid)).toEqual(valid);
    expect(MemoryRunMemo.parse({ ...valid, retainRefusal: null }).retainRefusal).toBeNull();
    expect(MemoryRunMemo.safeParse({ ...valid, approvalIds: ['x'] }).success).toBe(false);
  });
});
