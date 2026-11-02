import { KnowledgeSyncMinutes } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { formatSize, RHYTHMS, sourceLine } from '../src/screens/bots/knowledge';

// The size shown beside a document on the Knowledge tab (PLAN P8-33): bytes, then KB with one decimal under 10 KB, then MB.
describe('the size of a knowledge document', () => {
  it('reads in plain units', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(20 * 1024)).toBe('20 KB');
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

// The Sources list under a base (PLAN P8-08, P8-33): how often each source is read again, and how its last read went.
describe('the rhythm choices of a source', () => {
  it('offer only values the server accepts, once each, with "only when pressed" first', () => {
    expect(RHYTHMS[0]?.minutes).toBeNull();
    const minutes = RHYTHMS.flatMap((r) => (r.minutes === null ? [] : [r.minutes]));
    expect(new Set(minutes).size).toBe(minutes.length);
    for (const m of minutes) expect(KnowledgeSyncMinutes.safeParse(m).success, String(m)).toBe(true);
  });
});

describe('the last read of a source', () => {
  it('says why it failed, or whether it has been read', () => {
    expect(sourceLine({ lastSyncedAt: null, error: null })).toBe('Not read yet');
    expect(sourceLine({ lastSyncedAt: '2026-11-01T10:00:00.000Z', error: null })).toBe('Read');
    expect(sourceLine({ lastSyncedAt: '2026-11-01T10:00:00.000Z', error: 'The site answered with an error (404).' })).toBe('Could not be read: The site answered with an error (404).');
  });
});
