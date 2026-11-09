// T4 · Tariq, who leads Marketing, sets up the weekly social round-up as a job and runs it once (PLAN block B): a routine whose contract lives in the team repo, run by the
// Content drafter, with its report as a page. Hermes behind the bot is the stand-in of support/hermes-tariq.mjs: its reply is the page.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { applyGuarded } from '../../support/stack-browser.ts';
import { TARIQ_ENV, TEAM, allowKnownNoise, arrangeBot, contentDrafterMd } from './support/index.ts';

const CONTRACT = 'routines/weekly-social.yaml';
const OUTPUT = 'pages/reports/weekly-social.md';
const CONTRACT_YAML = `name: Weekly social round-up
prompt: |
  Write the weekly social plan for the week: the posts, the day for each, and what the Brand reviewer should look at. Keep it under one page.
output:
  page: ${OUTPUT}
  mode: replace
`;

export default defineJourney({
  id: 'T4',
  persona: 'tariq',
  goal: 'Set up the weekly social round-up as a job for the Content drafter, run it once, and read the page it writes.',
  markers: [],
  start: 'week-2',
  stackEnv: TARIQ_ENV,
  steps: [
    {
      id: 'jobs-empty',
      expect: 'scheduled-jobs-empty',
      next: { testid: 'job-tile-create', label: 'Create a routine' },
      run: async ({ page, stack, api }) => {
        allowKnownNoise(page);
        await arrangeBot(stack, await api('omar'), TEAM, 'content-drafter', contentDrafterMd());
        const tariq = await api('tariq');
        const applied = await applyGuarded(tariq, CONTRACT, CONTRACT_YAML, 'Add the weekly social routine', { team: TEAM });
        expect(applied.status, applied.text.slice(0, 200)).toBeLessThan(300);
        await page.goto(`/t/${TEAM}/jobs`);
        await expect(page.getByTestId('job-tile')).toHaveCount(3);
      },
    },
    {
      id: 'routine-form',
      expect: 'new-scheduled-job-form',
      next: { testid: 'save-scheduled-job', label: 'Save job' },
      run: async ({ page }) => {
        await page.locator('[data-testid="job-tile"][data-kind="routine"]').getByTestId('job-tile-create').click();
        await expect(page.getByTestId('scheduled-job-kind')).toHaveValue('routine');
      },
    },
    {
      id: 'routine-filled',
      expect: 'new-scheduled-job-form',
      next: { testid: 'save-scheduled-job', label: 'Save job' },
      run: async ({ page }) => {
        await page.getByTestId('scheduled-job-name').fill('Weekly social round-up');
        await page.getByTestId('scheduled-job-bot').selectOption('content-drafter');
        await page.getByTestId('scheduled-job-schedule').fill('0 8 * * mon');
        await page.getByTestId('scheduled-job-contract').fill(CONTRACT);
        await page.getByTestId('scheduled-job-output').fill(OUTPUT);
      },
    },
    {
      id: 'job-saved',
      expect: 'scheduled-jobs',
      next: { testid: 'scheduled-job-run', label: 'Run now' },
      run: async ({ page }) => {
        await page.getByTestId('save-scheduled-job').click();
        await expect(page.getByTestId('scheduled-job-notice')).toContainText('Weekly social round-up');
        await expect(page.getByTestId('scheduled-job-row')).toHaveCount(1);
      },
    },
    {
      id: 'job-run',
      expect: 'scheduled-job-runs',
      run: async ({ page, api }) => {
        const tariq = await api('tariq');
        await page.getByTestId('scheduled-job-run').click();
        await expect(page.getByTestId('scheduled-job-notice')).toContainText('started');
        const id = await page.getByTestId('scheduled-job-row').getAttribute('data-scheduled-job');
        await expect
          .poll(
            async () => {
              const run = (await tariq.get<{ items: Array<{ status: string; reason?: string | null }> }>(`/api/teams/${TEAM}/scheduled-jobs/${id}/runs`)).items[0];
              if (run?.status === 'failed') throw new Error(`the run failed: ${run.reason ?? 'no reason given'}`);
              return run?.status;
            },
            { timeout: 90_000 },
          )
          .toBe('done');
        await page.reload();
        await page.getByTestId('scheduled-job-open').click();
        await expect(page.getByTestId('scheduled-job-runs').locator('li[data-status="done"]')).toHaveCount(1);
      },
    },
    {
      id: 'report-page',
      expect: 'viewer-markdown',
      run: async ({ page }) => {
        await page.goto(`/t/${TEAM}/files?open=${encodeURIComponent(OUTPUT)}`);
        await expect(page.getByTestId('viewer-markdown').locator('.md-prose h1')).toHaveText('Weekly social round-up', { timeout: 30_000 });
      },
    },
  ],
  outcome: async ({ api }) => {
    const priya = await api('priya');
    const page = await priya.get<{ content: string }>(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(OUTPUT)}`);
    expect(page.content, 'the page the run wrote, read by a colleague').toContain('Posts this week');
    const jobs = await priya.get<{ items: Array<{ name: string; enabled: boolean }> }>(`/api/teams/${TEAM}/scheduled-jobs`);
    const mine = jobs.items.filter((j) => j.name === 'Weekly social round-up');
    expect(mine, 'one job of that name').toHaveLength(1);
  },
});
