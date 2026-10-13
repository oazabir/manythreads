import { describe, expect, it } from 'vitest';
import { retentionBatch, retentionMode } from '../src/config.ts';

// Only the word `on` deletes: a typo, an empty value or nothing at all is a dry run (the same rule as the blob garbage collector).

describe('retentionMode', () => {
  it.each([
    [undefined, 'dry-run'],
    ['', 'dry-run'],
    ['on', 'on'],
    ['ON', 'on'],
    [' on ', 'on'],
    ['off', 'off'],
    ['dry-run', 'dry-run'],
    ['true', 'dry-run'],
    ['1', 'dry-run'],
    ['yes', 'dry-run'],
    ['onn', 'dry-run'],
    ['enabled', 'dry-run'],
  ])('%j is %s', (raw, expected) => {
    expect(retentionMode({ MANYTHREADS_RETENTION: raw })).toBe(expected);
  });
});

describe('retentionBatch', () => {
  it('defaults to 500 runs and four times as many log lines a step', () => {
    expect(retentionBatch({})).toEqual({ runs: 500, logLines: 2000 });
  });

  it('takes a whole number from 1 to 5,000 and ignores anything else', () => {
    expect(retentionBatch({ MANYTHREADS_RETENTION_BATCH: '2' })).toEqual({ runs: 2, logLines: 8 });
    expect(retentionBatch({ MANYTHREADS_RETENTION_BATCH: '5000' })).toEqual({ runs: 5000, logLines: 10_000 });
    for (const bad of ['0', '-1', '5001', '1.5', 'many', '']) expect(retentionBatch({ MANYTHREADS_RETENTION_BATCH: bad }).runs).toBe(500);
  });
});
