import { describe, expect, it } from 'vitest';
import { runConcurrencyFrom } from '../../runtime-hermes/src/run-job.ts';
import { DEFAULT_THRESHOLDS, alertMailEnabled, alertsEnabled, recoverRoundsFrom, runSlotsLimitFrom, thresholdsFrom, volumesFrom } from '../src/config.ts';

describe('thresholdsFrom', () => {
  it('has the documented defaults', () => {
    expect(thresholdsFrom({})).toEqual({
      volumePercent: 85,
      outboxLagSeconds: 60,
      jobAgeSeconds: 600,
      runSlotsSeconds: 600,
      approvalAgeSeconds: 86_400,
      budgetPercent: 90,
      dbConnectionsPercent: 90,
    });
    expect(DEFAULT_THRESHOLDS.volumePercent).toBe(85);
  });

  it('reads each variable', () => {
    const t = thresholdsFrom({
      MANYTHREADS_ALERT_VOLUME_PERCENT: '70',
      MANYTHREADS_ALERT_OUTBOX_LAG_SECONDS: '30',
      MANYTHREADS_ALERT_JOB_AGE_SECONDS: '120',
      MANYTHREADS_ALERT_RUN_SLOTS_SECONDS: '300',
      MANYTHREADS_ALERT_APPROVAL_HOURS: '48',
      MANYTHREADS_ALERT_BUDGET_PERCENT: '80',
      MANYTHREADS_ALERT_DB_CONNECTIONS_PERCENT: '75',
    });
    expect(t).toEqual({ volumePercent: 70, outboxLagSeconds: 30, jobAgeSeconds: 120, runSlotsSeconds: 300, approvalAgeSeconds: 172_800, budgetPercent: 80, dbConnectionsPercent: 75 });
  });

  it('ignores nonsense, accepts 0 to switch a check off, and caps percents at 100', () => {
    const t = thresholdsFrom({ MANYTHREADS_ALERT_VOLUME_PERCENT: '250', MANYTHREADS_ALERT_OUTBOX_LAG_SECONDS: 'soon', MANYTHREADS_ALERT_JOB_AGE_SECONDS: '-5', MANYTHREADS_ALERT_RUN_SLOTS_SECONDS: '0' });
    expect(t.volumePercent).toBe(100);
    expect(t.outboxLagSeconds).toBe(60);
    expect(t.jobAgeSeconds).toBe(600);
    expect(t.runSlotsSeconds).toBe(0);
  });
});

describe('switches', () => {
  it('alerts are on unless MANYTHREADS_ALERTS=off', () => {
    expect(alertsEnabled({})).toBe(true);
    expect(alertsEnabled({ MANYTHREADS_ALERTS: 'OFF' })).toBe(false);
  });
  it('mail is on unless MANYTHREADS_ALERT_MAIL=0', () => {
    expect(alertMailEnabled({})).toBe(true);
    expect(alertMailEnabled({ MANYTHREADS_ALERT_MAIL: '0' })).toBe(false);
  });
  it('recovery takes three rounds unless set between 1 and 60', () => {
    expect(recoverRoundsFrom({})).toBe(3);
    expect(recoverRoundsFrom({ MANYTHREADS_ALERT_RECOVER_ROUNDS: '5' })).toBe(5);
    expect(recoverRoundsFrom({ MANYTHREADS_ALERT_RECOVER_ROUNDS: '0' })).toBe(3);
  });
});

describe('runSlotsLimitFrom', () => {
  it('matches the Hermes runtime: default 6, 1 to 64', () => {
    expect(runSlotsLimitFrom({})).toBe(6);
    expect(runSlotsLimitFrom({ MANYTHREADS_RUN_CONCURRENCY: '12' })).toBe(12);
    expect(runSlotsLimitFrom({ MANYTHREADS_RUN_CONCURRENCY: '0' })).toBe(6);
    expect(runSlotsLimitFrom({ MANYTHREADS_RUN_CONCURRENCY: '65' })).toBe(6);
  });
  it('gives the same answer as the Hermes runtime for every kind of value (the rule is repeated here, so this pins the copy)', () => {
    for (const raw of [undefined, '', ' ', '0', '1', '6', '12', '64', '65', '-3', '2.5', 'many', ' 8 ']) {
      const env = raw === undefined ? {} : { MANYTHREADS_RUN_CONCURRENCY: raw };
      expect(runSlotsLimitFrom(env), `value ${JSON.stringify(raw)}`).toBe(runConcurrencyFrom(env));
    }
  });
});

describe('volumesFrom', () => {
  it('measures the blob store and the repositories when their directories are set', () => {
    expect(volumesFrom({ MANYTHREADS_STORAGE_DIR: '/data/blobs', MANYTHREADS_REPO_DIR: '/data/repos' })).toEqual([
      { name: 'blobs', path: '/data/blobs' },
      { name: 'repos', path: '/data/repos' },
    ]);
  });
  it('skips the blob store when attachments live in S3, and anything unset', () => {
    expect(volumesFrom({ MANYTHREADS_STORAGE: 's3', MANYTHREADS_STORAGE_DIR: '/data/blobs' })).toEqual([]);
    expect(volumesFrom({})).toEqual([]);
  });
  it('adds named extras and refuses odd names and relative paths', () => {
    const v = volumesFrom({ MANYTHREADS_OPS_VOLUMES: 'backups=/backups, bad name=/x, rel=relative/path, blobs=/again' });
    expect(v).toEqual([{ name: 'backups', path: '/backups' }, { name: 'blobs', path: '/again' }]);
  });
});
