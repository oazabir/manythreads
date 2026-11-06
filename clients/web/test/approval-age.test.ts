import { describe, expect, it } from 'vitest';
import { APPROVAL_OVERDUE_HOURS } from '@manythreads/shared';
import { oldestFirst, waitAge } from '../src/screens/approvals/state';
import { navTone } from '../src/shell/nav';
import { NavContribution } from '@manythreads/shared';

const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('how long a request has waited', () => {
  it('uses one day as the line, from the shared constant', () => {
    expect(APPROVAL_OVERDUE_HOURS).toBe(24);
    expect(waitAge(ago(23 * HOUR + 59 * MIN), NOW).overdue).toBe(false);
    expect(waitAge(ago(24 * HOUR), NOW).overdue).toBe(true);
  });

  it('says it in words, so colour is never the only signal', () => {
    expect(waitAge(ago(10_000), NOW).label).toBe('Waiting just now');
    expect(waitAge(ago(12 * MIN), NOW).label).toBe('Waiting 12 min');
    expect(waitAge(ago(5 * HOUR + 40 * MIN), NOW).label).toBe('Waiting 5 h');
    expect(waitAge(ago(25 * HOUR), NOW).label).toBe('Waiting 1 day');
    expect(waitAge(ago(51 * HOUR), NOW).label).toBe('Waiting 2 days');
  });

  it('never goes negative when the server clock is a little ahead', () => {
    expect(waitAge(new Date(NOW + 5 * MIN).toISOString(), NOW)).toMatchObject({ hours: 0, overdue: false, label: 'Waiting just now' });
    expect(waitAge('not a date', NOW).overdue).toBe(false);
  });
});

describe('the Waiting list order', () => {
  it('is oldest first, whatever order the rows arrive in', () => {
    const rows = [
      { id: 'c', createdAt: ago(1 * HOUR) },
      { id: 'a', createdAt: ago(30 * HOUR) },
      { id: 'b', createdAt: ago(5 * HOUR) },
    ];
    expect(oldestFirst(rows).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    // the input is not changed
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('breaks a tie on the id, which is time-ordered', () => {
    const same = ago(HOUR);
    expect(oldestFirst([{ id: 'b', createdAt: same }, { id: 'a', createdAt: same }]).map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('the sidebar badge', () => {
  const approvals = NavContribution.parse({ id: 'approvals', order: 35, label: 'Approvals', kind: 'item', path: '/approvals', badge: { source: 'approvals.waiting', tone: 'quiet' } });
  const threads = NavContribution.parse({ id: 'threads', order: 30, label: 'Threads', kind: 'item', path: '/threads', badge: { source: 'threads.unread', tone: 'unread' } });

  it('turns amber while anything has waited over a day, and only for Approvals', () => {
    expect(navTone(approvals, { 'approvals.waiting': 3, 'approvals.overdue': 0 })).toBe('quiet');
    expect(navTone(approvals, { 'approvals.waiting': 3 })).toBe('quiet');
    expect(navTone(approvals, { 'approvals.waiting': 3, 'approvals.overdue': 1 })).toBe('attention');
    expect(navTone(threads, { 'threads.unread': 2, 'approvals.overdue': 1 })).toBe('unread');
  });
});
