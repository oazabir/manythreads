/* eslint-disable @typescript-eslint/no-explicit-any -- live probe */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, request, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of P21-06 (channel/DM header, details menu, members stack, intro card, conversation search) and P21-07 (bot replies as messages).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-p21-06-07 --retries=0 --timeout=60000
 * Signs in as Omar through the form and as Nadia through the API (credentials from the environment; never printed). Two probe channels are made and
 * archived at the end. No bot run is started; a bot reply is shot only if one already exists. Leave is never pressed.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/v2106';
const T = { timeout: 20_000 };
const log = (s: string): void => console.log(`[v] ${s}`);
const sfx = Date.now().toString(36);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
let ctx: BrowserContext;
let page: Page;
let other: APIRequestContext;
let otherCsrf: Record<string, string> = {};
const chans: Array<{ id: string; name: string }> = [];
let dmId = '';
const fivexx: string[] = [];

const csrf = async (): Promise<Record<string, string>> => {
  const c = (await ctx.cookies()).find((x) => x.name.endsWith('manythreads_csrf'));
  return c ? { 'x-csrf-token': c.value } : {};
};
const shoot = async (n: string): Promise<void> => {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `${n}.png`) });
  log(`shot ${n}`);
};
const mk = async (name: string): Promise<{ id: string; name: string }> => {
  const res = await page.request.post('/api/teams/engineering/channels', { headers: await csrf(), data: { name } });
  if (res.status() >= 300) log(`create ${name}: ${res.status()} ${(await res.text()).slice(0, 200)}`);
  expect(res.status(), `create ${name}`).toBeLessThan(300);
  const c = { id: ((await res.json()) as any).channel.id as string, name };
  chans.push(c);
  return c;
};
const sizes = [1440, 390] as const;
const vp = async (w: number): Promise<void> => {
  await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
  await page.waitForTimeout(300);
};
const header = async (label: string): Promise<void> => {
  const r = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad: string[] = [];
    document.querySelectorAll('[data-landmark="header"] button, [data-landmark="header"] a').forEach((e) => {
      const b = e.getBoundingClientRect();
      if (b.width && (b.right > w + 0.5 || b.left < -0.5)) bad.push(`${e.getAttribute('aria-label') ?? e.textContent?.slice(0, 20)} ${Math.round(b.left)}-${Math.round(b.right)}`);
    });
    const h = document.querySelector('[data-landmark="header"]');
    return { sw: document.documentElement.scrollWidth, w, bad, names: Array.from(h?.querySelectorAll('button,a') ?? []).map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim().slice(0, 30)) };
  });
  log(`${label} scrollW ${r.sw}/${r.w} offscreen=[${r.bad.join('; ')}] header controls=${JSON.stringify(r.names)}`);
};

