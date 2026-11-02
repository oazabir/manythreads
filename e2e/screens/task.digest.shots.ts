/* eslint-disable @typescript-eslint/no-explicit-any -- a live-site check reads loosely typed API answers */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Live check of the email digest (PLAN P14-09) on a deployed site, as real users in a real browser. It runs in stages (one per
 * run, chosen by DG_STAGE) because the real digest only arrives after the person has been away for the delay:
 *   ui      Omar: Account -> Notifications "Email me what I missed" (default, delay, keyboard, reload), shots at 1280 and 390 px;
 *           sets the delay to 30 minutes, finds a public channel he can read and writes the facts to DG_STATE.
 *   post    Nadia posts a channel message that @mentions Omar (and a DM to Omar) with a marker word; Omar stays signed out.
 *   unsub   Omar opens the unsubscribe link from the mail (DG_STATE holds it; never printed): GET page, then the button; Account shows off; turns it back on.
 *   clean   Nadia deletes her marker messages; Omar's digest is put back to on with 60 minutes.
 * Credentials come from the environment only (OMAR_*, NADIA_*). Run:
 *   DG_STAGE=ui pnpm exec playwright test -c screens/task.config.ts task.digest.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/dg-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const STATE = process.env['DG_STATE'] ?? join(import.meta.dirname, '..', '..', 'temp', 'dg-state.json');
const STAGE = process.env['DG_STAGE'] ?? 'ui';
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const log = (s: string): void => console.log(`[dg] ${s}`);

type Who = { email: string; password: string };
const who = (key: 'NADIA' | 'OMAR'): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });
type State = { marker?: string; channelId?: string; channelName?: string; omarId?: string; omarHandle?: string; postedIds?: Array<{ channelId: string; id: string }>; unsubscribeUrl?: string };
const readState = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {});
const writeState = (s: State): void => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify({ ...readState(), ...s }, null, 2)); };

