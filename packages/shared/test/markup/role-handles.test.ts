import { describe, expect, it } from 'vitest';
import { RESERVED_GROUP_HANDLES, matchHandle, parseMarkup, reservedTagReason, roleGroups, roleHandle, someoneAnswersTo } from '../../src/markup/index.ts';

const people = [
  { displayName: 'Nadia Khan', email: 'nadia.k@example.com' },
  { displayName: 'Rafi Ahmed', email: 'rafi@example.com' },
];

describe('roleHandle', () => {
  it('turns a role tag into the word after @', () => {
    expect(roleHandle('role:on-call')).toBe('on-call');
    expect(roleHandle('role:release-manager')).toBe('release-manager');
    expect(roleHandle('role:a1')).toBe('a1');
  });

  it('is null for anything that is not a role tag', () => {
    for (const bad of ['on-call', 'person:abc', 'role:', 'role:On-Call', 'role:1st', 'role:a b', 'role:a:b', 'ROLE:x', '']) expect(roleHandle(bad), bad).toBeNull();
  });

  it('is a word the mention parser reads as one handle', () => {
    expect(parseMarkup(`ping @${roleHandle('role:release-manager')} now`).mentions.map((m) => m.handle)).toEqual(['release-manager']);
  });
});

describe('someoneAnswersTo', () => {
  it('knows email local parts and name slugs, in any case, but not first names', () => {
    expect(someoneAnswersTo('nadia.k', people)).toBe(true);
    expect(someoneAnswersTo('nadia-khan', people)).toBe(true);
    expect(someoneAnswersTo('NADIA-KHAN', people)).toBe(true);
    expect(someoneAnswersTo('rafi', people)).toBe(true);                 // Rafi's email part is `rafi`
    expect(someoneAnswersTo('nadia', people)).toBe(false);               // only her first name: it cannot take a team's tag away
    expect(someoneAnswersTo('on-call', people)).toBe(false);
  });
});

describe('roleGroups', () => {
  const tags = [
    { tag: 'role:on-call', personIds: ['p2', 'p1', 'p2'] },
    { tag: 'role:reviewer', personIds: [] },
  ];

  it('makes every role tag a group, in handle order, with each holder once', () => {
    const groups = roleGroups({ tags: [...tags].reverse(), people, botSlugs: [] });
    expect(groups).toEqual([
      { tag: 'role:on-call', handle: 'on-call', personIds: ['p2', 'p1'], mentionable: true, closedBy: null },
      { tag: 'role:reviewer', handle: 'reviewer', personIds: [], mentionable: true, closedBy: null },
    ]);
  });

  it('a person wins by an exact handle (email part or name slug), not by a first name: the tag keeps `@nadia`', () => {
    const groups = roleGroups({
      tags: [{ tag: 'role:nadia', personIds: ['p1'] }, { tag: 'role:rafi', personIds: ['p1'] }, { tag: 'role:nadia-khan', personIds: ['p1'] }, { tag: 'role:ops', personIds: ['p1'] }],
      people,
      botSlugs: [],
    });
    expect(groups.map((g) => [g.handle, g.mentionable, g.closedBy])).toEqual([['nadia', true, null], ['nadia-khan', false, 'person'], ['ops', true, null], ['rafi', false, 'person']]);
  });

  it('a bot wins: a tag named like a bot slug is not mentionable (case ignored)', () => {
    const groups = roleGroups({ tags: [{ tag: 'role:coder', personIds: ['p1'] }, { tag: 'role:ops', personIds: ['p1'] }], people, botSlugs: ['Coder', 'tester'] });
    expect(groups.map((g) => [g.handle, g.mentionable, g.closedBy])).toEqual([['coder', false, 'bot'], ['ops', true, null]]);
  });

  it('keeps the reserved words: whole-channel words and authority words (and their plurals) are never mentionable', () => {
    for (const word of ['here', 'channel', 'everyone', 'everybody', 'all', 'admin', 'admins', 'administrators', 'owner', 'owners', 'team', 'teams', 'staff', 'security', 'moderators', 'mods']) {
      expect(RESERVED_GROUP_HANDLES, word).toContain(word);
    }
    const groups = roleGroups({ tags: RESERVED_GROUP_HANDLES.map((h) => ({ tag: `role:${h}`, personIds: ['p1'] })), people: [], botSlugs: [] });
    expect(groups).toHaveLength(RESERVED_GROUP_HANDLES.length);
    expect(groups.every((g) => !g.mentionable)).toBe(true);
  });

  it('lists a losing tag anyway, so a check by tag name still sees its holders', () => {
    const [g] = roleGroups({ tags: [{ tag: 'role:rafi', personIds: ['p9'] }], people, botSlugs: [] });
    expect(g).toEqual({ tag: 'role:rafi', handle: 'rafi', personIds: ['p9'], mentionable: false, closedBy: 'person' });
  });

  it('skips a tag that is not a role tag', () => {
    expect(roleGroups({ tags: [{ tag: 'person:abc', personIds: [] }], people, botSlugs: [] })).toEqual([]);
  });

  it('is linear on hostile input', () => {
    const long = `role:${'a-'.repeat(50_000)}`;
    const start = performance.now();
    roleHandle(long);
    roleGroups({ tags: [{ tag: long, personIds: [] }], people, botSlugs: [] });
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('reservedTagReason', () => {
  it('says in a plain sentence why a reserved word cannot be a new tag, and nothing for an ordinary tag', () => {
    expect(reservedTagReason('role:admin')).toContain('"admin" is kept for');
    expect(reservedTagReason('role:owners')).not.toBeNull();
    expect(reservedTagReason('role:on-call')).toBeNull();
    expect(reservedTagReason('role:admin-group')).toBeNull();
    expect(reservedTagReason('not-a-tag')).toBeNull();
  });
});

describe('matchHandle with exactOnly', () => {
  const subjects = [{ id: 'p1', displayName: 'Rafi Khan', email: 'rafi.k@example.com' }];
  it('finds the person by a first name unless the word is also a tag', () => {
    expect(matchHandle('rafi', subjects)).toBe('p1');
    expect(matchHandle('rafi', subjects, { exactOnly: true })).toBeNull();
    expect(matchHandle('rafi.k', subjects, { exactOnly: true })).toBe('p1');
    expect(matchHandle('rafi-khan', subjects, { exactOnly: true })).toBe('p1');
  });
});
