import { describe, expect, it } from 'vitest';
import { joinable, onDay, placeInDay, step, viewDays } from '../src/screens/schedule/calendar';

// P36-05: the Schedule screen's calendar arithmetic.

const at = (d: number, h: number, m = 0): string => new Date(2026, 10, d, h, m).toISOString();
const a = (id: string, d: number, h1: number, h2: number, m2 = 0) => ({ id, startsAt: at(d, h1), endsAt: at(d, h2, m2) });

describe('the calendar', () => {
  it('a week is Monday to Sunday; a month view covers whole weeks; steps move by the view', () => {
    const week = viewDays('week', new Date(2026, 10, 25)); // Wednesday 25 Nov 2026
    expect(week.map((d) => d.getDate())).toEqual([23, 24, 25, 26, 27, 28, 29]);
    const month = viewDays('month', new Date(2026, 10, 10));
    expect(month.length % 7).toBe(0);
    expect(month[0]!.getDay()).toBe(1);
    expect(month.some((d) => d.getMonth() === 10 && d.getDate() === 30)).toBe(true);
    expect(step('month', new Date(2026, 10, 10), 1).getMonth()).toBe(11);
    expect(step('week', new Date(2026, 10, 25), -1).getDate()).toBe(18);
  });

  it('places blocks by time, side by side when they overlap', () => {
    const day = new Date(2026, 10, 25);
    const placed = placeInDay([a('x', 25, 9, 10), a('y', 25, 9, 11), a('z', 25, 12, 13)], day);
    const byId = Object.fromEntries(placed.map((p) => [p.item.id, p]));
    expect(byId['x']!.top).toBeCloseTo(9 / 24);
    expect(byId['y']!.height).toBeCloseTo(2 / 24);
    expect(byId['x']!.lanes).toBe(2);
    expect(new Set([byId['x']!.lane, byId['y']!.lane])).toEqual(new Set([0, 1]));
    expect(byId['z']).toMatchObject({ lane: 0, lanes: 1 });
    expect(onDay([a('x', 25, 9, 10), a('w', 26, 9, 10)], day).map((x) => x.id)).toEqual(['x']);
  });

  it('offers Join from ten minutes before until the end, never for a cancelled one', () => {
    const appt = { startsAt: at(25, 14), endsAt: at(25, 15), status: 'scheduled' };
    expect(joinable(appt, Date.parse(at(25, 13, 45)))).toBe(false);
    expect(joinable(appt, Date.parse(at(25, 13, 52)))).toBe(true);
    expect(joinable(appt, Date.parse(at(25, 15, 0)))).toBe(false);
    expect(joinable({ ...appt, status: 'cancelled' }, Date.parse(at(25, 14, 10)))).toBe(false);
  });
});
