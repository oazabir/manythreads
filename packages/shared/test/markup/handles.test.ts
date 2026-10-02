import { describe, expect, it } from 'vitest';
import { handlePrefix, matchHandle, parseMarkup, personHandles } from '../../src/markup/index.ts';

const people = [
  { id: 'p-nadia', displayName: 'Nadia Khan', email: 'nadia.k@kahf.example' },
  { id: 'p-nadia2', displayName: 'Nadia Ortiz', email: 'nortiz@kahf.example' },
  { id: 'p-rafi', displayName: 'Rafi', email: 'rafi@kahf.example' },
  { id: 'p-omar', displayName: 'Omar Al-Sayed', email: 'omar@kahf.example' },
];

describe('personHandles', () => {
  it('gives the email local part, the name slug and the first word, lower-case', () => {
    expect(personHandles(people[0]!)).toEqual({ exact: ['nadia.k', 'nadia-khan'], first: 'nadia' });
    expect(personHandles(people[2]!)).toEqual({ exact: ['rafi'], first: 'rafi' });
    expect(personHandles(people[3]!)).toEqual({ exact: ['omar', 'omar-al-sayed'], first: 'omar' });
  });

  it('keeps non-latin letters and drops punctuation', () => {
    expect(personHandles({ displayName: 'عمر  الخطيب', email: 'omar@x.example' })).toEqual({ exact: ['omar', 'عمر-الخطيب'], first: 'عمر' });
    expect(personHandles({ displayName: '  Dr. Jo--Ann  ', email: 'jo@x.example' }).exact).toEqual(['jo', 'dr-jo-ann']);
  });
});

describe('matchHandle', () => {
  it('finds a person by an exact handle, case-insensitively', () => {
    expect(matchHandle('NADIA.K', people)).toBe('p-nadia');
    expect(matchHandle('nadia-khan', people)).toBe('p-nadia');
    expect(matchHandle('Rafi', people)).toBe('p-rafi');
    expect(matchHandle('omar-al-sayed', people)).toBe('p-omar');
  });

  it('accepts a first name only when one person has it: two Nadias are ambiguous, nobody is guessed', () => {
    expect(matchHandle('nadia', people)).toBeNull();
    expect(matchHandle('nadia', people.filter((p) => p.id !== 'p-nadia2'))).toBe('p-nadia');
    expect(matchHandle('omar', people)).toBe('p-omar');       // an exact email local part beats ambiguity of the first word
  });

  it('an exact handle shared by two people is ambiguous too, and an unknown handle matches nobody', () => {
    const twins = [{ id: 'a', displayName: 'Sam A', email: 'sam@a.example' }, { id: 'b', displayName: 'Sam B', email: 'sam@b.example' }];
    expect(matchHandle('sam', twins)).toBeNull();
    expect(matchHandle('sam-a', twins)).toBe('a');
    expect(matchHandle('zed', people)).toBeNull();
  });

  it('prefix narrows by the first word of the handle', () => {
    expect(handlePrefix('Nadia.K')).toBe('nadia');
    expect(handlePrefix('nadia-khan')).toBe('nadia');
    expect(handlePrefix('omar_x')).toBe('omar');
  });

  it('works on what parseMarkup finds: code, URLs and e-mail addresses name nobody', () => {
    const body = 'hi @rafi, mail rafi@x.example `@omar` https://x.example/@nadia.k\n```\n@nadia-khan\n```';
    const handles = parseMarkup(body).mentions.map((m) => m.handle);
    expect(handles).toEqual(['rafi']);
    expect(matchHandle(handles[0]!, people)).toBe('p-rafi');
  });
});
