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
  it('changes word exactly at the edges: 5 minutes, 1 day, 2 days and a week', () => {
    expect(lastActiveText(ago(5 * MIN - 1), NOW)).toBe('Active now');
    expect(lastActiveText(ago(5 * MIN), NOW)).toBe('5 minutes ago');
    expect(lastActiveText(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(lastActiveText(ago(24 * HOUR), NOW)).toBe('Yesterday');
    expect(lastActiveText(ago(2 * DAY), NOW)).toBe('2 days ago');
    expect(lastActiveText(ago(7 * DAY), NOW)).toBe('30 Oct 2026');
  });
  it('does not throw on a time it cannot read', () => {
    expect(lastActiveText('not a time', NOW)).toBe('Unknown');
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
  it('does not change the list it was given, and a person with no match is left out', () => {
    const copy = [...people];
    expect(filterMembers(people, 'nobody')).toEqual([]);
    expect(people).toEqual(copy);
    expect(filterMembers(people, '')).not.toBe(people);
  });
  it('needs every word to match', () => {
    expect(filterMembers(people, 'omar zabir')).toHaveLength(1);
    expect(filterMembers(people, 'omar lena')).toHaveLength(0);
  });
});
