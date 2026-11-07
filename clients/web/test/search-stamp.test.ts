import { describe, expect, it } from 'vitest';
import { searchStamp } from '../src/search/stamp';

describe('the full date of a search hit', () => {
  it('reads weekday, day, month, year and the 24-hour time', () => {
    // built from local parts so the test holds in any time zone
    const d = new Date(2026, 10, 4, 14, 2);
    expect(searchStamp(d.toISOString())).toBe('Wed 4 Nov 2026, 14:02');
  });

  it('keeps the year for a date in another year and pads the time', () => {
    expect(searchStamp(new Date(2025, 0, 9, 7, 5).toISOString())).toBe('Thu 9 Jan 2025, 07:05');
  });

  it('answers nothing for a date it cannot read', () => {
    expect(searchStamp('not a date')).toBe('');
  });
});
