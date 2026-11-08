import { describe, expect, it } from 'vitest';
import { firstReadPending } from '../src/screens/knowledge/useFirstRead';

// A folder added from a connected app is read a few seconds later by a job: while that first read is pending the screen asks again, and it stops asking once the read is done, failed or paused.

describe('firstReadPending', () => {
  const connector = { kind: 'connector' as const, status: 'ready' as const, lastSyncedAt: null, error: null };
  it('waits for a connected folder that has not been read yet', () => {
    expect(firstReadPending([connector])).toBe(true);
    expect(firstReadPending([{ kind: 'upload', status: undefined, lastSyncedAt: null, error: null }, connector])).toBe(true);
  });
  it('stops once the folder was read, failed, or is paused', () => {
    expect(firstReadPending([{ ...connector, lastSyncedAt: '2026-11-08T10:00:00.000Z' }])).toBe(false);
    expect(firstReadPending([{ ...connector, error: 'The app did not answer.' }])).toBe(false);
    expect(firstReadPending([{ ...connector, status: 'paused' }])).toBe(false);
    expect(firstReadPending([{ ...connector, status: 'attention' }])).toBe(false);
  });
  it('ignores sources that are not connected apps, and an empty list', () => {
    expect(firstReadPending([{ kind: 'url', status: undefined, lastSyncedAt: null, error: null }])).toBe(false);
    expect(firstReadPending([])).toBe(false);
  });
});
