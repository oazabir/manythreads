import { CreateMeetingSeriesRequest } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { agendaDay, agendaNotice, buildSeriesBody, repeatLabel } from '../src/screens/schedule/series';

// P17-05: the words the Schedule uses for a meeting series, and the request its form sends.

describe('a meeting series on the Schedule', () => {
  it('says how it repeats, until when, or that it stopped', () => {
    expect(repeatLabel({ frequency: 'weekly', untilDate: null, status: 'active' })).toBe('Every week');
    expect(repeatLabel({ frequency: 'biweekly', untilDate: null, status: 'active' })).toBe('Every 2 weeks');
    expect(repeatLabel({ frequency: 'monthly', untilDate: '2027-03-31', status: 'active' })).toMatch(/^Every month until .*2027/);
    expect(repeatLabel({ frequency: 'weekly', untilDate: null, status: 'stopped' })).toBe('Stopped');
  });

  it('sends a request the server accepts: the trimmed title, no end day as null, the time zone', () => {
    const input = {
      title: '  Weekly sync ',
      startsAt: '2026-12-01T09:00:00.000Z',
      endsAt: '2026-12-01T09:30:00.000Z',
      kind: 'video',
      agenda: '',
      inviteeIds: ['0190a000-0000-7000-8000-000000000001'],
      repeat: 'weekly',
      until: '',
      timeZone: 'Europe/Berlin',
    } as const;
    const body = buildSeriesBody(input);
    expect(CreateMeetingSeriesRequest.parse(body)).toMatchObject({ title: 'Weekly sync', frequency: 'weekly', untilDate: null, timeZone: 'Europe/Berlin' });
    expect(buildSeriesBody({ ...input, inviteeIds: [], repeat: 'monthly', until: '2027-01-31' }).untilDate).toBe('2027-01-31');
  });

  it('says who reads the agenda before a series is made, and names the agenda\'s day', () => {
    expect(agendaNotice('Engineering')).toBe(
      "Each meeting gets an agenda page in Engineering's files that everyone on Engineering can read and edit. Open action items from the last meeting are copied into the next agenda.",
    );
    expect(agendaDay('meetings/series/weekly-sync/2026-12-01-agenda.md')).toMatch(/1/);
    expect(agendaDay('meetings/series/weekly-sync/README.md')).toBeNull();
  });
});
