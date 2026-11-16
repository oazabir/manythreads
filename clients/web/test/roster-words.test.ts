import { describe, expect, it } from 'vitest';
import { plural, rosterCounts } from '../src/screens/rosterWords';

const def = (bots: number, channels: number) => ({ bots: new Array(bots).fill(0), channels: new Array(channels).fill(0) });

describe('rosterWords', () => {
  it('pluralises', () => {
    expect([0, 1, 2].map((n) => plural(n, 'person', 'people'))).toEqual(['0 people', '1 person', '2 people']);
    expect([0, 1, 2].map((n) => plural(n, 'bot', 'bots'))).toEqual(['0 bots', '1 bot', '2 bots']);
    expect([0, 1, 2].map((n) => plural(n, 'channel', 'channels'))).toEqual(['0 channels', '1 channel', '2 channels']);
  });
  it('shows only people without a definition', () => {
    expect(rosterCounts(1)).toBe('1 person');
    expect(rosterCounts(3)).toBe('3 people');
    expect(rosterCounts(3, null)).toBe('3 people');
  });
  it('adds bots and channels with a definition', () => {
    expect(rosterCounts(3, def(1, 1))).toBe('3 people, 1 bot, 1 channel');
    expect(rosterCounts(1, def(0, 2))).toBe('1 person, 0 bots, 2 channels');
    expect(rosterCounts(2, def(2, 1))).toBe('2 people, 2 bots, 1 channel');
  });
});
