import { describe, expect, it } from 'vitest';
import {
  EvalAnswer,
  EvalResult,
  EvalRun,
  capabilityMeets,
  evalBotOfPath,
  judgeExpectation,
  loadBotEval,
  runEvalScenario,
  runEvalSet,
  staticAnswerer,
  summarizeEval,
  type Answerer,
  type BotEvalCase,
  type EvalBotDefinition,
} from '../src/index.ts';

// The harness (PLAN P7-08): the shapes of a run, the one judge every caller shares, and the loader with its plain-language refusals.

const def: EvalBotDefinition = { slug: 'tester', name: 'Tester', body: 'Test things.', native: ['answer.post', 'tasks.*'], alias: 'smart' };
const c = (id: string, expect: BotEvalCase['expect']): BotEvalCase => ({ id, question: 'Q?', expect, rationale: 'because' }) as BotEvalCase;
const answer = (over: Partial<EvalAnswer> = {}): EvalAnswer =>
  EvalAnswer.parse({ body: 'Hold the canary for 30 minutes [1].', citations: [{ kind: 'page', label: 'runbook' }], toolCalls: ['answer.post'], ...over });
const fake = (a: EvalAnswer, tokens = 5): Answerer => ({ mode: 'model', answer: async () => ({ answer: a, tokens }) });

describe('the shapes', () => {
  it('a result and a run parse, and a score outside 0..1 is refused', () => {
    const result = { caseId: 'a', passed: true, judged: true, score: 1, reasons: [], skipped: [], answerExcerpt: 'x', durationMs: 3, costTokens: 0 };
    expect(EvalResult.parse(result)).toEqual(result);
    expect(() => EvalResult.parse({ ...result, score: 1.5 })).toThrow();
    const run = {
      id: '01a18abb-65a1-7f28-a909-13d973edc55e', botSlug: 'tester', set: 'qa', commitSha: 'a'.repeat(40), trigger: 'on_commit', mode: 'static', status: 'finished',
      startedAt: '2026-10-30T00:00:00.000Z', finishedAt: '2026-10-30T00:00:01.000Z', total: 1, judged: 1, passed: 1, score: 1, minScore: 0.9, ok: true, costTokens: 0, error: null, results: [result],
    };
    expect(EvalRun.parse(run).ok).toBe(true);
    expect(() => EvalRun.parse({ ...run, trigger: 'sometimes' })).toThrow();
  });
});

describe('judging one answer', () => {
  it('every assertion that holds passes; each that does not gives one plain sentence', async () => {
    const good = await runEvalScenario(fake(answer()), def, c('g', { minCitations: 1, citesKinds: ['page'], mentions: ['30 MINUTES'], notMentions: ['secret'], toolCalls: { required: ['answer.post'], forbidden: ['messages.post'] } }));
    expect(good).toMatchObject({ passed: true, judged: true, score: 1, reasons: [], costTokens: 5 });
    const bad = await runEvalScenario(fake(answer()), def, c('b', { minCitations: 2, mentions: ['rollback'], notMentions: ['canary'], toolCalls: { forbidden: ['answer.*'] } }));
    expect(bad.passed).toBe(false);
    expect(bad.score).toBe(0);
    expect(bad.reasons).toHaveLength(4);
    expect(bad.reasons.join(' ')).toContain('at least 2');
    expect(bad.reasons.join(' ')).toContain('"rollback"');
  });

  it('a masked citation does not count, outside-scope and hand-off assertions read the answer', () => {
    const a = answer({ citations: [{ kind: 'page', label: 'x', masked: true }], outsideScope: { count: 1, items: [{ kind: 'drive' }] }, chips: [{ kind: 'handoff', label: 'reviewer' }] });
    expect(judgeExpectation({ minCitations: 1 }, a).failures).toHaveLength(1);
    expect(judgeExpectation({ statesOutsideScope: true, outsideScopeKinds: ['drive'], offersHandoff: true }, a)).toMatchObject({ checked: 3, failures: [] });
    expect(judgeExpectation({ outsideScopeKinds: ['notion'] }, a).failures[0]).toContain('"notion"');
  });

  it('statesUnknown is true only for an answer that points at nothing', () => {
    const unknown = EvalAnswer.parse({ body: 'I do not know.' });
    expect(judgeExpectation({ statesUnknown: true }, unknown).failures).toEqual([]);
    expect(judgeExpectation({ statesUnknown: true }, answer()).failures).toHaveLength(1);
  });

  it('the clock is the caller\'s', async () => {
    let t = 1000;
    const r = await runEvalScenario(fake(answer()), def, c('t', { minCitations: 1 }), () => (t += 250));
    expect(r.durationMs).toBe(250);
  });

  it('capability names meet when one contains the other', () => {
    expect(capabilityMeets('answer.*', 'answer.post')).toBe(true);
    expect(capabilityMeets('answer.post', 'answer.*')).toBe(true);
    expect(capabilityMeets('answer.post', 'answer.edit')).toBe(false);
    expect(capabilityMeets('tasks.*', 'answer.post')).toBe(false);
  });
});

