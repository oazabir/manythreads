import { describe, expect, it } from 'vitest';
import { sizeInWords } from '../src/units.ts';

// P20-TR1: the sentence "That would take you over your <size> of Personal space" printed "0 GB" for a small allowance.
describe('sizeInWords', () => {
  it('keeps the default allowance as "5 GB" and shows a part of a gigabyte with one decimal', () => {
    expect(sizeInWords(5 * 1024 ** 3)).toBe('5 GB');
    expect(sizeInWords(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(sizeInWords(20 * 1024 ** 3)).toBe('20 GB');
    expect(sizeInWords(10.4 * 1024 ** 3)).toBe('10 GB');
  });

  it('a small allowance is never rounded down to nothing', () => {
    expect(sizeInWords(512 * 1024 ** 2)).toBe('512 MB');
    expect(sizeInWords(1024 ** 2)).toBe('1 MB');
    expect(sizeInWords(1.25 * 1024 ** 2)).toBe('1.3 MB');
    expect(sizeInWords(80 * 1024)).toBe('80 KB');
    expect(sizeInWords(1000)).toBe('1000 bytes');
    expect(sizeInWords(1)).toBe('1 byte');
  });

  it('a value that is not a size reads as 0 bytes', () => {
    expect(sizeInWords(0)).toBe('0 bytes');
    expect(sizeInWords(-5)).toBe('0 bytes');
    expect(sizeInWords(Number.NaN)).toBe('0 bytes');
  });
});