test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set`);
  }
});
test.describe.configure({ mode: 'serial' });

async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, name: string, full = false): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage: full });
  log(`shot ${name}.png`);
}
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
const block = (page: Page) => page.getByTestId('notification-digest');
const sw = (page: Page) => block(page).getByRole('switch', { name: 'Send me an email about what I missed' });
const delay = (page: Page) => block(page).getByLabel('How long away before the email');
const noSideScroll = async (page: Page): Promise<void> => {
  const w = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  log(`scrollWidth ${w.sw} vs clientWidth ${w.cw}`);
  expect(w.sw).toBeLessThanOrEqual(w.cw);
};

test.describe('stage ui', () => {
  test.skip(STAGE !== 'ui', 'only in the ui stage');
  test('dg-01 Account -> Notifications: the digest block, default, delay, persistence, keyboard', async ({ browser }) => {
    const { page, context } = await signIn(browser, who('OMAR'), { width: 1280, height: 900 });
    await page.goto('/account');
    await expect(block(page)).toBeVisible(T);
    await expect(block(page).getByRole('heading', { name: 'Email me what I missed' })).toBeVisible();
    await expect(sw(page)).toBeVisible(T);
    const initial = { on: await sw(page).getAttribute('aria-checked'), delay: await delay(page).inputValue(), help: (await page.getByTestId('digest-help').innerText()).trim() };
    log(`INITIAL ${JSON.stringify(initial)}`);
    const options = await delay(page).locator('option').allInnerTexts();
    log(`DELAY OPTIONS ${JSON.stringify(options)}`);
    expect.soft(options.length).toBeGreaterThan(2);
    log(`live regions in block: ${await block(page).locator('[aria-live],[role=status],[role=alert]').count()}`);
    await block(page).scrollIntoViewIfNeeded();
    await shoot(page, 'dg-01-digest-block-1280-initial');

    // the delay: 30 minutes, then reload
    await delay(page).selectOption({ label: options.find((o) => /30/.test(o)) ?? options[0]! });
    await expect(delay(page)).toHaveValue('30', T);
    await expect(page.getByTestId('digest-help')).toContainText(/30 minutes/i, T);
    await page.reload();
    await expect(sw(page)).toBeVisible(T);
    await expect(delay(page)).toHaveValue('30', T);
    log(`after reload delay=${await delay(page).inputValue()} help="${(await page.getByTestId('digest-help').innerText()).trim()}"`);
    await block(page).scrollIntoViewIfNeeded();
    await shoot(page, 'dg-02-digest-block-1280-30min-after-reload');

    // keyboard: focus the switch, Space turns it off, Space turns it on
    await sw(page).focus();
    await expect(sw(page)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(sw(page)).toHaveAttribute('aria-checked', 'false', T);
    const offHelp = (await page.getByTestId('digest-help').innerText()).trim();
    log(`OFF help="${offHelp}" delay-select-disabled=${await delay(page).isDisabled()} switch-has-focus-after=${await sw(page).evaluate((e) => e === document.activeElement)}`);
    await block(page).scrollIntoViewIfNeeded();
    await shoot(page, 'dg-03-digest-block-1280-off');
    await page.reload();
    await expect(sw(page)).toHaveAttribute('aria-checked', 'false', T);
    await sw(page).focus();
    await page.keyboard.press('Enter');
    await expect(sw(page)).toHaveAttribute('aria-checked', 'true', T);
    log(`ON again help="${(await page.getByTestId('digest-help').innerText()).trim()}"`);
    const api = (await (await page.request.get('/api/notifications/digest')).json()) as any;
    log(`API ${JSON.stringify(api)}`);
    expect(api.enabled).toBe(true);
    expect(api.delayMinutes).toBe(30);

    // facts for the real-mail stage: Omar's id and a public channel he can read
    const me = (await (await page.request.get('/api/auth/me')).json().catch(() => ({}))) as any;
    log(`ME keys ${Object.keys(me).join(',')}`);
    const dir = (await (await page.request.get(`/api/teams/${TEAM}/channels`)).json()) as { groups: Array<{ channels: Array<{ id: string; name: string; private?: boolean; unread?: number }> }> };
    log(`CHANNELS ${JSON.stringify(dir.groups.flatMap((g) => g.channels.map((c) => ({ n: c.name, p: c.private }))))}`);
    writeState({});
    await context.close();
  });

  test('dg-02 phone width 390: no sideways scroll, the block is usable', async ({ browser }) => {
    const { page, context } = await signIn(browser, who('OMAR'), { width: 390, height: 844 }, true);
    await page.goto('/account');
    await expect(block(page)).toBeVisible(T);
    await block(page).scrollIntoViewIfNeeded();
    await noSideScroll(page);
    await shoot(page, 'dg-04-digest-block-390');
    await shoot(page, 'dg-05-account-full-390', true);
    const box = await sw(page).boundingBox();
    log(`switch box ${JSON.stringify(box)}`);
    await context.close();
  });
});

test.describe('stage post', () => {
  test.skip(STAGE !== 'post', 'only in the post stage');
  test('dg-10 Nadia mentions Omar in a public channel and DMs him', async ({ browser }) => {
    const marker = `dgmark${Date.now().toString(36)}`;
    const nadia = await signIn(browser, who('NADIA'), { width: 1280, height: 900 });
    const h = await csrf(nadia.context);
    const dir = (await (await nadia.page.request.get(`/api/teams/${TEAM}/channels`)).json()) as { groups: Array<{ channels: Array<{ id: string; name: string; private?: boolean }> }> };
    const ch = dir.groups.flatMap((g) => g.channels).find((c) => c.name === (process.env['DG_CHANNEL'] ?? 'dev')) ?? dir.groups.flatMap((g) => g.channels).find((c) => !c.private);
    expect(ch, 'a public channel').toBeTruthy();
    const people = (await (await nadia.page.request.get('/api/people?q=omar')).json().catch(() => ({}))) as any;
    log(`people answer keys ${Object.keys(people).join(',')}`);
    const posted: Array<{ channelId: string; id: string }> = [];
    const body = `${marker} @omar can you look at the release notes digest check`;
    const res = await nadia.page.request.post(`/api/channels/${ch!.id}/messages`, { data: { channelId: ch!.id, body, threadRootId: null }, headers: h });
    log(`channel post ${res.status()}`);
    expect(res.status()).toBeLessThan(300);
    const m = (await res.json()) as any;
    posted.push({ channelId: ch!.id, id: m.message?.id ?? m.id });
    writeState({ marker, channelId: ch!.id, channelName: ch!.name, postedIds: posted });
    log(`posted in #${ch!.name} marker ${marker}`);
    await nadia.context.close();
  });
});

test.describe('stage dm', () => {
  test.skip(STAGE !== 'dm', 'only in the dm stage');
  test('dg-11 Nadia sends Omar a direct message with the same marker', async ({ browser }) => {
    const st = readState();
    const nadia = await signIn(browser, who('NADIA'), { width: 1280, height: 900 });
    const h = await csrf(nadia.context);
    const omarId = process.env['DG_OMAR_ID'] ?? '';
    const dm = await nadia.page.request.post('/api/dms', { data: { personIds: [omarId] }, headers: h });
    log(`dm open ${dm.status()}`);
    expect(dm.status()).toBeLessThan(300);
    const dmId = ((await dm.json()) as any).dm.channel.id as string;
    const res = await nadia.page.request.post(`/api/channels/${dmId}/messages`, { data: { channelId: dmId, body: `${st.marker} direct note for Omar about the digest check`, threadRootId: null }, headers: h });
    log(`dm post ${res.status()}`);
    expect(res.status()).toBeLessThan(300);
    const m = (await res.json()) as any;
    writeState({ postedIds: [...(st.postedIds ?? []), { channelId: dmId, id: m.message?.id ?? m.id }] });
    await nadia.context.close();
  });
});

