import { describe, expect, it } from 'vitest';
import { groupCountText, matchGroups, mentionGroupsKey, resetMentionGroups } from '../src/channels/mentionGroups';
import { dropPersonData } from '../src/app/caches';

const groups = [
  { handle: 'on-call', tag: 'role:on-call', memberCount: 3 },
  { handle: 'release-manager', tag: 'role:release-manager', memberCount: 1 },
  { handle: 'reviewer', tag: 'role:reviewer', memberCount: 4 },
];

describe('the groups of the @ picker', () => {
  it('lists every group for a bare @, capped', () => {
    expect(matchGroups(groups, '').map((g) => g.handle)).toEqual(['on-call', 'release-manager', 'reviewer']);
    expect(matchGroups(groups, '', 2)).toHaveLength(2);
  });

  it('finds a group by the start of its handle, then by a part of it from two letters', () => {
    expect(matchGroups(groups, 're').map((g) => g.handle)).toEqual(['release-manager', 'reviewer']);
    expect(matchGroups(groups, 'RE').map((g) => g.handle)).toEqual(['release-manager', 'reviewer']);
    expect(matchGroups(groups, 'man').map((g) => g.handle)).toEqual(['release-manager']);
    expect(matchGroups(groups, 'm')).toEqual([]);
    expect(matchGroups(groups, 'zzz')).toEqual([]);
  });

  it('says how many people a mention reaches', () => {
    expect(groupCountText(1)).toBe('1 person');
    expect(groupCountText(4)).toBe('4 people');
  });
});

describe('what the picker keeps', () => {
  it('keys the answer by person and channel, so two people never share one', () => {
    expect(mentionGroupsKey('p1', 'c1')).not.toBe(mentionGroupsKey('p2', 'c1'));
    expect(mentionGroupsKey('p1', 'c1')).not.toBe(mentionGroupsKey('p1', 'c2'));
    expect(mentionGroupsKey('p1', 'c1')).toBe(mentionGroupsKey('p1', 'c1'));
  });

  it('is dropped with the rest of a person\'s data when they change or sign out', () => {
    expect(() => dropPersonData()).not.toThrow();
    expect(() => resetMentionGroups()).not.toThrow();
  });
});
