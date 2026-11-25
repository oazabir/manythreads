import { describe, expect, it } from 'vitest';
import type { MeetingSpace } from '@manythreads/shared';
import { newestFirst, peopleLine } from '../src/screens/meetings/MeetingsInbox';

const space = (title: string, createdAt: string): MeetingSpace =>
  ({ channelId: title, title, teamId: null, createdAt, memberCount: 2, liveMeetingId: null }) as unknown as MeetingSpace;

describe('the Meetings page list (P37-04)', () => {
  it('lists the newest meeting first and leaves the given list alone', () => {
    const given = [space('old', '2026-11-01T10:00:00.000Z'), space('new', '2026-11-20T10:00:00.000Z'), space('mid', '2026-11-10T10:00:00.000Z')];
    expect(newestFirst(given).map((s) => s.title)).toEqual(['new', 'mid', 'old']);
    expect(given.map((s) => s.title)).toEqual(['old', 'new', 'mid']);
  });

  it('says how many people are in a space', () => {
    expect(peopleLine(1)).toBe('1 person');
    expect(peopleLine(3)).toBe('3 people');
  });
});
