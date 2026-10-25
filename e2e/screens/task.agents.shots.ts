import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The Agents page on the live site: the team's connections and the "how to connect" panel. Read-only.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/agents-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
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
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage: true });
}

test('the Agents page lists the connections and how to connect', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/engineering/agents');
    await expect(page.getByTestId('agents-row').first()).toBeVisible({ timeout: 20_000 });
    await shoot(page, 'agents-01-list');
  } finally {
    await page.context().close();
  }
});

const T = { timeout: 20_000 };
const CHAIN_ROOT = '01a17468-1c8a-7417-a867-9e54dea44675'; // the formatPercent goal, run by Orchestrator, Coder, Reviewer and Tester on Claude Code

test('a goal carried by bots running on Claude Code, in its thread', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/engineering/c/dev?message=${CHAIN_ROOT}`);
    const root = page.locator(`[data-message-id="${CHAIN_ROOT}"]`);
    await expect(root).toBeVisible(T);
    await root.getByText(/\d+ repl(y|ies)/).first().click(T);
    const view = page.getByTestId('thread-view');
    await expect(view.getByText('Tester').first()).toBeVisible(T);
    await shoot(page, 'agents-02-claude-thread');
    // the thread panel scrolls on its own: one picture per screenful
    const parts = await view.evaluate((el) => {
      const s = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))].find((c) => c.scrollHeight > c.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(c).overflowY));
      if (!s) return 0;
      s.setAttribute('data-ag-scroll', '1');
      return Math.min(6, Math.ceil(s.scrollHeight / s.clientHeight));
    });
    for (let i = 1; i < parts; i++) {
      await page.locator('[data-ag-scroll="1"]').evaluate((el, n) => { el.scrollTop = n * el.clientHeight; }, i);
      await page.waitForTimeout(400);
      await shoot(page, `agents-02-claude-thread-part${i + 1}`);
    }
  } finally {
    await page.context().close();
  }
});

test('Brain on Claude Code answers a one-to-one chat', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/engineering/bots/brain/chat');
    await expect(page.getByText(/memory_recall/).first()).toBeVisible(T);
    await shoot(page, 'agents-03-brain-claude');
  } finally {
    await page.context().close();
  }
});

test('an app the deployer bot shipped, served under /apps/<team>/<app>/', async ({ browser }) => {
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  try {
    const res = await page.goto(`${BASE}/apps/engineering/money/`);
    expect(res?.status()).toBe(200);
    expect(res?.headers()['content-security-policy']).toContain('sandbox');
    await shoot(page, 'agents-04-path-app');
  } finally {
    await context.close();
  }
});
