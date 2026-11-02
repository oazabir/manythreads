import { describe, expect, it } from 'vitest';
import { modelTimeoutMs } from '../src/limits.ts';

// How long the helper waits for one model answer. Found live on P7-04: real turns took 80 to 230 seconds, so the old two minutes ended sessions that were still working.

describe('the wait for one model answer', () => {
  it('is four minutes (240 seconds) unless the server says otherwise', () => {
    expect(modelTimeoutMs({})).toBe(240_000);
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: '' })).toBe(240_000);
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: 'soon' })).toBe(240_000);
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: '-5' })).toBe(240_000);
  });
  it('can be set, and stays between 10 seconds and 9 minutes', () => {
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: '300000' })).toBe(300_000);
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: '50' })).toBe(10_000);
    expect(modelTimeoutMs({ MANYTHREADS_WORKSHOP_MODEL_TIMEOUT_MS: '99999999' })).toBe(540_000);
  });
});
