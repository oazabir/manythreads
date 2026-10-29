import { describe, expect, it } from 'vitest';
import type { OpsHealthCheck } from '@manythreads/shared';
import { checkStatus, formatBytes, formatCheckValue, formatLimit, formatSeconds } from '../src/screens/health/format';

const check = (over: Partial<OpsHealthCheck> = {}): OpsHealthCheck => ({
  name: 'outbox_lag',
  label: 'Outbox lag',
  unit: 'seconds',
  value: 5,
  threshold: 60,
  breached: false,
  since: null,
  ...over,
});

describe('System health formatting', () => {
  it('writes lengths of time the way a person reads them', () => {
    expect(formatSeconds(45)).toBe('45 s');
    expect(formatSeconds(600)).toBe('10 min');
    expect(formatSeconds(36_000)).toBe('10 h');
    expect(formatSeconds(5 * 86_400)).toBe('5 d');
  });

  it('writes sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(60e9)).toBe('55.9 GB');
  });

  it('reads a check as its value and its limit', () => {
    expect(formatCheckValue(check())).toBe('5 s');
    expect(formatCheckValue(check({ unit: 'percent', value: 91.234, threshold: 85 }))).toBe('91.2 %');
    expect(formatCheckValue(check({ value: null }))).toBe('not measured');
    expect(formatLimit(check({ threshold: 0 }))).toBe('off');
    expect(formatLimit(check({ unit: 'percent', threshold: 85 }))).toBe('85 %');
  });

  it('gives each check one status', () => {
    expect(checkStatus(check()).tone).toBe('ok');
    expect(checkStatus(check({ breached: true })).tone).toBe('fail');
    expect(checkStatus(check({ threshold: 0 })).word).toBe('Off');
    expect(checkStatus(check({ value: null })).word).toBe('Unknown');
  });
});
