import { expect, test, type Page } from '@playwright/test';
import { authState } from '../support/env.ts';
import { noSidewaysScroll } from '../support/stack-browser.ts';

/*
 * System health and Usage (PLAN P21-19, POLISH 6.4): health lists problems first with a dot and a word per check under a one-line verdict; the usage
 * day chart always draws the whole range, every bar can be focused (one bar in the Tab order, the arrow keys move between bars) and the chart says
 * "No data yet" when nothing happened. Read-only, so it runs on the shared server; the usage answer is rewritten in the browser (the real call is
 * made, then its `daily` list is replaced) because the shared server's runs depend on which specs ran before. Runs on desktop and at 390 px.
 */
test.use({ storageState: authState('omar') });

const RANK: Record<string, number> = { down: 0, warn: 1, ok: 2, off: 3 };
const WORDS: Record<string, string> = { down: 'Down', warn: 'Over limit', ok: 'Fine', off: 'Off' };

test('System health: a verdict line, problems first, a dot and a word on every check', async ({ page }) => {
  await page.goto('/settings/workspace/health');
  await expect(page.getByRole('heading', { level: 1, name: 'System health' })).toBeVisible();
  const rows = page.locator('[data-check]');
  await expect(rows.first()).toBeVisible();
  const statuses = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-status') ?? ''));
  expect(statuses.length).toBeGreaterThan(0);
  const ranks = statuses.map((s) => RANK[s]);
  expect(ranks.every((r) => r !== undefined)).toBe(true);
  expect(ranks, 'worst first, switched-off last').toEqual([...ranks].sort((a, b) => (a ?? 0) - (b ?? 0)));
  // each row says its status in a word, not only in a colour
  for (let i = 0; i < statuses.length; i += 1) await expect(rows.nth(i).locator('.health-st')).toHaveText(WORDS[statuses[i]!]!);
  // the verdict counts exactly the rows that are Down or Over limit
  const problems = statuses.filter((s) => s === 'down' || s === 'warn').length;
  await expect(page.getByTestId('health-summary')).toHaveText(problems === 0 ? 'All fine' : problems === 1 ? '1 problem' : `${problems} problems`);
  expect(await noSidewaysScroll(page)).toBe(true);
});

/** The server's answer with `daily` replaced by `days` days ending today (UTC), a few of them with failed runs (or by none at all). */
async function withDays(page: Page, spend: boolean, empty = false): Promise<void> {
  await page.route(/\/api\/workspace\/usage\?/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { range: { days: number; since: string; until: string }; daily: unknown[] };
    const days = Number(new URL(route.request().url()).searchParams.get('days'));
    const end = Date.parse(`${body.range.until}T00:00:00.000Z`);
    body.range.days = days;
    body.daily = empty ? [] : Array.from({ length: days }, (_, i) => ({
      day: new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      runs: (i % 5) + 1,
      failedRuns: i % 7 === 0 ? 1 : 0,
      toolCalls: i,
      answers: i % 3,
      spendUsd: spend ? (i % 4) / 2 : null,
    }));
    await route.fulfill({ response: res, json: body });
  });
}

test('Usage: the chart draws every day of the range, one bar is in the Tab order and the arrow keys move between bars', async ({ page }) => {
  await withDays(page, true);
  await page.goto('/settings/workspace/usage');
  const chart = page.getByTestId('usage-chart-usage-runs-chart');
  await expect(chart).toBeVisible();
  const bars = chart.locator('.usage-col');
  await expect(bars).toHaveCount(30);
  const tabbable = chart.locator('.usage-col[tabindex="0"]');
  await expect(tabbable).toHaveCount(1);
  // every bar reads as "3 Nov: 4 runs" (and says how many failed) for a screen reader and for the tooltip
  await expect(bars.last()).toHaveAttribute('aria-label', /^\d{1,2} [A-Z][a-z]{2}: \d+ runs( \(\d+ failed\))?$/);
  await expect(chart.locator('.usage-tip').last()).toHaveText((await bars.last().getAttribute('aria-label'))!);

  await bars.last().focus();
  await page.keyboard.press('ArrowLeft');
  await expect(bars.nth(28)).toBeFocused();
  await expect(bars.nth(28)).toHaveAttribute('tabindex', '0');
  await expect(bars.last()).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(bars.first()).toBeFocused();
  await page.keyboard.press('End');
  await expect(bars.last()).toBeFocused();
  await page.keyboard.press('ArrowRight'); // past the end: stays
  await expect(bars.last()).toBeFocused();

  // the tooltip shows on focus, sits below the chart title (never over it), and Esc puts it away until another bar is focused
  const tip = chart.locator('.usage-tip').last();
  await expect(tip).toBeVisible();
  const title = await chart.locator('.box-h').boundingBox();
  const tipBox = await tip.boundingBox();
  expect(tipBox!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 1);
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(chart.locator('.usage-tip').nth(28)).toBeVisible();

  // a shorter range while the chart stays on screen: still 1 bar in the Tab order (the last bar was the active one)
  await page.getByTestId('usage-range').getByRole('button', { name: '7 days' }).click();
  await expect(page.getByTestId('usage-range').getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.locator('.usage-col')).toHaveCount(7);
  await expect(chart.locator('.usage-col[tabindex="0"]')).toHaveCount(1);
  expect(await noSidewaysScroll(page)).toBe(true);
});

test('Usage: a range with nothing in it says "No data yet" instead of drawing bars', async ({ page }) => {
  await withDays(page, true, true);
  await page.goto('/settings/workspace/usage');
  const chart = page.getByTestId('usage-chart-usage-runs-chart');
  await expect(chart).toBeVisible();
  await expect(chart.getByText('No data yet')).toBeVisible();
  await expect(chart.locator('.usage-col')).toHaveCount(0);
  expect(await noSidewaysScroll(page)).toBe(true);
});
