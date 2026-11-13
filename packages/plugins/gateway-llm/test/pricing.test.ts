import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICE, costOfCall, priceOfModel } from '../src/pricing.ts';

describe('what a model call costs', () => {
  it('prices a Claude model by its family, with or without a provider prefix', () => {
    expect(priceOfModel('anthropic/claude-sonnet-5-5')).toEqual({ inUsd: 3, outUsd: 15 });
    expect(priceOfModel('claude-haiku-5-5')).toEqual({ inUsd: 1, outUsd: 5 });
    expect(priceOfModel('claude-opus-5-5')).toEqual({ inUsd: 5, outUsd: 25 });
  });

  it('never prices a model it does not know at zero', () => {
    expect(priceOfModel('default')).toEqual(DEFAULT_PRICE);
    expect(priceOfModel(null)).toEqual(DEFAULT_PRICE);
    expect(costOfCall('some/other-model', 1_000_000, 0)).toBeGreaterThan(0);
  });

  it('counts prompt and completion tokens at their own price', () => {
    // 2,000,000 prompt tokens at $3 + 100,000 completion tokens at $15 = $6 + $1.5
    expect(costOfCall('anthropic/claude-sonnet-5-5', 2_000_000, 100_000)).toBeCloseTo(7.5, 6);
    expect(costOfCall('anthropic/claude-sonnet-5-5', 0, 0)).toBe(0);
  });
});
