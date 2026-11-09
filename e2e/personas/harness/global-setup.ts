// Runs once per `playwright test` command that includes a persona viewport project (e2e/playwright.config.ts, personas-only runs). On a full run it removes the
// persona pictures an earlier run left (fullrun.ts), so a renumbered step cannot leave a stale picture for the completeness spec to trip over.
import { loadJourneys } from './loader.ts';
import { clearPersonaPictures, fullRunOf } from './fullrun.ts';
import { viewportsOf } from './journey.ts';
import { journeysRoot } from './manifest.ts';

export default async function globalSetup(): Promise<void> {
  if (process.env['MANYTHREADS_PERSONAS_KEEP_PICTURES'] === '1') return;
  const { kinds } = fullRunOf(process.argv);
  if (kinds.length === 0) return;
  const root = journeysRoot();
  const journeys = (await loadJourneys()).map((l) => l.journey).filter((j) => j.pending === undefined);
  for (const kind of kinds) {
    const personas = [...new Set(journeys.filter((j) => viewportsOf(j).includes(kind)).map((j) => j.persona))];
    for (const persona of personas) {
      const removed = clearPersonaPictures(root, persona, kind);
      if (removed.length > 0) console.log(`personas: full ${kind} run: removed ${removed.length} earlier picture(s) of ${persona}`);
    }
  }
}