describe('the free mode', () => {
  it('judges only the calls a case requires; everything else is "not checked", never passed', async () => {
    const needsPost = await runEvalScenario(staticAnswerer, def, c('p', { toolCalls: { required: ['answer.post'] }, mentions: ['x'] }));
    expect(needsPost).toMatchObject({ passed: true, judged: true, score: 1, skipped: ['mentions'], costTokens: 0 });
    const needsMissing = await runEvalScenario(staticAnswerer, def, c('m', { toolCalls: { required: ['messages.post'] } }));
    expect(needsMissing).toMatchObject({ passed: false, judged: true, score: 0 });
    expect(needsMissing.reasons[0]).toContain('messages.post');
    const wordsOnly = await runEvalScenario(staticAnswerer, def, c('w', { mentions: ['x'], toolCalls: { forbidden: ['answer.post'] } }));
    expect(wordsOnly).toMatchObject({ passed: false, judged: false, score: 0 });
    expect(wordsOnly.reasons[0]).toContain('Not checked');
    expect(wordsOnly.skipped).toEqual(['mentions', 'toolCalls.forbidden']);
  });
});

describe('a whole set', () => {
  it('counts what was judged, leaves the unjudged out, and compares to the minimum without a float surprise', async () => {
    const cases = Array.from({ length: 10 }, (_, i) => c(`c${i}`, { toolCalls: { required: [i === 0 ? 'nothing.here' : 'answer.post'] } }));
    const { results, summary } = await runEvalSet(staticAnswerer, def, cases, 0.9);
    expect(results).toHaveLength(10);
    expect(summary).toMatchObject({ total: 10, judged: 10, passed: 9, score: 0.9, ok: true });
    expect((await runEvalSet(staticAnswerer, def, cases, 0.95)).summary.ok).toBe(false);
    const unjudged = await runEvalSet(staticAnswerer, def, [c('w', { mentions: ['x'] })], 1);
    expect(unjudged.summary).toMatchObject({ total: 1, judged: 0, score: null, ok: null });
    expect(summarizeEval([], 0.5).ok).toBeNull();
  });

  it('an answerer that throws stops the run with its own words', async () => {
    const broken: Answerer = { mode: 'model', answer: async () => { throw new Error('no model'); } };
    await expect(runEvalSet(broken, def, [c('a', { minCitations: 1 })], 1)).rejects.toThrow('no model');
  });
});

describe('the loader', () => {
  const botMd = (evals: string): string => `---\nschema: 1\nname: Tester\nrole: Tests\nkind: agent\nruntime: hermes\ntriggers:\n  - type: mention\ncapabilities:\n  native: [answer.post]\nmodel:\n  aliases: [smart]\n${evals}---\n\n# Tester\n\nBe careful.\n`;
  const set = (name: string): string => `schema: 1\nset: ${name}\ncases:\n  - id: a\n    question: Q?\n    expect:\n      toolCalls:\n        required: [answer.post]\n    rationale: because\n`;
  const files = (m: Record<string, string>) => async (path: string): Promise<string | null> => m[path] ?? null;

  it('loads the definition and the set it names', async () => {
    const r = await loadBotEval('tester', files({ 'bots/tester/BOT.md': botMd('evals:\n  set: qa\n  minScore: 0.8\n'), 'bots/tester/evals/qa.yaml': set('qa') }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.loaded).toMatchObject({ minScore: 0.8, setPath: 'bots/tester/evals/qa.yaml', definition: { slug: 'tester', name: 'Tester', native: ['answer.post'], alias: 'smart' } });
      expect(r.loaded.definition.body).toContain('Be careful.');
    }
  });

  it('says in plain words why a bot cannot run', async () => {
    const md = botMd('evals:\n  set: qa\n  minScore: 0.8\n');
    const none = await loadBotEval('tester', files({}));
    expect(none).toMatchObject({ ok: false, kind: 'no_definition' });
    const broken = await loadBotEval('tester', files({ 'bots/tester/BOT.md': 'no frontmatter' }));
    expect(broken).toMatchObject({ ok: false, kind: 'bad_definition' });
    const noSet = await loadBotEval('tester', files({ 'bots/tester/BOT.md': botMd('') }));
    expect(noSet).toMatchObject({ ok: false, kind: 'no_evals' });
    const noFile = await loadBotEval('tester', files({ 'bots/tester/BOT.md': md }));
    expect(noFile).toMatchObject({ ok: false, kind: 'no_set_file', set: 'qa', minScore: 0.8 });
    if (!noFile.ok) expect(noFile.message).toContain('bots/tester/evals/qa.yaml');
    const badSet = await loadBotEval('tester', files({ 'bots/tester/BOT.md': md, 'bots/tester/evals/qa.yaml': 'schema: 1\nset: qa\ncases: []\n' }));
    expect(badSet).toMatchObject({ ok: false, kind: 'bad_set' });
    const mismatch = await loadBotEval('tester', files({ 'bots/tester/BOT.md': md, 'bots/tester/evals/qa.yaml': set('other') }));
    expect(mismatch).toMatchObject({ ok: false, kind: 'bad_set' });
    if (!mismatch.ok) expect(mismatch.message).toContain('must match');
  });

  it('knows which repo paths can change a bot\'s evals', () => {
    expect(evalBotOfPath('bots/tester/BOT.md')).toBe('tester');
    expect(evalBotOfPath('bots/tester/evals/qa.yaml')).toBe('tester');
    expect(evalBotOfPath('bots/tester/evals/qa.yml')).toBe('tester');
    expect(evalBotOfPath('bots/tester/skills/x.md')).toBeNull();
    expect(evalBotOfPath('bots/a/b/BOT.md')).toBeNull();
    expect(evalBotOfPath('TEAM.md')).toBeNull();
  });
});
