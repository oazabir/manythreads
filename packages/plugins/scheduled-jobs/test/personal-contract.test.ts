import { describe, expect, it } from 'vitest';
import { buildContractText, contractPathOf, defaultOutputPathOf, parseContractText, slugFor, type PersonalContract } from '../src/personal-contract.ts';
import { guessSources, nameFrom } from '../src/draft.ts';

const contract: PersonalContract = {
  name: 'Morning brief',
  words: 'Every weekday at 8 tell me what came in',
  schedule: '0 4 * * 1-5',
  timeZone: 'Asia/Dubai',
  sources: ['mail', 'calendar'],
  prompt: 'Summarise my unread mail and my day.',
  output: { path: 'Routines/morning-brief/output.md', mode: 'replace' },
};

describe('the routine file', () => {
  it('is written and read back the same', () => {
    expect(parseContractText(buildContractText(contract), contractPathOf('morning-brief'))).toEqual(contract);
  });

  it('names a problem in plain words', () => {
    expect(() => parseContractText('name: [unclosed', 'Routines/x/routine.yaml')).toThrow(/not valid YAML/);
    expect(() => parseContractText('name: Only a name\n', 'Routines/x/routine.yaml')).toThrow(/Routines\/x\/routine.yaml has a problem/);
  });

  it('keeps the file and the first output in the routine folder', () => {
    expect(contractPathOf('a')).toBe('Routines/a/routine.yaml');
    expect(defaultOutputPathOf('a')).toBe('Routines/a/output.md');
  });
});

describe('slugFor', () => {
  it('makes a folder name and keeps it unique', () => {
    expect(slugFor('Morning brief!', new Set())).toBe('morning-brief');
    expect(slugFor('Morning brief', new Set(['morning-brief']))).toBe('morning-brief-2');
    expect(slugFor('   ', new Set())).toBe('routine');
    expect(slugFor('Résumé of the week', new Set()).startsWith('r')).toBe(true);
    expect(slugFor('x'.repeat(100), new Set()).length).toBeLessThanOrEqual(40);
  });
});

describe('the plain rules behind a draft', () => {
  it('guesses the places to look from the words', () => {
    expect(guessSources('every morning summarise my unread email')).toContain('mail');
    expect(guessSources('before each meeting tell me about the attendees')).toContain('calendar');
    expect(guessSources('on Friday list what I did')).toEqual([]);
  });

  it('makes a short name', () => {
    expect(nameFrom('Every weekday at 8am summarise my unread mail').length).toBeLessThanOrEqual(80);
    expect(nameFrom('x').length).toBeGreaterThan(0);
  });
});
