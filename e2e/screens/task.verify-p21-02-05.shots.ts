/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of P21-02 (hover bar quick reactions, + pill, who reacted, row keys) and P21-05 (toasts with Undo, Esc on the list, Jump to latest count, day pills).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p21-02-05
 * Signs in as Omar through the form (OMAR_EMAIL / OMAR_PASSWORD from the environment; never printed) and as Nadia through the sign-in route (NADIA_EMAIL /
 * NADIA_PASSWORD) for the replies. It makes one channel of its own and archives it at the end. No bot is mentioned, so VERIFY_SKIP_BOT=1 changes nothing here; it is accepted
 * for parity with the earlier checks.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/v2102';
// Rafi is not a team lead, so he cannot create a channel (403); the default user is Omar. Set VERIFY_AS=RAFI to change.
const WHO = process.env['VERIFY_AS'] ?? 'OMAR';
const OTHER = process.env['VERIFY_OTHER'] ?? 'NADIA';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
let ctx: BrowserContext;
let page: Page;
let other: APIRequestContext;
let otherCsrf: Record<string, string> = {};
let chanId = '';
let chanName = '';
const ids: Record<string, string> = {};
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
  expect(res.status(), `post ${body.slice(0, 30)}`).toBeLessThan(300);
  return ((await res.json()) as any).id as string;
};
const row = (key: string): ReturnType<Page['locator']> => page.locator(`[data-message-id="${ids[key]}"]`);
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
  await page.getByLabel('Email').fill(process.env[`${WHO}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${WHO}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  // the second person, by the API (never printed)
  other = await request.newContext({ baseURL: BASE });
  const res = await other.post('/api/auth/password/sign-in', { data: { email: process.env[`${OTHER}_EMAIL`] ?? '', password: process.env[`${OTHER}_PASSWORD`] ?? '' } });
  expect(res.ok(), `sign in as ${OTHER}`).toBe(true);
  const c = (await other.storageState()).cookies.find((x) => x.name.endsWith('manythreads_csrf'));
  otherCsrf = c ? { 'x-csrf-token': c.value } : {};
});
test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length}`);
  // do not leave the probe channel on the live site
  if (chanId) {
    const res = await page.request.post(`/api/channels/${chanId}/archive`, { headers: await csrf() }).catch(() => undefined);
    log(`archive ${chanName}: ${res?.status() ?? 'failed'}`);
  }
  await other?.dispose();
  await ctx?.close();
});

test('setup: a channel with many messages, one reacted message, one unread line', async () => {
  chanName = `verify-p21-02-${sfx}`;
  const res = await page.request.post('/api/teams/engineering/channels', { headers: await csrf(), data: { name: chanName } });
  if (res.status() >= 300) log(`create channel ${res.status()} ${(await res.text()).slice(0, 300)}`);
  expect(res.status(), 'create channel').toBeLessThan(300);
  chanId = ((await res.json()) as any).channel.id;
  ids['first'] = await post('First message of the probe channel');
  for (let i = 1; i <= 40; i += 1) await post(`Filler message ${i}: something to scroll past`);
  ids['target'] = await post('React to this one');
  ids['last'] = await post('The last message');
  const r = await other.post(`/api/channels/${chanId}/messages/${ids['target']}/reactions`, { headers: otherCsrf, data: { emoji: '👍' } });
  expect(r.status(), 'other reacts').toBeLessThan(300);
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row('last')).toBeVisible(T);
  await shoot('00-channel-desktop');
});

test('P21-02 desktop: quick reactions in the hover bar, + pill, who reacted', async () => {
  const target = row('target');
  await target.scrollIntoViewIfNeeded();
  await target.hover();
  const bar = target.locator('.acts');
  await expect(bar.getByRole('button', { name: 'React with 👍' })).toBeVisible();
  await shoot('01-hover-bar-desktop');
  const pill = target.locator('.reactions .rx:not(.rx-add)');
  await pill.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('reacted with 👍', T);
  log(`tip: ${await tip.innerText()}`);
  await shoot('02-who-reacted-desktop');
  await page.mouse.move(5, 5);
  await target.hover();
  await target.getByRole('button', { name: 'Add another reaction' }).click();
  await expect(page.getByRole('menu', { name: 'Reactions' })).toBeVisible();
  await shoot('03-plus-pill-menu-desktop');
  await page.keyboard.press('Escape');
  await target.hover();
  await target.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Copy text' })).toBeVisible(T);
  await shoot('03a-more-menu-desktop');
  await page.keyboard.press('Escape');
});

test('P21-05 desktop: Esc on the list reads with a toast and Undo; Jump to latest; the day pill', async () => {
  // real unread: leave the channel, the other person posts, the reader comes back and the "New" line is there
  await page.goto('/t/engineering/c/general');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  for (const t of ['Nadia says one', 'Nadia says two', 'Nadia says three']) {
    const r = await other.post(`/api/channels/${chanId}/messages`, { headers: otherCsrf, data: { channelId: chanId, body: t, threadRootId: null } });
    expect(r.status()).toBeLessThan(300);
    ids[t] = ((await r.json()) as any).id as string;
  }
  await page.waitForTimeout(2500);
  await page.getByRole('link', { name: new RegExp(chanName) }).first().click();
  await expect(page.getByText('Nadia says three')).toBeVisible(T);
  await page.waitForTimeout(800);
  await shoot('03b-new-line-desktop');
  // opening the channel already read it (the "New" line stays), so Undo has nothing to put back; use Mark unread from here on the other person's message
  await page.getByText('Nadia says one').click();
  const nrow = row('Nadia says one');
  await nrow.hover();
  await nrow.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Mark unread from here/ }).click();
  await page.waitForTimeout(1000);
  await shoot('03c-marked-unread-desktop');
  await page.getByText('Nadia says one').click();
  await page.keyboard.press('Escape');
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('marked as read', T);
  await shoot('04-toast-undo-desktop');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toHaveCount(0, T);
  await shoot('05-after-undo-desktop');
  const list = page.locator('.vlist');
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible(T);
  await shoot('06-day-pill-top-desktop');
  for (const t of ['Late one', 'Late two']) {
    const r = await other.post(`/api/channels/${chanId}/messages`, { headers: otherCsrf, data: { channelId: chanId, body: t, threadRootId: null } });
    expect(r.status()).toBeLessThan(300);
  }
  await expect(page.getByRole('button', { name: /2 new messages/ })).toBeVisible(T);
  await shoot('06b-jump-n-new-desktop');
  for (const w of [1024, 390]) {
    await page.setViewportSize({ width: w, height: 844 });
    await page.waitForTimeout(500);
    await page.locator('.vlist').focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await shoot(`06c-toast-${w}`);
    await page.waitForTimeout(1500);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await list.evaluate((el) => {
    el.scrollTop = 600;
  });
  await expect(page.locator('.day-float')).toBeVisible(T);
  await shoot('07-floating-day-and-jump-desktop');
});

test('phone 390x844: the + pill, toast and Jump to latest fit', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/t/engineering/c/${chanName}`);
  await expect(row('last')).toBeVisible(T);
  await shoot('08-phone-channel');
  await row('target').scrollIntoViewIfNeeded();
  await shoot('09-phone-reacted');
  await noSideways('phone channel');
  await page.locator('.vlist').evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: /Jump to latest/ })).toBeVisible(T);
  await shoot('10-phone-jump');
  expect(fivexx, fivexx.join('\n')).toEqual([]);
});
