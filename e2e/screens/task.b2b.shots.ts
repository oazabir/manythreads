import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Bot-to-bot delegation on a live #dev thread: one person asks @orchestrator,
 * and three bots answer each other in the same thread (orchestrator -> coder
 * -> tester -> orchestrator). Run AFTER the headless journey driver has
 * posted the trigger (tools/devbox/demo-journeys.mjs post ...), so the thread
 * holds all four bot replies. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/b2b-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const TEAM = process.env['MANYTHREADS_LIVE_TEAM'] ?? 'engineering';
// The trigger the journey driver posted for this run.
const TRIGGER = process.env['MANYTHREADS_B2B_TRIGGER'] ?? 'screenshot run 2';
const DESKTOP = { width: 1440, height: 900 };

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, 'password sign-in as the workspace owner (is the live password current?)').not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

test('bot-to-bot the #dev thread holds the full delegation chain', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/${TEAM}/c/dev`);
    const root = page.getByTestId('message').filter({ hasText: TRIGGER }).first();
    await expect(root, 'the bot-to-bot trigger message in #dev').toBeVisible();
    await root.getByRole('button', { name: /repl/ }).click();
    const thread = page.getByTestId('thread-view');
    await expect(thread, 'the thread panel opens').toBeVisible();
    await expect(thread.getByText('Orchestrator here. Plan')).toBeVisible();
    await expect(thread.getByText('Coder here — implemented')).toBeVisible();
    await expect(thread.getByText('Tester here — verified')).toBeVisible();
    await expect(thread.getByText('confirmation from Tester received')).toBeVisible();
    await shoot(page, 'b2b-thread');
  } finally {
    await page.context().close();
  }
});
