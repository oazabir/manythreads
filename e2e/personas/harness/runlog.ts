// run-log.json (PLAN P12-01): what a persona run was, written next to the pictures. Committed only for a release run (E34).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { JourneyResult } from './manifest.ts';

export interface RunLog {
  sha: string;
  date: string;
  node: string;
  playwright: string;
  chromium: string;
  /** The time the whole run is allowed (E: 25 minutes for the seven shards, one or two at a time). */
  budgetMinutes: number;
  journeys: Array<Pick<JourneyResult, 'persona' | 'journey' | 'kind' | 'status' | 'durationMs'> & { steps: Record<string, string> }>;
  pending: string[];
  totals: { journeys: number; passed: number; failed: number; pending: number; pictures: number };
}

export const RUN_BUDGET_MINUTES = 25;

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export function toolVersions(): { playwright: string; chromium: string } {
  const require = createRequire(import.meta.url);
  let playwright = 'unknown';
  let chromium = 'unknown';
  try {
    playwright = (require('@playwright/test/package.json') as { version: string }).version;
    // playwright-core is not a direct dependency (pnpm): find it from @playwright/test
    const fromTest = createRequire(require.resolve('@playwright/test'));
    const dir = dirname(fromTest.resolve('playwright-core/package.json'));
    const browsers = JSON.parse(readFileSync(join(dir, 'browsers.json'), 'utf8')) as { browsers: Array<{ name: string; browserVersion?: string }> };
    chromium = browsers.browsers.find((b) => b.name === 'chromium')?.browserVersion ?? 'unknown';
  } catch {
    // keep what was found
  }
  return { playwright, chromium };
}

export function buildRunLog(input: { results: readonly JourneyResult[]; pending: readonly string[]; pictures: number; now?: Date }): RunLog {
  const { playwright, chromium } = toolVersions();
  const passed = input.results.filter((r) => r.status === 'passed').length;
  const failed = input.results.filter((r) => r.status === 'failed').length;
  return {
    sha: git(['rev-parse', 'HEAD']),
    date: (input.now ?? new Date()).toISOString(),
    node: process.version,
    playwright,
    chromium,
    budgetMinutes: RUN_BUDGET_MINUTES,
    journeys: input.results.map((r) => ({ persona: r.persona, journey: r.journey, kind: r.kind, status: r.status, durationMs: r.durationMs, steps: r.steps })),
    pending: [...input.pending],
    totals: { journeys: input.results.length, passed, failed, pending: input.pending.length, pictures: input.pictures },
  };
}

export function writeRunLog(root: string, log: RunLog): string {
  mkdirSync(root, { recursive: true });
  const file = join(root, 'run-log.json');
  writeFileSync(file, `${JSON.stringify(log, null, 2)}\n`);
  return file;
}
