import { describe, expect, it } from 'vitest';
import { filterMembers, lastActiveText } from '../src/screens/members';

const NOW = new Date('2026-11-06T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('lastActiveText', () => {
  it('says so when nobody has ever signed in', () => {
    expect(lastActiveText(null, NOW)).toBe('Never signed in');
  });
  it('reads minutes, hours, yesterday, days and then a date', () => {
    expect(lastActiveText(ago(2 * MIN), NOW)).toBe('Active now');
    expect(lastActiveText(ago(12 * MIN), NOW)).toBe('12 minutes ago');
    expect(lastActiveText(ago(HOUR + 5 * MIN), NOW)).toBe('1 hour ago');
    expect(lastActiveText(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(lastActiveText(ago(30 * HOUR), NOW)).toBe('Yesterday');
    expect(lastActiveText(ago(4 * DAY), NOW)).toBe('4 days ago');
    expect(lastActiveText('2026-09-03T08:00:00.000Z', NOW)).toBe('3 Sep 2026');
  });
  it('treats a time slightly in the future (clock skew) as now', () => {
    expect(lastActiveText(new Date(NOW.getTime() + 30_000).toISOString(), NOW)).toBe('Active now');
  });
});

describe('filterMembers', () => {
  const people = [
    { displayName: 'Omar Al Zabir', email: 'omar@kahf.example' },
    { displayName: 'Nadia R.', email: 'nadia@kahf.example' },
    { displayName: 'Lena M.', email: 'lena@partner.example' },
  ];
  it('keeps everyone for an empty search', () => {
    expect(filterMembers(people, '  ')).toHaveLength(3);
  });
  it('matches the name or the email, ignoring case', () => {
    expect(filterMembers(people, 'NADIA').map((p) => p.displayName)).toEqual(['Nadia R.']);
    expect(filterMembers(people, 'partner').map((p) => p.displayName)).toEqual(['Lena M.']);
  });
  it('needs every word to match', () => {
    expect(filterMembers(people, 'omar zabir')).toHaveLength(1);
    expect(filterMembers(people, 'omar lena')).toHaveLength(0);
  });
});
