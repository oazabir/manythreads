import { describe, expect, it } from 'vitest';
import { toRetentionSettings, toRetentionWindows } from '../src/rows.ts';

// The one mapper of retention_settings: defaults for a workspace that never changed anything, the bounds again, and a summary that cannot be
// read is no summary rather than a 500.

const summary = {
  sweepId: '0190a000-0000-7000-8000-000000000001',
  dryRun: false,
  startedAt: '2026-10-13T03:07:00.000Z',
  finishedAt: '2026-10-13T03:08:00.000Z',
  runLogCutoff: '2026-07-15T03:07:00.000Z',
  memoryLogCutoff: '2025-10-13T03:07:00.000Z',
  counts: { runs: 3, runsSkipped: 0, runSourceLines: 9, runTokens: 3, runMemos: 1, memoryLogLines: 2, memosRemoved: 0 },
};

describe('toRetentionSettings', () => {
  it('a workspace with no row has the defaults, no sweep and no change', () => {
    expect(toRetentionSettings(undefined, 'dry-run')).toEqual({ runLogDays: 90, memoryLogDays: 365, mode: 'dry-run', lastSweep: null, lastDryRun: null, updatedAt: null });
  });

  it('keeps the real sweep and the dry run apart, and updatedAt null for a row nobody changed', () => {
    const settings = toRetentionSettings({ run_log_days: 90, memory_log_days: 365, last_sweep: summary, last_dry_run: { ...summary, dryRun: true }, updated_at: null }, 'on');
    expect(settings.lastSweep).toMatchObject({ dryRun: false });
    expect(settings.lastDryRun).toMatchObject({ dryRun: true });
    expect(settings.updatedAt).toBeNull();
    expect(toRetentionSettings({ run_log_days: 60, memory_log_days: 365, last_sweep: null, last_dry_run: null, updated_at: new Date('2026-10-01T00:00:00Z') }, 'on').updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('a summary that is not a summary is none', () => {
    expect(toRetentionSettings({ run_log_days: 90, memory_log_days: 365, last_sweep: { nope: 1 }, last_dry_run: '{}', updated_at: null }, 'on').lastSweep).toBeNull();
  });
});

describe('toRetentionWindows', () => {
  it('clamps a hand-edited row to the bounds', () => {
    expect(toRetentionWindows({ run_log_days: 1, memory_log_days: 5 })).toEqual({ runLogDays: 30, memoryLogDays: 90 });
    expect(toRetentionWindows({ run_log_days: 99999, memory_log_days: 99999 })).toEqual({ runLogDays: 3650, memoryLogDays: 3650 });
  });
});
