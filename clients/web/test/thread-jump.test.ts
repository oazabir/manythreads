import { describe, expect, it } from 'vitest';
import { atBottom, jumpAriaLabel, jumpLabel, newReplyCount } from '../src/channels/threadJump';

const ME = 'actor-omar';
const NADIA = 'actor-nadia';
// ids are time-ordered strings (uuid v7), so a fixed-width counter stands in for them
const reply = (n: number, authorId: string = NADIA, deletedAt: string | null = null) => ({ id: `0000-${String(n).padStart(4, '0')}`, authorId, deletedAt });
const id = (n: number) => reply(n).id;

describe('the thread panel counts new replies from others since the reader left the bottom', () => {
  it('counts replies after the watermark', () => {
    const list = [1, 2, 3, 4, 5].map((n) => reply(n));
    expect(newReplyCount(list, id(3), ME)).toBe(2);
    expect(newReplyCount(list, id(5), ME)).toBe(0);
  });

  it('does not count a deleted reply', () => {
    const list = [reply(1), reply(2), reply(3, NADIA, '2026-11-14T10:00:00Z')];
    expect(newReplyCount(list, id(1), ME)).toBe(1);
  });

  it('gives the same count when the same list is loaded again (a resync)', () => {
    const list = [1, 2, 3, 4].map((n) => reply(n));
    const again = list.map((r) => ({ ...r }));
    expect(newReplyCount(again, id(2), ME)).toBe(newReplyCount(list, id(2), ME));
    expect(newReplyCount(again, id(2), ME)).toBe(2);
  });

  it('does not count ids at or below the watermark: an older page from "Earlier replies"', () => {
    const older = [1, 2, 3].map((n) => reply(n));
    const shown = [10, 11, 12].map((n) => reply(n));
    expect(newReplyCount([...older, ...shown], id(12), ME)).toBe(0);
    expect(newReplyCount([...older, ...shown], id(10), ME)).toBe(2);
  });

  it("does not count the reader's own reply", () => {
    const list = [reply(1), reply(2, ME), reply(3)];
    expect(newReplyCount(list, id(1), ME)).toBe(1);
  });

  it('counts nothing when nobody is signed in', () => {
    expect(newReplyCount([reply(1), reply(2)], id(0), null)).toBe(0);
  });
});

describe('the words of the pill', () => {
  it('says "Jump to latest" with no count, then one reply, then many', () => {
    expect(jumpLabel(0)).toBe('Jump to latest');
    expect(jumpLabel(1)).toBe('1 new reply');
    expect(jumpLabel(7)).toBe('7 new replies');
  });

  it('names the action and the count for a screen reader', () => {
    expect(jumpAriaLabel(0)).toBe('Jump to latest');
    expect(jumpAriaLabel(1)).toBe('Jump to latest, 1 new reply');
    expect(jumpAriaLabel(2)).toBe('Jump to latest, 2 new replies');
  });
});

describe('at the bottom', () => {
  it('is closer than 40 px', () => {
    expect(atBottom(0)).toBe(true);
    expect(atBottom(39)).toBe(true);
    expect(atBottom(40)).toBe(false);
    expect(atBottom(41)).toBe(false);
  });
});
