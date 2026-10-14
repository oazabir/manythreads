import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-22 (minimal onboarding) on the live site: the setup checklist at /onboarding on desktop
 * and at phone width. Read-only — nothing is created or changed, so no live side effect survives
 * the run. Signs in with the screenshot password as the workspace owner.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-22-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
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

async function openOnboarding(page: Page): Promise<void> {
  await page.goto('/onboarding');
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
  await expect(page.locator('[data-landmark="steps"] [data-step]')).toHaveCount(5);
}

test('p5-22 the setup checklist (desktop)', async ({ browser }) => {
  const page = await signIn(browser, DESKTOP);
  try {
    await openOnboarding(page);
    await shoot(page, 'p5-22-onboarding');
  } finally {
    await page.context().close();
  }
});

test('p5-22 the setup checklist at phone width', async ({ browser }) => {
  const page = await signIn(browser, PHONE);
  try {
    await openOnboarding(page);
    await shoot(page, 'p5-22-onboarding-phone');
  } finally {
    await page.context().close();
  }
});

/** Rebuilds the gallery over the whole output folder, so it shows every task's screenshots, not only this run's. */
test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  const shots: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.png')) shots.push(relative(OUT, full).split(sep).join('/'));
    }
  };
  walk(OUT);
  shots.sort();
  const figures = shots
    .map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`)
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`;
  writeFileSync(join(OUT, 'index.html'), html);
});