test.describe('stage unsub', () => {
  test.skip(STAGE !== 'unsub', 'only in the unsub stage');
  test('dg-20 the unsubscribe link: GET asks, the button turns the digest off, Account agrees, turn it back on', async ({ browser }) => {
    const url = readState().unsubscribeUrl;
    if (!url) throw new Error('DG_STATE has no unsubscribeUrl');
    const link = url.replace(/^https?:\/\/[^/]+/, BASE);
    const { page, context } = await signIn(browser, who('OMAR'), { width: 1280, height: 900 });
    const before = (await (await page.request.get('/api/notifications/digest')).json()) as any;
    log(`before: enabled=${before.enabled} delay=${before.delayMinutes}`);
    expect(before.enabled).toBe(true);
    await context.close();

    // a fresh browser with no session at all (the way a mail program opens it)
    const anon = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const p = await anon.newPage();
    const resp = await p.goto(link);
    log(`GET status ${resp?.status()} title="${await p.title()}"`);
    await expect(p.getByText('Stop these emails?')).toBeVisible(T);
    log(`GET page text: ${(await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await shoot(p, 'dg-20-unsubscribe-confirm-page');
    // GET changed nothing
    const mid = await anon.request.get(link);
    log(`second GET status ${mid.status()}`);
    const o1 = await signIn(browser, who('OMAR'), { width: 1280, height: 900 });
    const chk1 = (await (await o1.page.request.get('/api/notifications/digest')).json()) as any;
    log(`after GET: enabled=${chk1.enabled}`);
    expect(chk1.enabled, 'GET must not unsubscribe').toBe(true);
    await o1.context.close();

    await p.getByRole('button').first().click();
    await expect(p.getByText(/You will no longer get these emails/)).toBeVisible(T);
    log(`POST page text: ${(await p.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300)}`);
    await shoot(p, 'dg-21-unsubscribed-page');
    await anon.close();

    const o2 = await signIn(browser, who('OMAR'), { width: 1280, height: 900 });
    await o2.page.goto('/account');
    await expect(block(o2.page)).toBeVisible(T);
    await expect(sw(o2.page)).toHaveAttribute('aria-checked', 'false', T);
    log(`Account help: "${(await o2.page.getByTestId('digest-help').innerText()).trim()}"`);
    await block(o2.page).scrollIntoViewIfNeeded();
    await shoot(o2.page, 'dg-22-account-digest-off-after-link');
    await sw(o2.page).click();
    await expect(sw(o2.page)).toHaveAttribute('aria-checked', 'true', T);
    await shoot(o2.page, 'dg-23-account-digest-on-again');
    const after = (await (await o2.page.request.get('/api/notifications/digest')).json()) as any;
    log(`after turn-on: enabled=${after.enabled} delay=${after.delayMinutes}`);
    await o2.context.close();
  });
});

test.describe('stage clean', () => {
  test.skip(STAGE !== 'clean', 'only in the clean stage');
  test('dg-30 delete the marker messages as their author and put Omar back to on with 60 minutes', async ({ browser }) => {
    const st = readState();
    const nadia = await signIn(browser, who('NADIA'), { width: 1280, height: 900 });
    for (const m of st.postedIds ?? []) {
      const res = await nadia.page.request.delete(`/api/channels/${m.channelId}/messages/${m.id}`, { headers: await csrf(nadia.context) });
      log(`delete ${m.id.slice(0, 8)} -> ${res.status()}`);
    }
    await nadia.context.close();
    const omar = await signIn(browser, who('OMAR'), { width: 1280, height: 900 });
    await omar.page.goto('/account');
    await expect(block(omar.page)).toBeVisible(T);
    if ((await sw(omar.page).getAttribute('aria-checked')) !== 'true') await sw(omar.page).click();
    await expect(sw(omar.page)).toHaveAttribute('aria-checked', 'true', T);
    await delay(omar.page).selectOption('60');
    await expect(delay(omar.page)).toHaveValue('60', T);
    await omar.page.reload();
    await expect(delay(omar.page)).toHaveValue('60', T);
    const api = (await (await omar.page.request.get('/api/notifications/digest')).json()) as any;
    log(`final: enabled=${api.enabled} delay=${api.delayMinutes}`);
    await omar.context.close();
  });
});
