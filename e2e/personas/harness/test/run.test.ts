// MANYTHREADS_PERSONAS_CONTINUE=1: a journey that fails shows as failed in results.<kind>.json, the failed steps are named, and later steps still run. Without it the
// remaining steps are 'not-run'. (Real Chromium; the journey's page is served by route handlers.)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkCompleteness } from '../completeness.ts';
import { compareCanary } from '../canary.ts';
import { readManifests } from '../manifest.ts';
import { runJourney } from '../run.ts';
import { BUSY, closeBrowser, launch, screen, serve, type Served } from './browser.ts';
import { journey, step } from './fixtures.ts';

const opened: Served[] = [];
let root = '';
beforeAll(async () => {
  await launch();
  root = mkdtempSync(join(tmpdir(), 'mt-run-'));
}, 120_000);
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});
afterAll(async () => {
  await closeBrowser();
  rmSync(root, { recursive: true, force: true });
});

const GOOD = screen(`<main data-landmark="app-frame"><div data-testid="composer">box</div>${BUSY}</main>`);

async function run(continueOnFailure: boolean, html = GOOD) {
  const served = await serve(html);
  opened.push(served);
  // the second step names a next control the page does not have, so it fails its check
  const j = journey('omar', 'O1', [step('one'), step('two', { next: { testid: 'missing-box' } }), step('three')], { viewports: ['desktop'] });
  const result = await runJourney({
    all: [j],
    journey: j,
    kind: 'desktop',
    stack: undefined as never,
    browser: undefined as never,
    playwright: undefined as never,
    root,
    continueOnFailure,
    open: async () => ({ ctx: { page: served.page } as never, close: () => served.close() }),
  });
  return { j, result };
}

describe('runJourney', () => {
  it('without continue: the step that fails stops the journey, the rest is not-run, and the result says failed', async () => {
    const { result } = await run(false);
    expect(result.status).toBe('failed');
    expect(result.steps).toEqual({ one: 'passed', two: 'failed', three: 'not-run' });
    expect(result.error).toMatch(/omar\/O1\/two \(desktop\): .*next control/);
  }, 60_000);

  it('with continue: every step is tried, the journey is still failed, and results.desktop.json says so', async () => {
    const { j, result } = await run(true);
    expect(result.status).toBe('failed');
    expect(result.steps).toEqual({ one: 'passed', two: 'failed', three: 'passed' });
    const { results, entries } = readManifests(root);
    expect(results.find((r) => r.journey === 'O1')).toMatchObject({ status: 'failed', steps: { two: 'failed' } });
    // the completeness check and the canary comparison both read it as failed, never as passed
    const complete = checkCompleteness({ journeys: [j], entries, results, files: entries.map((e) => e.file), read: () => Buffer.alloc(0), personas: ['omar'] });
    expect(complete.problems.join('\n')).toMatch(/journey omar\/O1 \(desktop\) failed at step two/);
    expect(compareCanary([j], results).actual).toEqual(['omar/O1/two (desktop)']);
  }, 60_000);

  it('a journey that passes shows as passed with every step passed', async () => {
    const served = await serve(GOOD);
    opened.push(served);
    const j = journey('omar', 'O2', [step('one'), step('two')], { viewports: ['desktop'] });
    const result = await runJourney({ all: [j], journey: j, kind: 'desktop', stack: undefined as never, browser: undefined as never, playwright: undefined as never, root, open: async () => ({ ctx: { page: served.page } as never, close: () => served.close() }) });
    expect(result).toMatchObject({ status: 'passed', steps: { one: 'passed', two: 'passed' } });
  }, 60_000);

  it('a failing outcome fails the journey too', async () => {
    const served = await serve(GOOD);
    opened.push(served);
    const j = journey('omar', 'O3', [step('one')], { viewports: ['desktop'], outcome: async () => { throw new Error('the card did not move'); } });
    const result = await runJourney({ all: [j], journey: j, kind: 'desktop', stack: undefined as never, browser: undefined as never, playwright: undefined as never, root, continueOnFailure: true, open: async () => ({ ctx: { page: served.page } as never, close: () => served.close() }) });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/outcome .*the card did not move/);
  }, 60_000);
});
