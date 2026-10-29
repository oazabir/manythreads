import type { OpsHealthSnapshot } from '@manythreads/shared';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../src/config.ts';

/** A snapshot of a healthy system; a test changes the one thing it is about. */
export function healthy(overrides: Partial<OpsHealthSnapshot> = {}): OpsHealthSnapshot {
  return {
    takenAt: '2026-10-29T08:00:00.000Z',
    outbox: { backlog: 0, retrying: 0, oldestAgeSeconds: 0 },
    jobs: { ready: 0, running: 0, dead: 0, oldestReadyAgeSeconds: 0, queues: [] },
    runs: { slotsUsed: 1, slotsLimit: 6, queued: 0, oldestQueuedAgeSeconds: 0 },
    approvals: { pending: 0, oldestPendingAgeSeconds: 0 },
    budgets: { limits: 1, nearLimit: 0, exhausted: 0, maxBurnPercent: 10 },
    database: { connectionsUsed: 20, connectionsMax: 100 },
    process: { residentBytes: 200_000_000, heapUsedBytes: 90_000_000, eventLoopLagP99Seconds: 0.02, uptimeSeconds: 3600 },
    volumes: [
      { name: 'blobs', totalBytes: 100e9, freeBytes: 60e9, usedPercent: 40 },
      { name: 'repos', totalBytes: 50e9, freeBytes: 40e9, usedPercent: 20 },
    ],
    ...overrides,
  };
}

export const thresholds: Thresholds = { ...DEFAULT_THRESHOLDS };

export const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 29, 8, 0, 0) + minutes * 60_000);
