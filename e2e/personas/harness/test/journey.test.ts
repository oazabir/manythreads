import { describe, expect, it } from 'vitest';
import {
  compareJourneyIds,
  defineJourney,
  journeyRuleProblems,
  personaRuleProblems,
  resolvePersona,
  stepFileName,
  stepRelativePath,
  usesComposer,
  validateJourney,
} from '../journey.ts';
import { journey, step } from './fixtures.ts';

describe('defineJourney', () => {
  it('refuses a declaration with problems and names them', () => {
    expect(() => defineJourney({ id: 'x', persona: 'omar', goal: '', markers: [], steps: [] })).toThrow(/must be letters then a number[\s\S]*goal is empty[\s\S]*no steps/);
  });

  it('wants the id to start with the persona letter', () => {
    expect(validateJourney({ id: 'N2', persona: 'omar', goal: 'g', markers: [], steps: [step('a')] })).toEqual(['id "N2" should start with the letter of omar (O)']);
  });

  it('refuses duplicate step ids, bad words, a missing run and a bad denial status', () => {
    const problems = validateJourney({
      id: 'O1',
      persona: 'omar',
      goal: 'g',
      markers: [],
      steps: [step('a'), step('a'), step('Bad_Id'), { id: 'norun', expect: 'x' }, step('d', { expectDenied: 200 })],
    });
    expect(problems.join('\n')).toMatch(/"a" is used twice/);
    expect(problems.join('\n')).toMatch(/"Bad_Id" must be lower-case/);
    expect(problems.join('\n')).toMatch(/"norun" has no run\(\)/);
    expect(problems.join('\n')).toMatch(/expectDenied must be an HTTP error status/);
  });

  it('a pending step needs no run but must name a plan task', () => {
    expect(validateJourney({ id: 'O1', persona: 'omar', goal: 'g', markers: [], steps: [{ id: 'p', expect: 'x', pending: 'P8-19' }] })).toEqual([]);
    expect(validateJourney({ id: 'O1', persona: 'omar', goal: 'g', markers: [], steps: [{ id: 'p', expect: 'x', pending: 'later' }] })[0]).toMatch(/pending must name a PLAN task id/);
  });
});

describe('numbering', () => {
  it('numbers steps across the persona in journey-id order, 2 before 10, and gives pending steps no number', () => {
    const j10 = journey('omar', 'O10', [step('x'), step('y')]);
    const j2 = journey('omar', 'O2', [step('a'), step('later', { pending: 'P8-19' }), step('b')]);
    const jp = journey('omar', 'O3', [step('q')], { pending: 'P15-01' });
    const other = journey('nadia', 'N1', [step('n')]);
    const steps = resolvePersona([j10, other, jp, j2], 'omar');
    expect(steps.map((s) => `${s.journeyId}/${s.id}:${s.number}`)).toEqual(['O2/a:1', 'O2/later:0', 'O2/b:2', 'O3/q:0', 'O10/x:3', 'O10/y:4']);
  });

  it('a step built later does not renumber the ones before it', () => {
    const before = resolvePersona([journey('omar', 'O1', [step('a'), step('b', { pending: 'P8-19' })]), journey('omar', 'O2', [step('c')])], 'omar');
    const after = resolvePersona([journey('omar', 'O1', [step('a'), step('b')]), journey('omar', 'O2', [step('c')])], 'omar');
    expect(before.find((s) => s.id === 'a')!.number).toBe(after.find((s) => s.id === 'a')!.number);
  });

  it('names pictures NN-<journey>-<step>.png with a mobile folder for the phone viewport', () => {
    const s = { persona: 'rafi' as const, number: 7, journeyId: 'R3', id: 'asks-brain' };
    expect(stepFileName(s)).toBe('07-R3-asks-brain.png');
    expect(stepRelativePath(s, 'desktop')).toBe('rafi/07-R3-asks-brain.png');
    expect(stepRelativePath(s, 'mobile')).toBe('rafi/mobile/07-R3-asks-brain.png');
  });

  it('orders ids by number, not text', () => {
    expect(['N10', 'N2', 'N1'].sort(compareJourneyIds)).toEqual(['N1', 'N2', 'N10']);
  });
});

describe('composer flag', () => {
  it('is derived from the landmark and the next control, and can be set by hand', () => {
    expect(usesComposer(step('a', { expect: 'composer' }))).toBe(true);
    expect(usesComposer(step('a', { next: { testid: 'send' } }))).toBe(true);
    expect(usesComposer(step('a', { expect: 'bots-roster' }))).toBe(false);
    expect(usesComposer(step('a', { expect: 'message', composer: true }))).toBe(true);
    expect(usesComposer(step('a', { expect: 'composer', composer: false }))).toBe(false);
  });
});

describe('the plan rules', () => {
  it('asks for five pictures or a reason, and an outcome', () => {
    const short = journey('omar', 'O1', [step('a'), step('b')]);
    expect(journeyRuleProblems(short)[0]).toMatch(/2 picture\(s\); the plan asks for at least 5/);
    expect(journeyRuleProblems(journey('omar', 'O1', [step('a')], { fewerShots: 'a negative' }))).toEqual([]);
    const five = ['a', 'b', 'c', 'd', 'e'].map((id) => step(id));
    expect(journeyRuleProblems({ ...journey('omar', 'O1', five), outcome: undefined })[0]).toMatch(/no outcome\(\)/);
    expect(journeyRuleProblems(journey('omar', 'O1', [step('a')], { pending: 'P8-19' }))).toEqual([]);
  });

  it('counts pending steps out of the five', () => {
    const steps = ['a', 'b', 'c', 'd'].map((id) => step(id)).concat(step('e', { pending: 'P8-19' }));
    expect(journeyRuleProblems(journey('omar', 'O1', steps))[0]).toMatch(/4 picture/);
  });

  it('wants a built B journey and a built A journey for every persona', () => {
    const b = journey('omar', 'O1', [step('a')], { markers: ['B'] });
    const aPending = journey('omar', 'O2', [step('a')], { markers: ['A'], pending: 'P8-19' });
    const problems = personaRuleProblems([b, aPending], ['omar']);
    expect(problems).toEqual(['omar has no journey marked A that is built (O2 is pending)']);
    const a = journey('omar', 'O3', [step('a')], { markers: ['A'] });
    expect(personaRuleProblems([b, aPending, a], ['omar'])).toEqual([]);
  });

  it('a persona with no journey at all fails both', () => {
    expect(personaRuleProblems([], ['lena'])).toHaveLength(2);
  });

  it('catches a journey id declared twice', () => {
    const a = journey('omar', 'O1', [step('a')], { markers: ['A', 'B'] });
    expect(personaRuleProblems([a, a], ['omar'])).toEqual(['journey id omar/O1 is declared twice']);
  });
});
