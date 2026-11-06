import { describe, expect, it } from 'vitest';
import { EXAMPLE_CARDS, examplesFrom, filterExamples, rankExamples } from '../src/screens/setup/model';

/* The example cards of "Add a bot": which bots a team is offered, and in what order. */

const bot = (slug: string, name: string, role: string) => ({ slug, name, role });
const TEMPLATES = [
  { id: 'customer-support', name: 'Customer support', bots: [bot('brain', 'Brain', 'Team memory.'), bot('archivist', 'Archivist', 'Files notes.'), bot('support-responder', 'Support responder', 'Drafts answers from the manuals.')] },
  { id: 'engineering', name: 'Engineering', bots: [bot('brain', 'Brain', 'Team memory.'), bot('archivist', 'Archivist', 'Files notes.'), bot('coder', 'Coder', 'Writes the change.'), bot('code-reviewer', 'Code reviewer', 'Reviews a change.')] },
  { id: 'marketing', name: 'Marketing', bots: [bot('brain', 'Brain', 'Team memory.'), bot('content-drafter', 'Content drafter', 'Drafts posts.')] },
];
const keys = (list: ReadonlyArray<{ key: string }>): string[] => list.map((e) => e.key);

describe('rankExamples', () => {
  const examples = examplesFrom(TEMPLATES);

  it('keeps every template, in order, for a team with no template', () => {
    expect(keys(rankExamples(examples, { teamTemplate: null, existingSlugs: [] }))).toEqual(['archivist', 'support-responder', 'coder', 'code-reviewer', 'content-drafter']);
  });

  it("puts the team's own template first and keeps the template order inside each group", () => {
    expect(keys(rankExamples(examples, { teamTemplate: 'engineering', existingSlugs: [] }))).toEqual(['archivist', 'coder', 'code-reviewer', 'support-responder', 'content-drafter']);
    expect(keys(rankExamples(examples, { teamTemplate: 'marketing', existingSlugs: [] }))).toEqual(['content-drafter', 'archivist', 'support-responder', 'coder', 'code-reviewer']);
  });

  it('counts a bot that two templates share for both of them', () => {
    expect(examples.find((e) => e.key === 'archivist')?.templateIds).toEqual(['customer-support', 'engineering']);
    // the shared bot is listed once, under the first template that ships it
    expect(examples.filter((e) => e.key === 'archivist')).toHaveLength(1);
  });

  it('drops the bots the team already has', () => {
    expect(keys(rankExamples(examples, { teamTemplate: 'engineering', existingSlugs: ['coder', 'archivist', 'not-an-example'] }))).toEqual(['code-reviewer', 'support-responder', 'content-drafter']);
  });

  it('does not change the list it was given', () => {
    const before = keys(examples);
    rankExamples(examples, { teamTemplate: 'marketing', existingSlugs: [] });
    expect(keys(examples)).toEqual(before);
  });

  it('answers an empty list for no examples, and for a team that has them all', () => {
    expect(rankExamples([], { teamTemplate: 'engineering', existingSlugs: [] })).toEqual([]);
    expect(rankExamples(examples, { teamTemplate: null, existingSlugs: keys(examples) })).toEqual([]);
  });

  it('shows six cards: the first six of the ranked list', () => {
    const many = examplesFrom([{ id: 'engineering', name: 'Engineering', bots: Array.from({ length: 10 }, (_, i) => bot(`b${i}`, `Bot ${i}`, 'Does a thing.')) }]);
    const ranked = rankExamples(many, { teamTemplate: 'engineering', existingSlugs: ['b0'] });
    expect(EXAMPLE_CARDS).toBe(6);
    expect(keys(ranked.slice(0, EXAMPLE_CARDS))).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  });
});

describe('filterExamples', () => {
  const examples = examplesFrom(TEMPLATES);

  it('returns everything for an empty or blank box', () => {
    expect(filterExamples(examples, '')).toHaveLength(examples.length);
    expect(filterExamples(examples, '   ')).toHaveLength(examples.length);
  });

  it('matches every typed word against the name, the one-line description and the template, ignoring case', () => {
    expect(keys(filterExamples(examples, 'REVIEW'))).toEqual(['code-reviewer']);
    expect(keys(filterExamples(examples, 'drafts marketing'))).toEqual(['content-drafter']);
    expect(keys(filterExamples(examples, 'manuals'))).toEqual(['support-responder']);
    expect(filterExamples(examples, 'zzz')).toEqual([]);
  });
});
