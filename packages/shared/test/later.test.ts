import { describe, expect, it } from 'vitest';
import {
  LATER_MAX_AHEAD_MS,
  LATER_PAST_SKEW_MS,
  LATER_TIME_FAR,
  LATER_TIME_PAST,
  LaterItem,
  SaveLaterRequest,
  UpdateLaterRequest,
  checkRemindAt,
} from '../src/index.ts';
import { uuid } from './fixtures.ts';

// P14-04: the rule about reminder times, and the shapes the Later routes speak.

const NOW = new Date('2026-10-30T12:00:00.000Z');

describe('checkRemindAt', () => {
  it('accepts a time ahead as it is', () => {
    const r = checkRemindAt('2026-10-30T12:20:00.000Z', NOW);
    expect(r).toEqual({ ok: true, at: new Date('2026-10-30T12:20:00.000Z') });
  });

  it('treats a time a few seconds in the past as now, and refuses one older than the slack', () => {
    const near = checkRemindAt(new Date(NOW.getTime() - 5_000), NOW);
    expect(near).toEqual({ ok: true, at: NOW });
    expect(checkRemindAt(new Date(NOW.getTime() - LATER_PAST_SKEW_MS), NOW).ok).toBe(true);
    expect(checkRemindAt(new Date(NOW.getTime() - LATER_PAST_SKEW_MS - 1), NOW)).toEqual({ ok: false, reason: LATER_TIME_PAST });
  });

  it('refuses more than a year ahead, and allows exactly a year', () => {
    expect(checkRemindAt(new Date(NOW.getTime() + LATER_MAX_AHEAD_MS), NOW).ok).toBe(true);
    expect(checkRemindAt(new Date(NOW.getTime() + LATER_MAX_AHEAD_MS + 1), NOW)).toEqual({ ok: false, reason: LATER_TIME_FAR });
  });

  it('refuses what is not a time', () => {
    expect(checkRemindAt('tomorrow', NOW)).toEqual({ ok: false, reason: 'That is not a time.' });
    expect(checkRemindAt(new Date('nope'), NOW).ok).toBe(false);
  });
});

describe('the Later request and item shapes', () => {
  it('a save request takes a time, null or nothing, and no other field', () => {
    expect(SaveLaterRequest.parse({})).toEqual({});
    expect(SaveLaterRequest.parse({ remindAt: null })).toEqual({ remindAt: null });
    expect(SaveLaterRequest.parse({ remindAt: '2026-10-31T09:00:00.000Z' }).remindAt).toBe('2026-10-31T09:00:00.000Z');
    expect(() => SaveLaterRequest.parse({ remindAt: 'tomorrow' })).toThrow();
    expect(() => SaveLaterRequest.parse({ remindAt: null, personId: uuid(1) })).toThrow();
  });

  it('an update request is a state, nothing else', () => {
    expect(UpdateLaterRequest.parse({ state: 'done' })).toEqual({ state: 'done' });
    expect(() => UpdateLaterRequest.parse({ state: 'later' })).toThrow();
    expect(() => UpdateLaterRequest.parse({ state: 'open', remindAt: null })).toThrow();
  });

  it('an item whose message is no longer readable carries no message at all', () => {
    const item = LaterItem.parse({
      id: uuid(1), messageId: uuid(2), state: 'open', remindAt: null, due: false, createdAt: '2026-10-30T12:00:00.000Z', doneAt: null, message: null,
    });
    expect(item.message).toBeNull();
  });
});
