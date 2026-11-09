// What the plan asks of the journey set itself (PLAN P12-03 acceptance, Bundle E decisions E30 and E33): the declarations are well formed, each has five pictures
// or says why not and an outcome assertion, and every persona has a built (not pending) Brain journey and a built acting-bot journey. Starts no stack.
import { test, expect } from '@playwright/test';
import { PERSONAS, journeyRuleProblems, personaRuleProblems, validateJourney } from './harness/journey.ts';
import { currentSet, loadJourneys, journeyFiles } from './harness/loader.ts';

test.describe('the journey set', () => {
  test('every journey file is a well-formed declaration with its rules met', async () => {
    const loaded = await loadJourneys();
    const problems = loaded.flatMap((l) => [...validateJourney(l.journey), ...journeyRuleProblems(l.journey)]);
    expect(problems, `\n- ${problems.join('\n- ')}`).toEqual([]);
  });

  test('journey ids are unique inside a persona', async () => {
    const loaded = await loadJourneys();
    const seen = new Set<string>();
    const dup: string[] = [];
    for (const { journey, file } of loaded) {
      const key = `${journey.persona}/${journey.id}`;
      if (seen.has(key)) dup.push(`${key} (${file})`);
      seen.add(key);
    }
    expect(dup).toEqual([]);
  });

  test('every persona has a built Brain journey and a built acting-bot journey', async () => {
    // The example journey of the harness is one persona's short proof, not a set to judge.
    test.skip(currentSet() === 'example', 'the harness example is not a persona set');
    const journeys = (await loadJourneys()).map((l) => l.journey);
    // The journeys are written in Phase 12 block B; until the first file exists there is nothing to judge. Once any persona has a journey, all seven must.
    test.skip(journeys.length === 0 && journeyFiles().length === 0, 'no journey files yet (the persona journeys are written by P12-03)');
    const problems = personaRuleProblems(journeys, PERSONAS);
    expect(problems, `\n- ${problems.join('\n- ')}`).toEqual([]);
  });
});
