import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Demo personabots on the live site: the roster with the five demo bots, the
 * orchestrator/coder/tester chain threads, the brain memory answer, the
 * sentinel gate-hold approval, and the #dev mention thread. Run AFTER the
 * headless journey driver (tools/devbox/demo-journeys.mjs) has talked to the
 * bots, so every view shows real replies. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/demo-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const TEAM = process.env['MANYTHREADS_LIVE_TEAM'] ?? 'engineering';
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

/**
 * Open a bot's chat view on a thread: `DEMO_THREAD_<BOT>` (the root id the
 * journey driver printed) deep-links it, else the first listed row is opened.
 */
async function openFirstThread(page: Page, bot: string): Promise<void> {
  const deep = process.env[`DEMO_THREAD_${bot.toUpperCase()}`];
  await page.goto(deep ? `/t/${TEAM}/bots/${bot}/chat?thread=${deep}` : `/t/${TEAM}/bots/${bot}/chat`);
  await expect(page.getByTestId('conversation-view')).toBeVisible();
  if (!deep) {
    const row = page.getByTestId('conversation-row').first();
    if ((await row.count()) > 0) await row.click();
  }
}

test('demo the roster holds the five demo bots', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/${TEAM}/bots`);
    await expect(page.getByTestId('bot-talk').first()).toBeVisible();
    await shoot(page, 'demo-roster');
  } finally {
    await page.context().close();
  }
});

for (const bot of ['orchestrator', 'coder', 'tester', 'brain']) {
  test(`demo ${bot} thread with a real reply`, async ({ browser }) => {
    const page = await signIn(browser);
    try {
      await openFirstThread(page, bot);
      await shoot(page, `demo-chat-${bot}`);
    } finally {
      await page.context().close();
    }
  });
}

test('demo the gate-hold approval waits in the inbox', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/${TEAM}/approvals`);
    await shoot(page, 'demo-approvals');
  } finally {
    await page.context().close();
  }
});

test('demo the #dev mention thread', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/${TEAM}/c/dev`);
    await shoot(page, 'demo-channel-dev');
  } finally {
    await page.context().close();
  }
});
