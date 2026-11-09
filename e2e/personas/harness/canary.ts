// The canary (PLAN P12-04 block C 4): a web build whose message box is hidden (`VITE_MANYTHREADS_CANARY=hide-composer`) must fail exactly the steps that use the
// message box. If the harness passes such a build, the pictures prove nothing. Pure: tools/review/canary.sh runs the journeys and calls `canaryCli.ts`.
import { resolvePersona, viewportsOf, type JourneyDeclaration } from './journey.ts';
import type { JourneyResult } from './manifest.ts';

export interface CanaryReport {
  /** Steps that should have failed and the canary run reports as failed. */
  expected: string[];
  /** Steps the run reports as failed. */
  actual: string[];
  /** Should have failed, did not. */
  missed: string[];
  /** Failed but do not use the message box. */
  unexpected: string[];
  problems: string[];
}

const key = (persona: string, journey: string, step: string, kind: string): string => `${persona}/${journey}/${step} (${kind})`;

export function compareCanary(journeys: readonly JourneyDeclaration[], results: readonly JourneyResult[]): CanaryReport {
  const expected: string[] = [];
  const actual: string[] = [];
  const problems: string[] = [];
  const personas = [...new Set(journeys.map((j) => j.persona))];
  for (const persona of personas) {
    const resolved = resolvePersona(journeys, persona);
    for (const j of journeys.filter((x) => x.persona === persona && x.pending === undefined)) {
      for (const kind of viewportsOf(j)) {
        const result = results.find((r) => r.persona === persona && r.journey === j.id && r.kind === kind);
        if (!result) {
          problems.push(`journey ${persona}/${j.id} (${kind}) has no result: the canary run did not run it`);
          continue;
        }
        for (const s of resolved.filter((r) => r.journeyId === j.id && r.pending === undefined)) {
          if (s.composer) expected.push(key(persona, j.id, s.id, kind));
          if (result.steps[s.id] === 'failed') actual.push(key(persona, j.id, s.id, kind));
        }
      }
    }
  }
  const missed = expected.filter((k) => !actual.includes(k));
  const unexpected = actual.filter((k) => !expected.includes(k));
  if (expected.length === 0) problems.push('no step uses the message box, so the canary proves nothing: flag at least one step (composer) in the example journey');
  if (missed.length > 0) problems.push(`the canary build did NOT fail these message-box steps (the harness would not notice a missing composer): ${missed.join(', ')}`);
  if (unexpected.length > 0) problems.push(`the canary build failed steps that do not use the message box: ${unexpected.join(', ')}`);
  return { expected, actual, missed, unexpected, problems };
}
