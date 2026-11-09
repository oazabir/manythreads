// `tsx canary-cli.ts compare <journeys folder>`: reads the results of a canary run and exits 0 only when exactly the message-box steps failed.
// `tsx canary-cli.ts complete <journeys folder>`: runs the completeness check on a folder and exits 0 when it is complete (1 and the problems when not).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkCompleteness } from './completeness.ts';
import { compareCanary } from './canary.ts';
import { loadJourneys } from './loader.ts';
import { listPictures, readManifests } from './manifest.ts';

const [command, root] = process.argv.slice(2);
if ((command !== 'compare' && command !== 'complete') || !root) {
  console.error('usage: canary-cli.ts compare|complete <journeys folder>');
  process.exit(2);
}
const journeys = (await loadJourneys()).map((l) => l.journey);
const { entries, results } = readManifests(root);
if (command === 'compare') {
  const report = compareCanary(journeys, results);
  console.log(`canary: ${report.expected.length} message-box step(s) expected to fail, ${report.actual.length} failed`);
  for (const p of report.problems) console.error(`canary: ${p}`);
  process.exit(report.problems.length === 0 ? 0 : 1);
}
const report = checkCompleteness({ journeys, entries, results, files: listPictures(root), read: (f) => readFileSync(join(root, f)) });
console.log(`completeness: ${report.declared} declared, ${report.checked} checked, ${report.problems.length} problem(s)`);
for (const p of report.problems) console.error(`completeness: ${p}`);
process.exit(report.problems.length === 0 ? 0 : 1);
