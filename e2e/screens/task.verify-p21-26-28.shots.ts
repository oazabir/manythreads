/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of P21-26 (click a message with a thread), P21-27 (a thread follows the window) and P21-28 (taller message box, no "Also send to" tick).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p21-26-28
 * Signs in as Rafi through the form (RAFI_EMAIL / RAFI_PASSWORD from the environment; never printed). It makes one channel of its own and archives it at the end.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/v2126';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
let ctx: BrowserContext;
let page: Page;
let chanId = '';
let chanName = '';
let rootId = '';
const fivexx: string[] = [];

const csrf = async (): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const shoot = async (n: string): Promise<void> => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
  log(`shot ${n}`);
};
const post = async (body: string, threadRootId: string | null = null): Promise<string> => {
  const res = await page.request.post(`/api/channels/${chanId}/messages`, { headers: await csrf(), data: { channelId: chanId, body, threadRootId } });
  expect(res.status(), `post ${body}`).toBeLessThan(300);
  return ((await res.json()) as any).id as string;
};
const panel = (): ReturnType<Page['locator']> => page.locator('[data-landmark="right-panel"]');
const row = (): ReturnType<Page['locator']> => page.locator(`[data-message-id="${rootId}"]`);
const noSideways = async (label: string): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`${label} scrollWidth ${w.sw} client ${w.cw} => ${w.sw <= w.cw ? 'OK' : 'SIDEWAYS'}`);
  expect(w.sw).toBeLessThanOrEqual(w.cw);
};

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env['RAFI_EMAIL'] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env['RAFI_PASSWORD'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
});
test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length}`);
  // do not leave the probe channel on the live site
  if (chanId) {
    const res = await page.request.post(`/api/channels/${chanId}/archive`, { headers: await csrf() }).catch(() => undefined);
    log(`archive ${chanName}: ${res?.status() ?? 'failed'}`);
  }
  await ctx?.close();
});

test('setup: a channel with a message that has two replies, a link, a mention and a reaction', async () => {
  chanName = `verify-p21-${sfx}`;
  const res = await page.request.post('/api/teams/engineering/channels', { headers: await csrf(), data: { name: chanName } });
  expect(res.status(), 'create channel').toBeLessThan(300);
  chanId = ((await res.json()) as any).channel.id;
  rootId = await post('Release plan: read https://example.com/plan with @rafi before Friday please');
  await post('first reply', rootId);
  await post('second reply', rootId);
  await post('a message nobody answered');
  await page.request.post(`/api/channels/${chanId}/messages/${rootId}/reactions`, { headers: await csrf(), data: { emoji: '👍' } });
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row()).toBeVisible(T);
  await shoot('00-channel');
});

test('P21-26 desktop: a click on the body opens the thread; a link, a reaction or a name does not', async () => {
  await row().locator('.rx').first().click();
  await expect(panel()).toBeHidden();
  const link = row().getByRole('link', { name: 'https://example.com/plan' });
  await link.evaluate((a) => a.addEventListener('click', (e) => e.preventDefault()));
  await link.click();
  await expect(panel()).toBeHidden();
  await row().locator('.who b').click();
  await page.keyboard.press('Escape');
  await expect(panel()).toBeHidden();
  await row().locator('.txt').first().click({ position: { x: 6, y: 6 } });
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', rootId, T);
  await expect(page).toHaveURL(new RegExp(`panel=thread(%3A|:)${rootId}`));
  await shoot('01-click-opens-thread');
  // the same click again: nothing changes
  const url = page.url();
  await row().locator('.txt').first().click({ position: { x: 6, y: 6 } });
  expect(page.url()).toBe(url);
  // a message nobody answered opens no thread
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.locator('[data-testid="message"]').filter({ hasText: 'nobody answered' }).locator('.txt').click();
  await expect(panel()).toBeHidden();
});

test('P21-27 desktop: 1440 -> 850 -> 1440 keeps the draft, the width and the place', async () => {
  await row().getByRole('button', { name: '2 replies' }).click();
  const reply = panel().getByRole('textbox', { name: 'Reply in thread' });
  await expect(reply).toBeVisible(T);
  await reply.fill('draft that must survive');
  const wide = await panel().boundingBox();
  log(`panel width at 1440: ${Math.round(wide!.width)}`);
  await shoot('02-thread-1440');
  await page.setViewportSize({ width: 850, height: 900 });
  await expect(panel()).toHaveAttribute('data-expanded', 'auto', T);
  await expect(page.getByTestId('panel-back-channel')).toBeVisible();
  await expect(reply).toHaveValue('draft that must survive');
  await shoot('03-thread-850-fills');
  await noSideways('850');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(panel()).not.toHaveAttribute('data-expanded', /.+/, T);
  await expect(reply).toHaveValue('draft that must survive');
  const back = await panel().boundingBox();
  log(`panel width back at 1440: ${Math.round(back!.width)}`);
  expect(Math.round(back!.width)).toBe(Math.round(wide!.width));
  await shoot('04-thread-1440-again');
  // the Back arrow at 850 closes the thread
  await page.setViewportSize({ width: 850, height: 900 });
  await page.getByTestId('panel-back-channel').click();
  await expect(panel()).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('P21-28: the resting message box is two lines tall in the channel and the thread; no "Also send to" tick', async () => {
  const box = page.getByRole('textbox', { name: `Message #${chanName}` });
  const h = (await box.boundingBox())!.height;
  log(`channel box resting height ${Math.round(h)}`);
  expect(h).toBeGreaterThanOrEqual(44);
  await row().getByRole('button', { name: '2 replies' }).click();
  const reply = panel().getByRole('textbox', { name: 'Reply in thread' });
  await expect(reply).toBeVisible(T);
  const th = (await reply.boundingBox())!.height;
  log(`thread box resting height ${Math.round(th)}`);
  expect(th).toBeGreaterThanOrEqual(44);
  await expect(page.getByTestId('also-to-channel')).toHaveCount(0);
  await expect(panel().getByText(/Also send to/)).toHaveCount(0);
  await shoot('05-thread-box-no-tick');
  await box.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  await page.waitForTimeout(300);
  const grown = (await box.boundingBox())!.height;
  log(`channel box with 30 lines ${Math.round(grown)}`);
  expect(grown).toBeLessThanOrEqual(376);
  await shoot('06-box-grown');
  await box.fill('');
  // a direct message has the same box
  await page.goto('/t/engineering/dms');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await shoot('07-dms');
});

test('P21-26/27/28 phone 390x844: a tap opens the sheet, the box stays within a third of the screen', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row()).toBeVisible(T);
  await shoot('08-phone-channel');
  await row().locator('.txt').first().click({ position: { x: 6, y: 6 } });
  await expect(page.getByTestId('thread-view')).toHaveAttribute('data-root-id', rootId, T);
  const sheet = await panel().boundingBox();
  log(`phone sheet ${JSON.stringify(sheet)}`);
  expect(Math.round(sheet!.width)).toBe(390);
  await shoot('09-phone-sheet');
  await noSideways('phone sheet');
  await page.getByRole('button', { name: 'Close panel' }).click();
  const box = page.getByRole('textbox', { name: `Message #${chanName}` });
  await box.fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
  await page.waitForTimeout(300);
  const grown = (await box.boundingBox())!.height;
  log(`phone box with 30 lines ${Math.round(grown)}`);
  expect(grown).toBeLessThanOrEqual(Math.ceil(844 / 3));
  await shoot('10-phone-box-grown');
  await box.fill('');
  await noSideways('phone channel');
  expect(fivexx, fivexx.join('\n')).toEqual([]);
});
