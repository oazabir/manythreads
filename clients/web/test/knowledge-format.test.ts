import { describe, expect, it } from 'vitest';
import { formatSize } from '../src/screens/bots/knowledge';

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
