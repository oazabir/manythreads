import { describe, expect, it } from 'vitest';
import {
  EditScheduledRequest,
  SCHEDULED_MAX_AHEAD_MS,
  SCHEDULED_PAST_SKEW_MS,
  SCHEDULED_TIME_BAD,
  SCHEDULED_TIME_FAR,
  SCHEDULED_TIME_PAST,
  ScheduleMessageRequest,
  checkSendAt,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

const now = new Date('2026-11-01T12:00:00.000Z');

describe('checkSendAt', () => {
  it('accepts a time ahead and returns it as it was given', () => {
    const r = checkSendAt('2026-11-01T12:30:00.000Z', now);
    expect(r).toEqual({ ok: true, at: new Date('2026-11-01T12:30:00.000Z') });
  });

  it('lets a minute of slack count as now, and refuses what is older', () => {
    const slack = new Date(now.getTime() - SCHEDULED_PAST_SKEW_MS);
    expect(checkSendAt(slack, now)).toEqual({ ok: true, at: now });
    expect(checkSendAt(new Date(slack.getTime() - 1), now)).toEqual({ ok: false, reason: SCHEDULED_TIME_PAST });
  });

  it('refuses a time more than a year ahead and one that is not a time', () => {
    expect(checkSendAt(new Date(now.getTime() + SCHEDULED_MAX_AHEAD_MS), now).ok).toBe(true);
    expect(checkSendAt(new Date(now.getTime() + SCHEDULED_MAX_AHEAD_MS + 1), now)).toEqual({ ok: false, reason: SCHEDULED_TIME_FAR });
    expect(checkSendAt('soon', now)).toEqual({ ok: false, reason: SCHEDULED_TIME_BAD });
  });
});

describe('scheduled message requests', () => {
  const sendAt = '2026-11-02T09:00:00.000Z';

  it('accepts a text and a time, with or without a thread', () => {
    expect(ScheduleMessageRequest.parse({ body: 'hello', sendAt })).toMatchObject({ body: 'hello' });
    expect(ScheduleMessageRequest.parse({ body: 'hello', sendAt, threadRootId: uuid(7) }).threadRootId).toBe(uuid(7));
  });

  it('refuses an empty text, an unknown field (no attachments yet) and a bad time', () => {
    expect(() => ScheduleMessageRequest.parse({ body: '', sendAt })).toThrow();
    expect(() => ScheduleMessageRequest.parse({ body: 'x', sendAt, attachments: [] })).toThrow();
    expect(() => ScheduleMessageRequest.parse({ body: 'x', sendAt: 'tomorrow' })).toThrow();
  });

  it('an edit changes the text, the time or both, and never nothing', () => {
    expect(EditScheduledRequest.parse({ body: 'new' })).toEqual({ body: 'new' });
    expect(EditScheduledRequest.parse({ sendAt })).toEqual({ sendAt });
    expect(() => EditScheduledRequest.parse({})).toThrow();
    expect(() => EditScheduledRequest.parse({ body: 'x', state: 'refused' })).toThrow();
  });
});
