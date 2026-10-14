import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Persona journeys on the live site (PLAN §4 personas): each persona signs in through the real form
 * and walks the surfaces built for them, proving the product works end to end. Read-only — nothing is
 * posted, created or approved, so no live side effect survives the run (opening a conversation view makes
 * the person's own conversation channel with the bot, which is the feature).
 *
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/j-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const mail = (who: string): string => `${who}@kahf.example`;

test.beforeAll(() => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, who: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(mail(who));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password (is it current?)`).not.toHaveURL(/\/sign-in/);
  return page;
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), mask: [page.locator('[data-vt-mask]')], animations: 'disabled' });
}

async function frame(page: Page): Promise<void> {
  await expect(page.getByTestId('app-frame')).toBeVisible();
}

async function channel(page: Page, team: string, name: string): Promise<void> {
  await page.goto(`/t/${team}/c/${name}`);
  await frame(page);
  await expect(page.getByTestId('no-access')).toHaveCount(0);
}

test("omar (owner): the workspace's models and teams", async ({ browser }) => {
  const page = await signIn(browser, 'omar', DESKTOP);
  try {
    await page.goto('/settings/workspace/llm');
    await frame(page);
    await shoot(page, 'j-omar-llm');
    await page.goto('/teams');
    await frame(page);
    await shoot(page, 'j-omar-teams');
  } finally {
    await page.context().close();
  }
});

test('nadia (engineer): channel, threads inbox, coder conversation', async ({ browser }) => {
  const page = await signIn(browser, 'nadia', DESKTOP);
  try {
    await channel(page, 'engineering', 'dev');
    await shoot(page, 'j-nadia-channel');
    await page.goto('/t/engineering/threads');
    await expect(page.getByRole('tablist', { name: 'Threads' })).toBeVisible();
    await shoot(page, 'j-nadia-threads');
    await page.goto('/t/engineering/bots/coder/chat');
    await expect(page.getByTestId('conversation-view')).toBeVisible();
    await shoot(page, 'j-nadia-coder');
  } finally {
    await page.context().close();
  }
});

test('nadia (engineer): the channel at phone width', async ({ browser }) => {
  const page = await signIn(browser, 'nadia', PHONE);
  try {
    await channel(page, 'engineering', 'dev');
    await shoot(page, 'j-nadia-channel-phone');
  } finally {
    await page.context().close();
  }
});

test('rafi (on-call approver): approvals inbox and incidents', async ({ browser }) => {
  const page = await signIn(browser, 'rafi', DESKTOP);
  try {
    await page.goto('/t/engineering/approvals');
    await frame(page);
    await expect(page.getByTestId('approvals-empty')).toBeVisible();
    await shoot(page, 'j-rafi-approvals');
    await channel(page, 'engineering', 'incidents');
    await shoot(page, 'j-rafi-incidents');
  } finally {
    await page.context().close();
  }
});

test('sameera (support agent): the support channel', async ({ browser }) => {
  const page = await signIn(browser, 'sameera', DESKTOP);
  try {
    await channel(page, 'customer-support', 'support');
    await shoot(page, 'j-sameera-support');
  } finally {
    await page.context().close();
  }
});

test('tariq (marketing lead): content channel and files', async ({ browser }) => {
  const page = await signIn(browser, 'tariq', DESKTOP);
  try {
    await channel(page, 'marketing', 'content');
    await shoot(page, 'j-tariq-content');
    await page.goto('/t/marketing/files');
    await frame(page);
    await expect(page.getByTestId('no-access')).toHaveCount(0);
    await shoot(page, 'j-tariq-files');
  } finally {
    await page.context().close();
  }
});

test('priya (new joiner): home and the general channel', async ({ browser }) => {
  const page = await signIn(browser, 'priya', DESKTOP);
  try {
    await page.goto('/');
    await frame(page);
    await shoot(page, 'j-priya-home');
    await channel(page, 'engineering', 'general');
    await shoot(page, 'j-priya-channel');
  } finally {
    await page.context().close();
  }
});

test('lena (guest): engineering is closed to her', async ({ browser }) => {
  const page = await signIn(browser, 'lena', DESKTOP);
  try {
    await page.goto('/t/engineering/c/dev');
    await expect(page.getByTestId('no-access')).toBeVisible();
    await expect(page.getByText('You cannot see this channel.')).toBeVisible();
    await shoot(page, 'j-lena-noaccess');
    await page.goto('/t/engineering/bots');
    await expect(page.getByTestId('no-access').or(page.getByRole('heading', { name: 'Page not found' }))).toBeVisible();
    await shoot(page, 'j-lena-bots');
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
