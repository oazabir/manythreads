import { HttpError } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { GROUPS_PER_MINUTE, PEOPLE_PER_HOUR, createMentionBudget } from '../src/mention-budget.ts';

// The budget of group mentions (P14-03): per author and team, a sliding minute for how many groups and a sliding hour for how many people.

const clock = () => {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const refusal = (fn: () => void): HttpError => {
  try {
    fn();
  } catch (err) {
    return err as HttpError;
  }
  throw new Error('expected a refusal');
};

describe('the group mention budget', () => {
  it('allows five group mentions a minute and then says so in a plain sentence', () => {
    const c = clock();
    const b = createMentionBudget(c.now);
    for (let i = 0; i < GROUPS_PER_MINUTE; i++) b.take('a:t', 1, 2);
    const err = refusal(() => b.take('a:t', 1, 2));
    expect(err.status).toBe(429);
    expect(err.message).toBe('You mentioned groups too often; try again in a minute.');
    expect(Number(err.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts the groups of one message together: six groups in one message are too many', () => {
    const b = createMentionBudget(clock().now);
    expect(refusal(() => b.take('a:t', GROUPS_PER_MINUTE + 1, 6)).status).toBe(429);
  });

  it('is a sliding window: the oldest mention frees its place a minute after it was made', () => {
    const c = clock();
    const b = createMentionBudget(c.now);
    for (let i = 0; i < GROUPS_PER_MINUTE; i++) {
      b.take('a:t', 1, 1);
      c.advance(10_000);
    }
    expect(() => b.take('a:t', 1, 1)).toThrow();                // 50 s in: the first is still counted
    c.advance(10_000);                                          // 60 s after the first
    expect(() => b.take('a:t', 1, 1)).not.toThrow();
  });

  it('limits the people reached in an hour, and a refused message is not counted', () => {
    const c = clock();
    const b = createMentionBudget(c.now);
    b.take('a:t', 1, PEOPLE_PER_HOUR - 10);
    c.advance(120_000);
    const err = refusal(() => b.take('a:t', 1, 11));
    expect(err.message).toBe('Your group mentions have reached too many people this hour; try again later.');
    expect(() => b.take('a:t', 1, 10)).not.toThrow();           // the refused 11 was not kept
    c.advance(3_600_000);
    expect(() => b.take('a:t', 1, PEOPLE_PER_HOUR)).not.toThrow();
  });

  it('keeps each author and team apart', () => {
    const b = createMentionBudget(clock().now);
    for (let i = 0; i < GROUPS_PER_MINUTE; i++) b.take('a:t1', 1, 1);
    expect(() => b.take('a:t2', 1, 1)).not.toThrow();
    expect(() => b.take('b:t1', 1, 1)).not.toThrow();
  });
});
