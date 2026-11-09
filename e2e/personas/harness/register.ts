// Registers one Playwright test per journey for a viewport (PLAN P12-01). `desktop.spec.ts` and `mobile.spec.ts` call this; the projects `personas-desktop` and
// `personas-mobile-web` each run one of them. Shard by persona with `--grep @omar`; one journey with `--grep @O2`.
//
// One stack per persona and per way of starting (`start` + `stackEnv`): the journeys of a persona run in id order on the same stack, so a message one posted is
// there for the next. A stack is started in `beforeAll` (the repository's pattern, fixtures/stack.ts) and stopped, with its database, in `afterAll`.
import { test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { PERSONAS, viewportsOf, type JourneyDeclaration, type Persona } from './journey.ts';
import { loadJourneys } from './loader.ts';
import { clearJourney, journeysRoot, recordResult } from './manifest.ts';
import { runJourney } from './run.ts';

/** Time one journey may take on a loaded machine (stack start is separate). */
const JOURNEY_BUDGET_MS = 5 * 60_000;

/** The environment of the stack a journey needs. */
export function stackEnvFor(journey: Pick<JourneyDeclaration, 'start' | 'stackEnv'>): Record<string, string> {
  const start = journey.start ?? 'week-2';
  const base: Record<string, string> = start === 'empty' ? { MANYTHREADS_STACK_SEED: 'none' } : { MANYTHREADS_STACK_SNAPSHOT: start };
  return { ...base, ...(journey.stackEnv ?? {}) };
}

const stackKey = (j: JourneyDeclaration): string => JSON.stringify(Object.entries(stackEnvFor(j)).sort());

/** `MANYTHREADS_PERSONAS_CONTINUE=1`: a failed step does not stop the journey and a failed journey does not fail the test (the canary run reads results.*.json instead). */
export const continueOnFailure = (): boolean => process.env['MANYTHREADS_PERSONAS_CONTINUE'] === '1';

export async function registerPersonaTests(kind: 'desktop' | 'mobile'): Promise<void> {
  const loaded = await loadJourneys();
  const all = loaded.map((l) => l.journey);
  const root = journeysRoot();
  test.describe.configure({ mode: 'default' });
  for (const persona of PERSONAS as readonly Persona[]) {
    const mine = all.filter((j) => j.persona === persona && viewportsOf(j).includes(kind));
    if (mine.length === 0) continue;
    const real = mine.filter((j) => j.pending === undefined).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
    for (const j of mine.filter((x) => x.pending !== undefined)) {
      test(`${persona} ${j.id} (${kind}) is pending ${j.pending} @${persona} @${j.id}`, async () => {
        clearJourney(root, persona, j.id, kind);
        recordResult(root, { persona, journey: j.id, kind, status: 'pending', durationMs: 0, steps: Object.fromEntries(j.steps.map((s) => [s.id, 'pending' as const])) });
        test.skip(true, `pending ${j.pending}`);
      });
    }
    const groups = new Map<string, JourneyDeclaration[]>();
    for (const j of real) groups.set(stackKey(j), [...(groups.get(stackKey(j)) ?? []), j]);
    for (const [key, journeys] of groups) {
      test.describe(`${persona} on ${journeys[0]!.start ?? 'week-2'} ${groups.size > 1 ? key.slice(0, 40) : ''}`.trim(), () => {
        let stack: Stack | undefined;
        test.beforeAll(async () => {
          stack = await startStack(stackEnvFor(journeys[0]!));
        });
        test.afterAll(async () => {
          await stack?.stop();
          stack = undefined;
        });
        for (const j of journeys) {
          test(`${persona} ${j.id} ${j.goal} (${kind}) @${persona} @${j.id}`, async ({ browser, playwright }) => {
            test.setTimeout(JOURNEY_BUDGET_MS);
            if (!stack) throw new Error('the stack did not start');
            const result = await runJourney({ all, journey: j, kind, stack, browser, playwright, root, continueOnFailure: continueOnFailure() });
            if (result.status === 'failed' && !continueOnFailure()) throw new Error(result.error ?? 'journey failed');
          });
        }
      });
    }
  }
}
