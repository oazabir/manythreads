import { loadBotEval, runEvalSet, staticAnswerer } from '@manythreads/shared';
import { repoSteps, SEED_V7_EVAL_SET, SEED_V7_LESSONS, SEED_V7_MIN_SCORE } from '@manythreads/test-utils';
import { describe, expect, it } from 'vitest';
import { earlierSameLessons, lessonLines } from '../src/learning.ts';

// PLAN P7-10: seed v7 gives the Marketing team's Content drafter a brief, a scenario set that fails and a lesson told twice. These tests read the seed
// steps as data (no database): the Workshop's own readers must see what the seed claims it holds.

const marketing = repoSteps('marketing');
const files = new Map<string, string>();
for (const step of marketing) for (const f of step.files) files.set(f.path, f.content);
const read = (path: string): Promise<string | null> => Promise.resolve(files.get(path) ?? null);

describe('seed v7', () => {
  it('adds new steps only for Marketing, each with a message of its own, so the earlier steps and an earlier seed stay as they were', () => {
    const messages = marketing.map((s) => s.message);
    expect(new Set(messages).size).toBe(messages.length);
    expect(marketing).toHaveLength(repoSteps('engineering').length + 3);
    expect(repoSteps('customer-support')).toHaveLength(repoSteps('engineering').length);
    expect(files.has('bots/content-drafter/BRIEF.md')).toBe(true);
    expect(files.get('bots/content-drafter/BRIEF.md')).toMatch(/never publishes by itself/);
    expect(repoSteps('engineering').flatMap((s) => s.files.map((f) => f.path)).some((p) => p.endsWith('BRIEF.md'))).toBe(false);
  });

  it('has a scenario set that loads and fails: the free score is under the minimum the bot asks for', async () => {
    const loaded = await loadBotEval('content-drafter', read);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.loaded.set.set).toBe(SEED_V7_EVAL_SET);
    expect(loaded.loaded.minScore).toBe(SEED_V7_MIN_SCORE);
    const { results, summary } = await runEvalSet(staticAnswerer, loaded.loaded.definition, loaded.loaded.set.cases, loaded.loaded.minScore);
    expect(results.map((r) => [r.caseId, r.judged, r.passed])).toEqual([
      ['posts-the-draft-as-a-reply', true, true],
      ['saves-the-approved-brief', true, false],
      ['leads-with-the-change', false, false],
    ]);
    expect(summary).toMatchObject({ total: 3, judged: 2, passed: 1, score: 0.5, ok: false });
  });

  it('has a lesson told twice: the Workshop reads the second line as the first one again', () => {
    const lines = lessonLines(files.get('bots/content-drafter/lessons.md') ?? '');
    expect(lines).toHaveLength(3);
    const [first, second] = SEED_V7_LESSONS.map((l) => l.replace(/^- \d{4}-\d{2}-\d{2}: /, ''));
    expect(earlierSameLessons(`- ${first}`, second as string)).toHaveLength(1);
    // the middle line is a different lesson
    expect(earlierSameLessons(`- ${first}`, lines[1]?.text ?? '')).toHaveLength(0);
  });
});
