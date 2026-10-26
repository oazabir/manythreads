import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The full-cycle run on the live site: the Delivery team's goal thread in #manythreads (Orchestrator's checklist, Coder, Reviewer, Tester,
 * Deployer, Browser tester), the team's Projects page, and the preview the Deployer shipped (https://test.manythreads.kahf.to) with the new
 * Show password toggle switched on. Read-only; the preview is only looked at, never signed in to.
 * Run 2 (the same chain on Claude Code, which shipped a Caps Lock warning instead): MANYTHREADS_FULL_CYCLE_RUN=2 and MANYTHREADS_RUN1_ROOT=<its
 * root message>; the pictures are then named full-cycle-run2-*.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/full-cycle-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PREVIEW = 'https://test.manythreads.kahf.to';
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const T = { timeout: 20_000 };
const RUN1_ROOT = process.env['MANYTHREADS_RUN1_ROOT'] ?? '01a174a2-eb44-7e0f-a9e6-8ec1697e14d4';
const RUN2 = process.env['MANYTHREADS_FULL_CYCLE_RUN'] === '2';
const PREFIX = RUN2 ? 'full-cycle-run2' : 'full-cycle';

test.describe.configure({ mode: 'serial' });

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

async function shoot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage });
}

test('the goal thread: checklist and the whole chain, one picture per screenful', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto(`/t/delivery/c/manythreads?message=${RUN1_ROOT}`);
    const root = page.locator(`[data-message-id="${RUN1_ROOT}"]`);
    await expect(root).toBeVisible(T);
    await root.getByText(/\d+ repl(y|ies)/).first().click(T);
    const view = page.getByTestId('thread-view');
    await expect(view.getByText('Browser tester').first()).toBeVisible(T);
    // The preview's disposable test passwords were posted in this thread (the handover flaw fixed since): hide anything that looks like one
    // (mixed case and digits, 20 to 32 characters) before any picture. Commit shas are lowercase hex and stay readable.
    await page.evaluate(() => {
      const looksLikeSecret = /(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*\d)\b[A-Za-z0-9]{20,32}\b/g;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue && looksLikeSecret.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(looksLikeSecret, '••••••••');
    });
    await shoot(page, `${PREFIX}-01-thread`);
    const parts = await view.evaluate((el) => {
      const s = [el, ...Array.from(el.querySelectorAll<HTMLElement>('*'))].find((c) => c.scrollHeight > c.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(c).overflowY));
      if (!s) return 0;
      s.setAttribute('data-fc-scroll', '1');
      return Math.min(24, Math.ceil(s.scrollHeight / s.clientHeight));
    });
    for (let i = 1; i < parts; i++) {
      await page.locator('[data-fc-scroll="1"]').evaluate((el, n) => { el.scrollTop = n * el.clientHeight; }, i);
      await page.waitForTimeout(400);
      await shoot(page, `${PREFIX}-01-thread-part${String(i + 1).padStart(2, '0')}`);
    }
  } finally {
    await page.context().close();
  }
});

test('the Delivery team\'s project, mapped to #manythreads', async ({ browser }) => {
  const page = await signIn(browser);
  try {
    await page.goto('/t/delivery/projects');
    await expect(page.getByText('github.com/oazabir/manythreads').first()).toBeVisible(T);
    await shoot(page, `${PREFIX}-02-projects`);
  } finally {
    await page.context().close();
  }
});

test('the preview the Deployer shipped: sign-in with the Show password toggle on', async ({ browser }) => {
  test.skip(RUN2, 'run 2 shipped the Caps Lock warning');
  const context = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    const res = await page.goto(`${PREVIEW}/sign-in`);
    expect(res?.status()).toBe(200);
    await page.getByLabel('Email').fill('someone@example.com');
    await page.getByLabel('Password', { exact: true }).fill('not-a-real-password');
    await shoot(page, 'full-cycle-03-preview-hidden');
    const toggle = page.getByRole('button', { name: 'Show password' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
    await shoot(page, 'full-cycle-04-preview-shown');
  } finally {
    await context.close();
  }
});

test('run 2\'s preview: the Caps Lock warning under the password field', async ({ browser }) => {
  test.skip(!RUN2, 'run 1 shipped the Show password toggle');
  const context = await browser.newContext({ viewport: DESKTOP, reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    const res = await page.goto(`${PREVIEW}/sign-in`);
    expect(res?.status()).toBe(200);
    await page.getByLabel('Email').fill('someone@example.com');
    const password = page.getByLabel('Password', { exact: true });
    await password.fill('not-a-real-password');
    await expect(page.getByText('Caps Lock is on')).toHaveCount(0);
    await shoot(page, 'full-cycle-run2-03-preview-off');
    // Headless Chromium does not report a real Caps Lock key as a modifier, so the key event carries the modifier itself (as the Browser tester did).
    await password.dispatchEvent('keyup', { key: 'a', modifierCapsLock: true });
    await expect(page.getByText('Caps Lock is on')).toBeVisible(T);
    await shoot(page, 'full-cycle-run2-04-preview-on');
  } finally {
    await context.close();
  }
});
