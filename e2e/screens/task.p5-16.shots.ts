import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-16 (conversations) on the live site: the roster's Talk button, the empty conversation view with the bot's example questions,
 * and the same view at phone width. Read-only — nothing is sent, so no live side effect survives the run (opening the view makes the
 * person's conversation channel with the bot, which is the feature). Signs in with the screenshot password as the workspace owner.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-16-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce' });
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

/** The first team's roster: the app lands on a team route, the roster is `/t/<slug>/bots`. */
async function openRoster(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/t\/[^/]+/);
  const team = /\/t\/([^/]+)/.exec(new URL(page.url()).pathname)?.[1];
  expect(team, 'the app landed on a team route').toBeTruthy();
  await page.goto(`/t/${team}/bots`);
  await expect(page.getByTestId('bot-talk').first()).toBeVisible();
}

test('p5-16 the roster offers Talk on a bot that can be talked to', async ({ browser }) => {
  const page = await signIn(browser, DESKTOP);
  try {
    await openRoster(page);
    await shoot(page, 'p5-16-roster-talk');
  } finally {
    await page.context().close();
  }
});

test('p5-16 the conversation view, empty, with the example questions (desktop)', async ({ browser }) => {
  const page = await signIn(browser, DESKTOP);
  try {
    await openRoster(page);
    const talk = page.locator('a[data-testid="bot-talk"]').first();
    await expect(talk, 'at least one bot on the live site has a conversation trigger').toBeVisible();
    await talk.click();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await shoot(page, 'p5-16-conversation-empty');
  } finally {
    await page.context().close();
  }
});

test('p5-16 the conversation view at phone width', async ({ browser }) => {
  const page = await signIn(browser, PHONE);
  try {
    await openRoster(page);
    const talk = page.locator('a[data-testid="bot-talk"]').first();
    await expect(talk).toBeVisible();
    await talk.click();
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await shoot(page, 'p5-16-conversation-phone');
  } finally {
    await page.context().close();
  }
});
