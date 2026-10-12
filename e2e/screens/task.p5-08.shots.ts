import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P5-08 (the Workspace → LLM page) on the live site. The input: the settings entry an admin gets, then each of the five
 * sections — providers, aliases, budgets and rate limits, the guard, the spend report. The last test drives the feature for
 * real: it sets a workspace budget through the form, photographs the saved row, and removes it again, so no live side effect
 * survives the run. Signs in with the screenshot password as the workspace owner.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p5-08-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const EMAIL = 'omar@kahf.example';
const DESKTOP = { width: 1440, height: 900 };
const LLM_PATH = '/settings/workspace/llm';

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

/** Screenshots the LLM page with `section` scrolled to, letting `prepare` arrange the screen first. */
async function shootSection(page: Page, name: string, section: string | null, prepare?: (page: Page) => Promise<void>): Promise<void> {
  await page.goto(LLM_PATH);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'LLM', level: 1 })).toBeVisible();
  if (section) await page.locator(section).scrollIntoViewIfNeeded();
  if (prepare) await prepare(page);
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

/** One shot in its own signed-in context. */
async function shoot(browser: Browser, name: string, section: string | null, prepare?: (page: Page) => Promise<void>): Promise<void> {
  const page = await signIn(browser);
  try {
    await shootSection(page, name, section, prepare);
  } finally {
    await page.context().close();
  }
}

test('p5-08 the settings entry and the model providers', async ({ browser }) => {
  await shoot(browser, 'p5-08-llm-providers', null, async (page) => {
    // The section is either a table or the honest empty state; both are the real page.
    await expect(page.getByTestId('llm-providers').or(page.getByTestId('llm-no-providers'))).toBeVisible();
    await expect(page.getByTestId('llm-add-provider')).toBeVisible();
    // The entry an admin gets in the settings nav.
    await expect(page.getByRole('link', { name: 'LLM' })).toBeVisible();
  });
});

test('p5-08 the eight aliases a BOT.md speaks', async ({ browser }) => {
  await shoot(browser, 'p5-08-llm-aliases', '#llm-aliases', async (page) => {
    // The closed set of eight, listed whether or not each is bound.
    await expect(page.locator('[data-alias]')).toHaveCount(8);
    await expect(page.locator('[data-alias="smart"]')).toBeVisible();
    await expect(page.locator('[data-alias="transcribe"]')).toBeVisible();
  });
});

test('p5-08 budgets and rate limits', async ({ browser }) => {
  await shoot(browser, 'p5-08-llm-limits', '#llm-limits', async (page) => {
    await expect(page.getByTestId('llm-set-limit')).toBeVisible();
    await expect(page.getByTestId('llm-limits').or(page.getByTestId('llm-no-limits'))).toBeVisible();
    // The four scopes the gateway enforces, on offer in the form.
    const scopes = await page.locator('#llm-scope option').allTextContents();
    expect(scopes).toEqual(['Workspace', 'Team', 'Bot', 'Session']);
  });
});

test('p5-08 the guard presets', async ({ browser }) => {
  await shoot(browser, 'p5-08-llm-guard', '#llm-guard', async (page) => {
    await expect(page.locator('[data-preset]')).toHaveCount(4);
    await expect(page.locator('[data-preset="air-gapped"]')).toContainText('Only the local alias runs');
    await expect(page.locator('[data-preset="customer-facing"]')).toContainText('refused outright');
  });
});

test('p5-08 the spend report', async ({ browser }) => {
  await shoot(browser, 'p5-08-llm-spend', '#llm-spend', async (page) => {
    await expect(page.getByTestId('llm-spend-total-usd')).toBeVisible();
    await expect(page.getByTestId('llm-spend-total-usd')).toContainText('$');
  });
});

/** The form for real: set a workspace budget, photograph the row, then remove it so nothing is left behind. */
test('p5-08 a workspace budget is set and cleared through the page', async ({ browser }) => {
  const page = await signIn(browser);
  const workspaceRow = page.getByTestId('llm-limits').locator('tr[data-scope="workspace"]');
  try {
    await page.goto(LLM_PATH);
    await page.waitForLoadState('networkidle');
    await page.getByTestId('llm-set-limit').locator('#llm-scope').selectOption('workspace');
    await page.getByLabel('Budget (USD)').fill('5');
    await page.getByRole('button', { name: 'Set limit' }).click();

    await expect(page.getByTestId('llm-limits').locator('tr[data-scope="workspace"]')).toContainText('$5.00');
    await expect(page.getByRole('status')).toContainText('The workspace limit is saved.');
    await shootSection(page, 'p5-08-llm-limit-set', '#llm-limits', async (p) => {
      await expect(p.getByTestId('llm-limits').locator('tr[data-scope="workspace"]')).toContainText('$5.00');
    });
  } finally {
    // Remove it even if an assertion above failed: the live workspace keeps no limit this run invented.
    if (await workspaceRow.count()) {
      await workspaceRow.getByRole('button', { name: 'Remove' }).click();
      await expect(page.getByTestId('llm-limits').locator('tr[data-scope="workspace"]')).toHaveCount(0);
    }
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
