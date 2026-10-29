import { describe, expect, it } from 'vitest';
import { formatSearchText, hasSearchFilters, isSearchDay, parseSearchText, searchDayEnd, searchDayStart } from '../src/api/search/syntax.ts';

describe('parseSearchText', () => {
  it('reads each filter word and leaves the rest as text, in order', () => {
    const f = parseSearchText('rollback from:nadia in:#dev has:file has:link is:thread before:2026-10-01 after:2026-09-01 plan');
    expect(f).toEqual({ text: 'rollback plan', from: ['nadia'], in: ['dev'], has: ['file', 'link'], is: ['thread'], before: '2026-10-01', after: '2026-09-01' });
  });

  it('is case-insensitive in the word and the value of has/is, and drops @ and #', () => {
    const f = parseSearchText('FROM:@Nadia IN:#Dev Has:FILE IS:Thread');
    expect(f.from).toEqual(['Nadia']);
    expect(f.in).toEqual(['Dev']);
    expect(f.has).toEqual(['file']);
    expect(f.is).toEqual(['thread']);
    expect(f.text).toBe('');
  });

  it('reads a quoted value with spaces', () => {
    expect(parseSearchText('from:"Nadia Hamdan" budget').from).toEqual(['Nadia Hamdan']);
    expect(parseSearchText('from:"Nadia Hamdan" budget').text).toBe('budget');
    // an unclosed quote runs to the end
    expect(parseSearchText('x from:"Nadia Ham').from).toEqual(['Nadia Ham']);
  });

  it('keeps what is not a valid filter as text: unknown words, empty values, bad dates, has:pin', () => {
    for (const raw of ['foo:bar', 'from:', 'has:pin', 'has:video', 'is:open', 'before:yesterday', 'before:2026-02-30', 'after:2026-13-01', 'time 10:30', 'http://x.y/z']) {
      const f = parseSearchText(raw);
      expect(f.text, raw).toBe(raw);
      expect(hasSearchFilters(f), raw).toBe(false);
    }
  });

  it('repeats collapse, the last day wins, and names are capped at five', () => {
    const f = parseSearchText('from:a from:A has:file has:file before:2026-01-01 before:2026-02-02');
    expect(f.from).toEqual(['a']);
    expect(f.has).toEqual(['file']);
    expect(f.before).toBe('2026-02-02');
    const many = parseSearchText('from:a from:b from:c from:d from:e from:f');
    expect(many.from).toHaveLength(5);
    expect(many.text).toBe('from:f');
  });

  it('round-trips through formatSearchText', () => {
    const f = parseSearchText('from:"Nadia Hamdan" in:dev has:link is:thread after:2026-09-01 rollback plan');
    expect(parseSearchText(formatSearchText(f))).toEqual(f);
  });

  it('is linear: a hostile 200,000 character input parses at once', () => {
    const started = performance.now();
    for (const raw of ['from:"'.repeat(30_000), ':'.repeat(200_000), 'a:'.repeat(100_000), ' '.repeat(200_000) + 'x', 'from:a '.repeat(25_000)]) parseSearchText(raw);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('days', () => {
  it('accepts real days only', () => {
    expect(isSearchDay('2026-02-28')).toBe(true);
    expect(isSearchDay('2024-02-29')).toBe(true);
    expect(isSearchDay('2026-02-29')).toBe(false);
    expect(isSearchDay('2026-2-1')).toBe(false);
    // the database has no year 0000 and writes the end of 9999-12-31 as year 10000: such days stay plain text, never a server error
    expect(isSearchDay('0000-01-01')).toBe(false);
    expect(isSearchDay('9999-12-31')).toBe(false);
    expect(isSearchDay('0001-01-01')).toBe(true);
    expect(isSearchDay('9998-12-31')).toBe(true);
    expect(searchDayEnd('9998-12-31')).toBe('9999-01-01T00:00:00.000Z');
  });

  it('start and end of a day in UTC', () => {
    expect(searchDayStart('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(searchDayEnd('2026-10-31')).toBe('2026-11-01T00:00:00.000Z');
  });
});
