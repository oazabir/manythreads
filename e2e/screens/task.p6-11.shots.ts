import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P6-11 on the live site: seed v6 in the Engineering team — the team board with cards in all five columns, the Bot Board on #dev with
 * the coder's card, and the Rhythms page with the two switched-off rhythms and their past runs. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p6-11-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const T = { timeout: 20_000 };

async function signIn(browser: Browser): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const context = await browser.newContext({ baseURL: BASE, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
}

async function openBoard(page: Page, name: string): Promise<void> {
  await page.goto('/t/engineering/boards');
  const board = page.getByTestId('board-view');
  await expect(board).toBeVisible(T);
  await page.getByTestId('board-select').selectOption({ label: name });
  await expect(page.getByTestId('board-select').locator('option:checked')).toContainText(name);
  // the columns load after the board: wait until "Loading…" is gone
  await expect(board.getByText('Loading…')).toHaveCount(0, T);
}

test('seed v6: the Engineering board, its Bot Board and its rhythms', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await openBoard(page, 'Engineering board');
    const board = page.getByTestId('board-view');
    await expect(board.getByText('Cap the webhook retry at five attempts')).toBeVisible(T);
    await expect(board.getByText('Rotate the staging deploy key')).toBeVisible(T);
    await shoot(page, 'p6-11-01-engineering-board');

    await openBoard(page, 'Bot Board · #dev');
    await expect(board.getByText('Summarise the overnight CI failures')).toBeVisible(T);
    await shoot(page, 'p6-11-02-bot-board');

    await page.goto('/t/engineering/rhythms');
    await expect(page.getByText('Weekly deploy health').first()).toBeVisible(T);
    await shoot(page, 'p6-11-03-rhythms');
  } finally {
    await page.context().close();
  }
});

/**
 * P6-08 on the live site: "Run now" on the Weekly deploy health routine started the Coder, which wrote the routine's page and said so in
 * the team's first public channel ("wrote <page> · diff"). Read-only: the run was started before this script.
 */
test('a routine run wrote its page and said so in the channel', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/engineering/c/general');
    const note = page.getByText(/wrote/).last();
    await expect(note).toBeVisible(T);
    await note.scrollIntoViewIfNeeded();
    await shoot(page, 'p6-08-01-routine-wrote-page');
    await page.getByRole('link', { name: /deploy-health|pages\/reports/ }).last().click();
    await expect(page.getByText('Weekly deploy health').first()).toBeVisible(T);
    await shoot(page, 'p6-08-02-routine-page');
  } finally {
    await page.context().close();
  }
});
