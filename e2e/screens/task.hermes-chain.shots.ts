import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/** LLM chain sanity on the live site (P14-22 verification): a normal user mentions each bot with a trivial request and times the answer; then bot A is asked to tag bot B. */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const TEAM = process.env['CHAIN_TEAM'] ?? 'engineering';
const CHANNEL = process.env['CHAIN_CHANNEL'] ?? 'dev';
const USER = (process.env['CHAIN_USER'] ?? 'NADIA').toUpperCase();
const BOTS = (process.env['CHAIN_BOTS'] ?? 'brain,coder').split(',').filter(Boolean);
const PAIR = (process.env['CHAIN_PAIR'] ?? 'engineer:brain').split(':');
const LIMIT = 180_000;
const RAND = Date.now().toString(36).toUpperCase();
const T = { timeout: 20_000 };
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[`${USER}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${USER}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return page;
}

async function post(page: Page, body: string): Promise<void> {
  await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const box = page.locator('[data-landmark="composer"] textarea').first();
  await expect(box).toBeVisible(T);
  await box.fill(body);
  await page.locator('[data-landmark="composer"]').first().getByRole('button', { name: 'Send', exact: true }).click();
}

async function openThread(page: Page, body: string, wait: number): Promise<{ ok: boolean; ms: number; start: number }> {
  const start = Date.now();
  const mine = page.getByTestId('message').filter({ hasText: body.slice(0, 40) }).last();
  await expect(mine).toBeVisible(T);
  const link = mine.getByText(/\d+ repl(y|ies)/).first();
  const ok = await link.waitFor({ state: 'visible', timeout: wait }).then(() => true, () => false);
  return { ok, ms: Date.now() - start, start };
}

for (const bot of BOTS) {
  test(`hello ${bot}`, async ({ browser }) => {
    test.setTimeout(LIMIT + 120_000);
    const page = await signIn(browser);
    const body = `@${bot} (hello ${RAND}-${bot}) say hello in 5 words`;
    const sent = Date.now();
    await post(page, body);
    const r = await openThread(page, body, LIMIT);
    let text = '';
    if (r.ok) {
      await page.getByTestId('message').filter({ hasText: body.slice(0, 40) }).last().getByText(/\d+ repl(y|ies)/).first().click();
      const panel = page.getByTestId('thread-view').first();
      await page.waitForTimeout(1500);
      text = (await panel.innerText()).replace(/\s+/g, ' ');
    }
    console.log(`[chain] ${bot}: ${r.ok ? 'ANSWERED' : 'NO ANSWER'} in ${Math.round((Date.now() - sent) / 1000)}s ${text.slice(-160)}`);
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, `chain-hello-${bot}.png`), mask: [page.locator('[data-vt-mask]')] });
    await page.context().close();
  });
}

test(`tag ${PAIR[0]} -> ${PAIR[1]}`, async ({ browser }) => {
  test.setTimeout(LIMIT + 240_000);
  const [a, b] = PAIR as [string, string];
  const page = await signIn(browser);
  const body = `@${a} no code changes please (tag check ${RAND}): ask @${b} to reply with the word PING in this thread, nothing else`;
  const sent = Date.now();
  await post(page, body);
  const r = await openThread(page, body, LIMIT);
  expect(r.ok, `${a} replied`).toBe(true);
  await page.getByTestId('message').filter({ hasText: body.slice(0, 40) }).last().getByText(/\d+ repl(y|ies)/).first().click();
  const panel = page.getByTestId('thread-view').first();
  const bReplies = panel.getByTestId('message').filter({ has: page.locator('.who b', { hasText: new RegExp(`^${b}$`, 'i') }) });
  let bMs = -1;
  const deadline = sent + LIMIT + 60_000;
  while (Date.now() < deadline) {
    if ((await bReplies.count()) > 0) { bMs = Date.now() - sent; break; }
    await page.waitForTimeout(3_000);
  }
  const txt = (await panel.innerText()).replace(/\s+/g, ' ');
  console.log(`[chain] ${a}->${b}: ${bMs > 0 ? `B REPLIED after ${Math.round(bMs / 1000)}s` : 'B DID NOT REPLY'}; PING in thread: ${/PING/.test(txt.replace(body, ''))}; tail: ${txt.slice(-300)}`);
  await page.screenshot({ path: join(OUT, `chain-tag-${a}-${b}.png`), mask: [page.locator('[data-vt-mask]')] });
  await page.context().close();
});
