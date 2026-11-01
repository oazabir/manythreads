import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * The Marketing bots on the live site: a Marketing member (Tariq) mentioning @content-drafter and @brain in #content is answered, and someone who is
 * not on the Marketing team (Omar, a lead of Engineering) is told why he is not, instead of waiting in silence. Every message is deleted afterwards.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const RAND = process.env['MKT_RAND'] ?? Date.now().toString(36).toUpperCase();
const T = { timeout: 20_000 };
const WAIT = Number(process.env['MKT_WAIT_MS'] ?? 90_000);
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, user: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${user}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${user}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return page;
}

/** Type the mention through the real picker (the handle is chosen from the list), then the rest of the sentence. */
async function post(page: Page, handle: string, rest: string): Promise<void> {
  await page.goto('/t/marketing/c/content');
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await box.click();
  await box.pressSequentially(`@${handle.slice(0, 4)}`);
  const option = page.getByRole('option', { name: new RegExp(handle.replace('-', '[ -]'), 'i') }).first();
  if (await option.isVisible({ timeout: 5_000 }).catch(() => false)) await option.click();
  else await box.fill(`@${handle} `);
  await box.pressSequentially(rest);
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
}

/** The bot's words in the thread of my message: its reply, or the platform's line saying why there is none. */
async function threadText(page: Page, marker: string, wait: number): Promise<string | null> {
  const mine = page.getByTestId('message').filter({ hasText: marker }).last();
  await expect(mine).toBeVisible(T);
  const link = mine.getByText(/\d+ repl(y|ies)/).first();
  if (!(await link.waitFor({ state: 'visible', timeout: wait }).then(() => true, () => false))) return null;
  await link.click();
  await page.waitForTimeout(1_500);
  return (await page.getByTestId('thread-view').first().innerText()).replace(/\s+/g, ' ');
}

async function sweep(page: Page): Promise<void> {
  await page.goto('/t/marketing/c/content');
  await page.getByTestId('channel-view').waitFor(T);
  await page.waitForTimeout(2_000);
  const cid = await page.getByTestId('channel-view').getAttribute('data-channel-id');
  const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const ids = await page.getByTestId('channel-view').getByTestId('message').filter({ hasText: RAND }).evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') ?? ''));
  for (const id of ids) await page.request.delete(`/api/channels/${cid}/messages/${id}`, { headers: { 'x-csrf-token': csrf } });
  console.log(`[marketing] deleted ${ids.length} message(s)`);
}

for (const bot of ['content-drafter', 'brain']) {
  test(`a Marketing member mentions ${bot}`, async ({ browser }) => {
    test.setTimeout(WAIT + 120_000);
    const page = await signIn(browser, 'TARIQ');
    const marker = `[mkt ${RAND} ${bot}]`;
    const sent = Date.now();
    await post(page, bot, ` ${marker} say hello in 5 words`);
    const text = await threadText(page, marker, WAIT);
    console.log(`[marketing] Tariq -> ${bot}: ${text === null ? 'NO ANSWER' : `answered in ${Math.round((Date.now() - sent) / 1000)}s`} ${text?.slice(-140) ?? ''}`);
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, `marketing-${bot}.png`), mask: [page.locator('[data-vt-mask]')] });
    await sweep(page);
    await page.context().close();
    expect(text, `${bot} answered`).not.toBeNull();
  });
}

test('someone off the Marketing team who mentions a Marketing bot is told why there is no answer', async ({ browser }) => {
  test.setTimeout(WAIT + 120_000);
  const page = await signIn(browser, 'OMAR');
  const marker = `[mkt ${RAND} off-team]`;
  await post(page, 'content-drafter', ` ${marker} say hello in 5 words`);
  const text = await threadText(page, marker, WAIT);
  console.log(`[marketing] Omar -> content-drafter: ${text === null ? 'SILENCE' : text.slice(-200)}`);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, 'marketing-off-team.png'), mask: [page.locator('[data-vt-mask]')] });
  await sweep(page);
  await page.context().close();
  expect(text, 'the person is told').toMatch(/not on it|not on the Marketing team/i);
});
