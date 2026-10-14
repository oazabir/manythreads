import { describe, expect, it } from 'vitest';
import {
  BOT_EVAL_SET_MAX_CASES,
  BOT_EVAL_SET_MAX_CHARS,
  BotEvalCase,
  BotEvalExpect,
  BotEvalSet,
  botEvalSetPath,
  parseBotEvalSet,
} from '../src/index.ts';

// A bot's scenario set (PLAN P5-19): the file `bots/<slug>/evals/<set>.yaml` that BOT.md's `evals.set` names. The schema is strict, every
// assertion is something a program can check, and a case that asserts nothing could never fail, so it is refused.

const okCase = {
  id: 'cites-what-it-reached',
  question: 'What do we do between the canary reaching 10% and promoting?',
  given: {
    where: 'conversation',
    sources: [{ id: 'runbook', kind: 'page', scope: 'team', visibleToAsker: true, text: 'Hold the canary for 30 minutes.' }],
  },
  expect: { minCitations: 1, citesKinds: ['page'], mentions: ['30 minutes'], toolCalls: { required: ['answer.post'] } },
  rationale: 'An answer needs a citation.',
};

const yaml = `schema: 1
set: brain
cases:
  - id: one
    question: What is our policy on leave?
    expect:
      statesUnknown: true
      maxCitations: 0
    rationale: Say you do not know.
`;

describe('BotEvalSet', () => {
  it('reads a set, and the schema key is implied', () => {
    const r = parseBotEvalSet(yaml.replace('schema: 1\n', ''));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.set.schema).toBe(1);
      expect(r.set.cases[0]?.expect).toEqual({ statesUnknown: true, maxCitations: 0 });
    }
  });

  it('is strict at every level', () => {
    expect(BotEvalCase.safeParse(okCase).success).toBe(true);
    expect(BotEvalCase.safeParse({ ...okCase, extra: 1 }).success).toBe(false);
    expect(BotEvalCase.safeParse({ ...okCase, expect: { ...okCase.expect, extra: 1 } }).success).toBe(false);
    expect(BotEvalCase.safeParse({ ...okCase, given: { where: 'conversation', extra: 1 } }).success).toBe(false);
    expect(BotEvalCase.safeParse({ ...okCase, given: { sources: [{ ...okCase.given.sources[0], extra: 1 }] } }).success).toBe(false);
    expect(BotEvalCase.safeParse({ ...okCase, rationale: '' }).success).toBe(false);
    expect(BotEvalCase.safeParse({ ...okCase, given: { where: 'dm' } }).success).toBe(false);
  });

  it('refuses a case that asserts nothing, an empty list and a minimum above the maximum', () => {
    expect(BotEvalExpect.safeParse({}).success).toBe(false);
    expect(BotEvalExpect.safeParse({ mentions: [] }).success).toBe(false);
    expect(BotEvalExpect.safeParse({ toolCalls: {} }).success).toBe(false);
    expect(BotEvalExpect.safeParse({ minCitations: 3, maxCitations: 1 }).success).toBe(false);
    expect(BotEvalExpect.safeParse({ minCitations: 1, maxCitations: 1 }).success).toBe(true);
    // `false` is an assertion: "carries no outside-scope list"
    expect(BotEvalExpect.safeParse({ statesOutsideScope: false }).success).toBe(true);
  });

  it('names capabilities like BOT.md does and kinds as lowercase words', () => {
    expect(BotEvalExpect.safeParse({ toolCalls: { forbidden: ['gmail.search', 'files.*'] } }).success).toBe(true);
    expect(BotEvalExpect.safeParse({ toolCalls: { forbidden: ['Gmail'] } }).success).toBe(false);
    expect(BotEvalExpect.safeParse({ outsideScopeKinds: ['Mail'] }).success).toBe(false);
  });

  it('refuses duplicate case ids, no cases, and too many', () => {
    expect(BotEvalSet.safeParse({ set: 'brain', cases: [okCase, okCase] }).success).toBe(false);
    expect(BotEvalSet.safeParse({ set: 'brain', cases: [] }).success).toBe(false);
    const many = Array.from({ length: BOT_EVAL_SET_MAX_CASES + 1 }, (_, i) => ({ ...okCase, id: `c-${i}` }));
    expect(BotEvalSet.safeParse({ set: 'brain', cases: many }).success).toBe(false);
    expect(BotEvalSet.safeParse({ set: 'Brain', cases: [okCase] }).success).toBe(false);
  });

  it('says what is wrong in one line, with the path', () => {
    const r = parseBotEvalSet(yaml.replace('statesUnknown: true', 'statesUnknwon: true'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/cases\.0\.expect/);
    const bad = parseBotEvalSet('cases: [');
    expect(bad.ok).toBe(false);
    expect(parseBotEvalSet('- a\n- b\n').ok).toBe(false);
  });

  it('is read in bounded time and size: a file past the cap is refused unread, an alias bomb is refused', () => {
    const big = parseBotEvalSet(`${yaml}# ${'x'.repeat(BOT_EVAL_SET_MAX_CHARS)}\n`);
    expect(big.ok).toBe(false);
    const aliases = ['a: &a [x, x]', ...Array.from({ length: 40 }, (_, i) => `k${i}: *a`)].join('\n');
    const started = performance.now();
    expect(parseBotEvalSet(aliases).ok).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('puts a set where the loader and the harness look for it', () => {
    expect(botEvalSetPath('brain', 'brain')).toBe('bots/brain/evals/brain.yaml');
  });
});