test.beforeAll(async ({ browser }) => {
  ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page = await ctx.newPage();
  page.on('response', (r) => {
    if (r.status() >= 500) {
      fivexx.push(`${r.status()} ${r.request().method()} ${r.url()}`);
      log(`SERVER ${r.status()} ${r.url()}`);
    }
  });
  page.on('pageerror', (e) => log(`PAGEERROR ${e.message}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  other = await request.newContext({ baseURL: BASE });
  const res = await other.post('/api/auth/password/sign-in', { data: { email: process.env['NADIA_EMAIL'] ?? '', password: process.env['NADIA_PASSWORD'] ?? '' } });
  expect(res.ok(), 'sign in as Nadia').toBe(true);
  const c = (await other.storageState()).cookies.find((x) => x.name.endsWith('manythreads_csrf'));
  otherCsrf = c ? { 'x-csrf-token': c.value } : {};
});
test.afterAll(async () => {
  log(`5xx responses: ${fivexx.length}`);
  for (const c of chans) {
    const res = await page.request.post(`/api/channels/${c.id}/archive`, { headers: await csrf() }).catch(() => undefined);
    log(`archive ${c.name}: ${res?.status() ?? 'failed'}`);
  }
  await other?.dispose();
  await ctx?.close();
});

test('channel header, details menu, members popover, search, intro card at 1440 and 390', async () => {
  const c = await mk(`verify-p21-06-${sfx}`);
  const post = async (body: string): Promise<void> => {
    const r = await page.request.post(`/api/channels/${c.id}/messages`, { headers: await csrf(), data: { channelId: c.id, body, threadRootId: null } });
    expect(r.status()).toBeLessThan(300);
  };
  await post('probe needle first message');
  await post('another probe line');
  const j = await other.post(`/api/channels/${c.id}/join`, { headers: otherCsrf }).catch(() => undefined);
  log(`nadia join ${j?.status()}`);
  for (const w of sizes) {
    await vp(w);
    await page.goto(`/t/engineering/c/${c.name}`);
    await expect(page.getByTestId('channel-details-button')).toContainText(c.name, T);
    await shoot(`01-header-${w}`);
    await header(`header ${w}`);
    log(`star in header: ${await page.locator('[data-landmark="header"] [data-testid="channel-star"]').count()}`);
    // details menu
    await page.getByTestId('channel-details-button').click();
    const d = page.getByTestId('channel-details');
    await expect(d).toBeVisible(T);
    log(`menu items ${w}: ${JSON.stringify(await d.getByRole('menuitem').allInnerTexts())}`);
    await shoot(`02-details-menu-${w}`);
    await page.keyboard.press('Escape');
    // members popover
    const stack = page.getByTestId('members-stack');
    await expect(stack).toBeVisible(T);
    log(`members stack ${w}: name="${await stack.getAttribute('aria-label')}" count=${await stack.getAttribute('data-count')}`);
    await stack.click();
    await expect(page.getByRole('menu', { name: 'Members' })).toBeVisible(T);
    await shoot(`03-members-popover-${w}`);
    await page.keyboard.press('Escape');
    // search
    await page.getByRole('button', { name: 'Search this conversation' }).click();
    const box = page.getByRole('searchbox', { name: 'Search this conversation' });
    await expect(box).toBeFocused();
    await shoot(`04-search-box-${w}`);
    await box.fill('needle');
    await box.press('Enter');
    await expect(page.getByTestId('search-results')).toContainText('in this conversation', T);
    await shoot(`05-search-results-${w}`);
    log(`search hits ${w}: ${await page.getByTestId('search-hit').count()}`);
  }
});

test('intro card on a new empty channel', async () => {
  const c = await mk(`verify-p21-06-empty-${sfx}`);
  for (const w of sizes) {
    await vp(w);
    await page.goto(`/t/engineering/c/${c.name}`);
    const start = page.getByTestId('channel-start');
    await expect(start).toBeVisible(T);
    log(`intro ${w}: "${(await start.innerText()).replace(/\n+/g, ' | ')}" created="${await page.getByTestId('channel-created').innerText({ timeout: 2000 }).catch(() => 'none')}"`);
    await shoot(`06-intro-card-${w}`);
  }
});

test('long channel name at 390 and with the right panel open', async () => {
  const c = await mk(`verify-p21-06-a-very-long-channel-name-${sfx}`);
  const r = await page.request.post(`/api/channels/${c.id}/messages`, { headers: await csrf(), data: { channelId: c.id, body: 'root for a thread', threadRootId: null } });
  const root = ((await r.json()) as any).id as string;
  await page.request.post(`/api/channels/${c.id}/messages`, { headers: await csrf(), data: { channelId: c.id, body: 'a reply', threadRootId: root } });
  for (const w of sizes) {
    await vp(w);
    await page.goto(`/t/engineering/c/${c.name}`);
    await expect(page.getByTestId('channel-details-button')).toContainText('verify-p21-06-a-very', T);
    await shoot(`07-long-name-${w}`);
    await header(`long ${w}`);
    await page.goto(`/t/engineering/c/${c.name}?panel=thread:${root}`);
    await expect(page.locator('[data-panel-entry]')).toBeVisible(T);
    await shoot(`08-panel-open-${w}`);
    await header(`panel ${w}`);
    const fit = await page.getByTestId('channel-details-button').evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth + 1, w: el.clientWidth }));
    log(`title clipped ${w}: ${JSON.stringify(fit)}`);
  }
});

test('DM header with Nadia', async () => {
  const me = (await (await page.request.get('/api/session')).json()) as any;
  const omarId = me.person.id as string;
  const dm = await other.post('/api/dms', { data: { personIds: [omarId] }, headers: otherCsrf });
  expect(dm.status()).toBeLessThan(300);
  dmId = ((await dm.json()) as any).dm.channel.id;
  const m = await other.post(`/api/channels/${dmId}/messages`, { headers: otherCsrf, data: { channelId: dmId, body: 'verify p21-06 dm hello', threadRootId: null } });
  expect(m.status()).toBeLessThan(300);
  for (const w of sizes) {
    await vp(w);
    await page.goto(`/t/engineering/dm/${dmId}`);
    await expect(page.getByTestId('channel-details-button')).toContainText('Nadia', T);
    await page.waitForTimeout(1500);
    log(`dm ${w}: dot=${await page.getByTestId('channel-details-button').getByTestId('presence-dot').count()} status="${await page.getByTestId('dm-header-status').innerText({ timeout: 2000 }).catch(() => 'none')}" time="${await page.getByTestId('dm-header-time').innerText({ timeout: 2000 }).catch(() => 'none')}"`);
    await shoot(`09-dm-header-${w}`);
    await header(`dm ${w}`);
    await page.getByTestId('channel-details-button').click();
    log(`dm menu ${w}: ${JSON.stringify(await page.getByTestId('channel-details').getByRole('menuitem').allInnerTexts())}`);
    await shoot(`10-dm-details-${w}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Search this conversation' }).click();
    const box = page.getByRole('searchbox', { name: 'Search this conversation' });
    await box.fill('hello');
    await box.press('Enter');
    await expect(page.getByTestId('search-results')).toContainText('in this conversation', T);
    await shoot(`11-dm-search-${w}`);
  }
});

test('an existing bot reply, if one is visible', async () => {
  await vp(1440);
  await page.goto('/t/engineering/c/general');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const hrefs = await page.locator('[data-landmark="sidebar"] a[href*="/c/"], [data-landmark="sidebar"] a[href*="/dm/"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? ''));
  const list = Array.from(new Set(hrefs)).slice(0, 25);
  let found = '';
  for (const h of list) {
    await page.goto(h);
    await page.waitForTimeout(1500);
    if ((await page.locator('.who .wh-mark.bot').count()) > 0) {
      found = h;
      break;
    }
  }
  log(`bot reply search over ${list.length} conversations: ${found || 'NONE FOUND'}`);
  if (!found) return;
  for (const w of sizes) {
    await vp(w);
    await page.goto(found);
    await page.locator('.who .wh-mark.bot').first().scrollIntoViewIfNeeded();
    log(`bot ${w}: tag=${await page.locator('.wh-mark.bot').count()} badge=${await page.locator('.av-badge.bot').count()} answers=${await page.getByTestId('answer').count()} sourcesOpen=${await page.locator('[data-testid="answer-sources"][open]').count()}`);
    await shoot(`12-bot-reply-${w}`);
  }
  expect(fivexx, fivexx.join('\n')).toEqual([]);
});
