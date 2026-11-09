// The completeness check (PLAN P12-04 block C 1): after a run, every declared, non-pending step has a valid picture and a manifest entry, every journey passed
// on each of its viewports, and nothing is on disk or in a manifest that no declaration accounts for. Run it after the persona projects; it starts no stack.
// `MANYTHREADS_PERSONAS_ONLY=omar,rafi` checks only those shards. Also writes run-log.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { checkCompleteness } from './harness/completeness.ts';
import { loadJourneys, personasFromEnv } from './harness/loader.ts';
import { journeysRoot, listPictures, readManifests } from './harness/manifest.ts';
import { buildRunLog, writeRunLog } from './harness/runlog.ts';

test('every declared step has a good picture and every journey passed', async () => {
  const journeys = (await loadJourneys()).map((l) => l.journey);
  const root = journeysRoot();
  const { entries, results } = readManifests(root);
  const personas = personasFromEnv();
  const report = checkCompleteness({
    journeys,
    entries,
    results,
    files: listPictures(root),
    read: (file) => readFileSync(join(root, file)),
    ...(personas ? { personas } : {}),
  });
  const log = buildRunLog({ results, pending: report.pendingList, pictures: report.checked });
  writeRunLog(root, log);
  test.info().annotations.push({ type: 'declared', description: String(report.declared) }, { type: 'checked', description: String(report.checked) }, { type: 'pending', description: report.pendingList.join('; ') || 'none' });
  expect(report.problems, `completeness problems:\n- ${report.problems.join('\n- ')}`).toEqual([]);
});
