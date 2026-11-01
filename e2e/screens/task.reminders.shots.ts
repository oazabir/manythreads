/* eslint-disable @typescript-eslint/no-explicit-any -- a live-site check reads loosely typed API answers */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Live check of /remind and the built-in slash commands (P14-04, P14-06) plus regressions of the previous deploy, as real users in real browsers.
 * Nadia (maker) and Rafi (a second browser) work in a scratch channel Omar makes (and archives at the end). Credentials come from the environment only.
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.reminders.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/rv-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const RAND = Date.now().toString(36);
const MARK = `rvcheck${RAND}`;
const ROOM = `rv-${RAND}`;

type Who = { email: string; password: string };
type Key = 'NADIA' | 'RAFI' | 'OMAR';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });
test.beforeAll(() => {
  for (const k of ['NADIA', 'RAFI', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
type Sess = { page: Page; context: BrowserContext };
async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)} @ ${page.url()}`));
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, T);
  return { page, context };
}
async function shoot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  log(`shot ${name}.png`);
}
const log = (s: string): void => console.log(`[rv] ${s}`);
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${ROOM}` });
const rowOf = (page: Page, text: string): Locator => page.getByTestId('message').filter({ hasText: text });
const notice = (page: Page): Locator => page.getByTestId('slash-notice');

let nadia: Sess | undefined;
let rafi: Sess | undefined;
let omar: Sess | undefined;
let roomId = '';

/** types a command and presses Enter (a second Enter if the first only picked the menu entry) */
async function run(page: Page, text: string, opts: { second?: boolean } = {}): Promise<string> {
  const input = boxOf(page);
  await input.click();
  await input.fill(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  if (opts.second && (await input.inputValue()) !== '') { log(`"${text}" needed a second Enter (first only picked the menu row)`); await page.keyboard.press('Enter'); await page.waitForTimeout(700); }
  const n = notice(page);
  const said = (await n.count()) ? (await n.first().innerText()).replace(/\s+/g, ' ').trim() : '(no notice)';
  log(`"${text}" -> notice: ${said} | box now: ${JSON.stringify(await input.inputValue())}`);
  return said;
}
async function apiJson(s: Sess, path: string): Promise<any> {
  const r = await s.page.request.get(path);
  return r.json();
}

test.afterAll(async () => {
  try {
    if (nadia) {
      for (const state of ['pending']) {
        const l = (await apiJson(nadia, `/api/reminders?state=${state}`)) as { items: Array<{ id: string; text: string }> };
        for (const r of l.items.filter((i) => i.text.includes(MARK))) {
          const res = await nadia.page.request.delete(`/api/reminders/${r.id}`, { headers: await csrf(nadia.context) });
          log(`cleanup: cancel pending reminder "${r.text.slice(0, 40)}" -> ${res.status()}`);
        }
      }
      if (roomId) {
        const list = await nadia.page.request.get(`/api/channels/${roomId}/messages?limit=100`);
        const items = ((await list.json()) as { items: Array<{ id: string; body: string }> }).items;
        for (const m of items.filter((i) => i.body.includes(MARK))) {
          const res = await nadia.page.request.delete(`/api/channels/${roomId}/messages/${m.id}`, { headers: await csrf(nadia.context) });
          log(`cleanup: delete message "${m.body.slice(0, 40)}" -> ${res.status()}`);
        }
      }
      // put the status, do-not-disturb back
      await nadia.page.request.put('/api/presence/dnd', { data: { off: true }, headers: await csrf(nadia.context) }).catch(() => undefined);
    }
    if (omar && roomId) {
      const ar = await omar.page.request.post(`/api/channels/${roomId}/archive`, { headers: await csrf(omar.context) });
      log(`cleanup: archive #${ROOM} -> ${ar.status()}`);
    }
  } catch (e) { log(`cleanup failed: ${String(e).slice(0, 200)}`); }
  for (const s of [nadia, rafi, omar]) await s?.context.close().catch(() => undefined);
});

test('rv-01 sign in; Omar makes a scratch channel; the slash menu lists the commands with usage lines', async ({ browser }) => {
  nadia = await signIn(browser, who('NADIA'), DESKTOP);
  rafi = await signIn(browser, who('RAFI'), DESKTOP);
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  const res = await omar.page.request.post(`/api/teams/${TEAM}/channels`, { data: { name: ROOM }, headers: await csrf(omar.context) });
  expect(res.status(), await res.text()).toBeLessThan(300);
  roomId = ((await res.json()) as { channel: { id: string } }).channel.id;
  log(`scratch channel #${ROOM} ${roomId}`);
  for (const s of [nadia, rafi, omar]) { await s.page.goto(`/t/${TEAM}/c/${ROOM}`); await expect(boxOf(s.page)).toBeVisible(T); }

  const { page } = nadia;
  await boxOf(page).click();
  await boxOf(page).fill('/');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible(T);
  const rows = menu.locator('li');
  const texts = (await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  log(`MENU (${texts.length} rows):\n  ${texts.join('\n  ')}`);
  for (const c of ['remind', 'status', 'dnd', 'away', 'poll', 'invite', 'leave', 'mute', 'topic', 'shrug', 'help']) {
    const hit = texts.find((t) => t.startsWith(`/${c}`));
    log(`menu has /${c}: ${hit ? 'yes -> ' + hit : 'NO'}`);
    expect.soft(hit, `menu row for /${c}`).toBeTruthy();
  }
  await shoot(page, 'rv-01-slash-menu-desktop');
  await page.keyboard.press('Escape');
  await boxOf(page).fill('');
});

const TAG = { me: `${MARK} check the oven`, rafi: `${MARK} for rafi call Sam`, chan: `${MARK} for the room stand up`, cancel: `${MARK} cancelme later` };

test('rv-02 /remind me, /remind @rafi, /remind #channel and one to cancel; list shows pending; Cancel works', async () => {
  test.skip(!!process.env['RV_ONLY_REGRESS'], 'skipped in the regression-only run');
  const { page } = nadia!;
  const input = boxOf(page);
  const s1 = await run(page, `/remind me in 1 minute ${TAG.me}`);
  expect.soft(s1).toContain('Reminder set');
  await shoot(page, 'rv-02-remind-me-confirmation-desktop');
  const s2 = await run(page, `/remind @rafi in 1 minute ${TAG.rafi}`);
  expect.soft(s2).toContain('Reminder set');
  const s3 = await run(page, `/remind #${ROOM} in 1 minute ${TAG.chan}`);
  expect.soft(s3).toContain('Reminder set');
  const s4 = await run(page, `/remind me in 20 minutes ${TAG.cancel}`);
  expect.soft(s4).toContain('Reminder set');
  // nothing was posted in the channel by the commands
  expect(await rowOf(page, MARK).count()).toBe(0);

  await input.fill('/remind list');
  await page.keyboard.press('Enter');
  const dlg = page.getByTestId('reminders-dialog');
  await expect(dlg).toBeVisible(T);
  const rows = dlg.getByTestId('reminder-row').filter({ hasText: MARK });
  await expect(rows).toHaveCount(4, T);
  log(`PENDING rows:\n  ${(await rows.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join('\n  ')}`);
  await shoot(page, 'rv-03-reminders-dialog-pending-desktop');
  // cancel one
  const target = dlg.getByTestId('reminder-row').filter({ hasText: 'cancelme' });
  await target.getByTestId('reminder-cancel').click();
  await expect(dlg.getByTestId('reminder-row').filter({ hasText: 'cancelme' })).toHaveCount(0, T);
  await expect(dlg.getByTestId('reminder-done').filter({ hasText: 'cancelme' })).toContainText('Cancelled', T);
  await expect(dlg.getByTestId('reminder-row').filter({ hasText: MARK })).toHaveCount(3);
  log('cancel: row left pending list, shows as Cancelled in finished list; 3 left pending');
  await shoot(page, 'rv-04-reminders-dialog-after-cancel-desktop');
  const l = await apiJson(nadia!, '/api/reminders?state=pending');
  expect(l.items.filter((i: any) => i.text.includes('cancelme'))).toHaveLength(0);
  await page.keyboard.press('Escape');
});

test('rv-03 refusals: nonsense time, unknown /foo (not posted), //foo posts as text', async () => {
  test.skip(!!process.env['RV_ONLY_REGRESS'], 'skipped in the regression-only run');
  const { page } = nadia!;
  const input = boxOf(page);
  const a = await run(page, '/remind me in banana x');
  expect(a.length).toBeGreaterThan(15);
  expect(await input.inputValue()).toBe('/remind me in banana x');
  await shoot(page, 'rv-05-nonsense-time-refused-desktop');
  const before = await rowOf(page, '/foo').count();
  const b = await run(page, `/foo ${MARK} bar`);
  expect(b).toMatch(/no command called \/foo/i);
  expect(await input.inputValue()).toBe(`/foo ${MARK} bar`);
  expect(await rowOf(page, `/foo ${MARK}`).count()).toBe(before);
  const posted = ((await apiJson(nadia!, `/api/channels/${roomId}/messages?limit=50`)) as { items: Array<{ body: string }> }).items;
  expect(posted.filter((m) => m.body.includes(`/foo ${MARK}`))).toHaveLength(0);
  log('unknown /foo: not posted (API confirms no message), text stays in box');
  await shoot(page, 'rv-06-unknown-command-refused-desktop');
  await input.fill(`//foo ${MARK}`);
  await page.keyboard.press('Enter');
  await expect(rowOf(page, `/foo ${MARK}`).first()).toBeVisible(T);
  const posted2 = ((await apiJson(nadia!, `/api/channels/${roomId}/messages?limit=50`)) as { items: Array<{ body: string }> }).items;
  log(`//foo posted as: ${JSON.stringify(posted2.filter((m) => m.body.includes(`foo ${MARK}`)).map((m) => m.body))}`);
  expect(posted2.some((m) => m.body === `/foo ${MARK}`)).toBe(true);
});

test('rv-04 status, dnd, away, shrug (Nadia) and mute, topic (Omar)', async () => {
  test.skip(!!process.env['RV_ONLY_REGRESS'], 'skipped in the regression-only run');
  const { page } = nadia!;
  await run(page, '/status :coffee: on a break');
  await shoot(page, 'rv-07-status-desktop');
  const me = await apiJson(nadia!, '/api/presence/me').catch(() => null);
  log(`presence/me after /status: ${JSON.stringify(me)?.slice(0, 300)}`);
  await run(page, '/status clear');
  await run(page, '/dnd 30m');
  await shoot(page, 'rv-08-dnd-desktop');
  await run(page, '/dnd off');
  await run(page, '/away', { second: true });
  await shoot(page, 'rv-09-away-desktop');
  await run(page, '/away', { second: true });
  await boxOf(page).fill(`${MARK} shrug test`);
  await boxOf(page).fill('');
  await boxOf(page).click();
  await boxOf(page).fill(`/shrug ${MARK} shrug test`);
  await page.keyboard.press('Enter');
  const sr = rowOf(page, `${MARK} shrug test`).first();
  await expect(sr).toBeVisible(T);
  log(`/shrug message shows: ${JSON.stringify((await sr.innerText()).replace(/\s+/g, ' ').slice(0, 160))}`);
  const api = ((await apiJson(nadia!, `/api/channels/${roomId}/messages?limit=50`)) as { items: Array<{ body: string }> }).items.find((m) => m.body.includes('shrug test'));
  log(`/shrug stored body: ${JSON.stringify(api?.body)}`);
  await shoot(page, 'rv-10-shrug-desktop');
  // Nadia is not a lead: /topic
  await run(page, `/topic nadia try ${MARK}`);

  const o = omar!.page;
  await run(o, '/mute');
  await shoot(o, 'rv-11-mute-omar-desktop');
  await run(o, '/mute off');
  await run(o, `/topic new topic ${MARK}`);
  const ch = await apiJson(omar!, `/api/channels/${roomId}`);
  log(`channel purpose after /topic: ${JSON.stringify(ch?.channel?.purpose ?? ch?.purpose)}`);
  await shoot(o, 'rv-12-topic-omar-desktop');
  await run(o, '/topic clear');
});

test('rv-05 delivery: wait for the minute job; Nadia Reminders DM + bell; Rafi sees maker-named reminder; channel post', async () => {
  test.skip(!!process.env['RV_ONLY_REGRESS'], 'skipped in the regression-only run');
  const n = nadia!;
  const t0 = Date.now();
  let hist: any[] = [];
  while (Date.now() - t0 < 200_000) {
    hist = ((await apiJson(n, '/api/reminders?state=history')) as { items: any[] }).items.filter((i) => i.text.includes(MARK));
    if (hist.filter((h) => h.state === 'sent').length >= 3) break;
    await n.page.waitForTimeout(5_000);
  }
  log(`waited ${Math.round((Date.now() - t0) / 1000)} s after creating; history: ${JSON.stringify(hist.map((h) => [h.state, h.text.slice(MARK.length + 1, MARK.length + 15), h.refusedReason]))}`);
  expect(hist.filter((h) => h.state === 'sent')).toHaveLength(3);

  // Nadia: Reminders DM
  const dms = (await apiJson(n, '/api/dms?limit=200')) as { items: any[] };
  const rem = dms.items.find((d) => d.channel?.dmKey?.startsWith('reminders:'));
  expect(rem, 'Nadia has a Reminders conversation').toBeTruthy();
  const msgs = ((await apiJson(n, `/api/channels/${rem.channel.id}/messages?limit=50`)) as { items: any[] }).items.filter((m) => m.body.includes(MARK));
  log(`Nadia Reminders DM messages: ${JSON.stringify(msgs.map((m) => [m.author?.displayName, m.author?.kind, m.body]))}`);
  expect(msgs.some((m) => m.body.includes(TAG.me))).toBe(true);
  expect(msgs.some((m) => m.body.includes(TAG.rafi))).toBe(false); // the maker is not told about the delivery to Rafi
  const nn = (await apiJson(n, '/api/notifications?limit=30')) as { items: any[] };
  const mineN = nn.items.filter((i) => JSON.stringify(i).includes(MARK));
  log(`Nadia notifications with the marker: ${JSON.stringify(mineN.map((i) => [i.kind, i.preview, i.readAt]))}`);
  expect(mineN.some((i) => JSON.stringify(i).includes(TAG.rafi))).toBe(false);
  expect(mineN.some((i) => i.kind === 'reminder' && JSON.stringify(i).includes('oven'))).toBe(true);

  await n.page.goto(`/t/${TEAM}/dm/${rem.channel.id}`);
  await expect(n.page.getByTestId('message').filter({ hasText: TAG.me }).first()).toBeVisible(T);
  await shoot(n.page, 'rv-13-nadia-reminders-dm-desktop');
  await n.page.getByTestId('bell').click();
  await expect(n.page.getByTestId('notifications-popover')).toBeVisible(T);
  await shoot(n.page, 'rv-14-nadia-bell-reminder-desktop');
  await n.page.keyboard.press('Escape');
  await n.page.goto(`/t/${TEAM}/c/${ROOM}`);
  await expect(boxOf(n.page)).toBeVisible(T);
  await n.page.getByTestId('message').filter({ hasText: TAG.chan }).first().waitFor(T);
  const chm = ((await apiJson(n, `/api/channels/${roomId}/messages?limit=50`)) as { items: any[] }).items.find((m) => m.body.includes(TAG.chan));
  log(`channel post: author=${chm?.author?.displayName}(${chm?.author?.kind}) body=${JSON.stringify(chm?.body)}`);
  await shoot(n.page, 'rv-15-channel-reminder-post-desktop');
  // history in the dialog
  await run(n.page, '/remind list');
  const dlg = n.page.getByTestId('reminders-dialog');
  await expect(dlg).toBeVisible(T);
  log(`HISTORY rows:\n  ${(await dlg.getByTestId('reminder-done').filter({ hasText: MARK }).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join('\n  ')}`);
  await shoot(n.page, 'rv-16-reminders-history-sent-desktop');
  await n.page.keyboard.press('Escape');

  // Rafi
  const r = rafi!;
  const rd = (await apiJson(r, '/api/dms?limit=200')) as { items: any[] };
  const rrem = rd.items.find((d) => d.channel?.dmKey?.startsWith('reminders:'));
  expect(rrem, 'Rafi has a Reminders conversation').toBeTruthy();
  const rm = ((await apiJson(r, `/api/channels/${rrem.channel.id}/messages?limit=50`)) as { items: any[] }).items.filter((m) => m.body.includes(MARK));
  log(`Rafi Reminders DM messages: ${JSON.stringify(rm.map((m) => [m.author?.displayName, m.body]))}`);
  expect(rm.some((m) => m.body.includes(TAG.rafi) && /Nadia/.test(m.body))).toBe(true);
  const rn = (await apiJson(r, '/api/notifications?limit=30')) as { items: any[] };
  log(`Rafi notifications with the marker: ${JSON.stringify(rn.items.filter((i) => JSON.stringify(i).includes(MARK)).map((i) => [i.kind, i.preview, i.readAt]))}`);
  expect(rn.items.some((i) => i.kind === 'reminder' && JSON.stringify(i).includes(MARK))).toBe(true);
  await r.page.goto(`/t/${TEAM}/dm/${rrem.channel.id}`);
  await expect(r.page.getByTestId('message').filter({ hasText: TAG.rafi }).first()).toBeVisible(T);
  await shoot(r.page, 'rv-17-rafi-reminders-dm-desktop');
  await r.page.getByTestId('bell').click();
  await expect(r.page.getByTestId('notifications-popover')).toBeVisible(T);
  await shoot(r.page, 'rv-18-rafi-bell-reminder-desktop');
  await r.page.keyboard.press('Escape');
});

test('rv-06 regressions: Bold on first click, poll double-click, private-IP link has no blank preview slot', async () => {
  const { page } = nadia!;
  await page.goto(`/t/${TEAM}/c/${ROOM}`);
  const input = boxOf(page);
  await expect(input).toBeVisible(T);
  // the menu again, after the page has had time to load the channel facts
  await page.waitForTimeout(4000);
  await input.click();
  await input.fill('/');
  await expect(page.getByTestId('slash-menu')).toBeVisible(T);
  await page.waitForTimeout(3000); // the channel facts are asked for only once a slash is typed
  const mt = (await page.getByTestId('slash-menu').locator('li').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  log(`MENU after 4 s: ${mt.filter((t) => /^\/(invite|leave|topic|mute)/.test(t)).join(' || ')}`);
  await shoot(page, 'rv-24-slash-menu-after-load-desktop');
  await input.fill('');
  // Omar fresh page: /mute
  await omar!.page.goto(`/t/${TEAM}/c/${ROOM}`);
  await expect(boxOf(omar!.page)).toBeVisible(T);
  await omar!.page.waitForTimeout(4000);
  await boxOf(omar!.page).click();
  await boxOf(omar!.page).fill('/mute');
  await omar!.page.waitForTimeout(3000);
  await omar!.page.keyboard.press('Enter');
  await omar!.page.waitForTimeout(700);
  log(`Omar /mute after 3 s with the slash typed -> ${(await notice(omar!.page).first().innerText()).replace(/\s+/g, ' ')}`);
  await shoot(omar!.page, 'rv-25-mute-omar-after-wait-desktop');
  await run(omar!.page, '/mute off');
  // type text, leave, come back: focus with one click and press Bold right away with the mouse (no waiting for the layout to settle)
  await input.fill('word');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await input.click();
  const bold = page.getByRole('button', { name: 'Bold' });
  await bold.waitFor({ state: 'visible', timeout: 5000 });
  const bb = (await bold.boundingBox())!;
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForTimeout(400);
  const v1 = await input.inputValue();
  log(`Bold, one mouse click right after focusing: textarea ${JSON.stringify(v1)}`);
  await shoot(page, 'rv-19-bold-first-click-desktop');
  expect(v1.includes('**')).toBe(true);
  // second scenario: empty box, focus, one click
  await input.fill('');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  await input.click();
  const bb2 = (await bold.boundingBox())!;
  await page.mouse.click(bb2.x + bb2.width / 2, bb2.y + bb2.height / 2);
  await page.waitForTimeout(400);
  const v2 = await input.inputValue();
  log(`Bold on an empty box, one click: ${JSON.stringify(v2)}`);
  expect(v2).toBe('**bold**');
  await input.fill('');

  // poll
  const q = `${MARK} Which snack?`;
  await run(page, `/poll "${q}" "Apple" "Banana"`);
  const card = page.getByTestId('poll').filter({ hasText: q });
  await expect(card).toBeVisible(T);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(500);
  const apple = card.getByTestId('poll-choice').nth(0);
  const banana = card.getByTestId('poll-choice').nth(1);
  const state = async (): Promise<string> => `apple=${await apple.getAttribute('aria-pressed')} banana=${await banana.getAttribute('aria-pressed')} voters=${(await card.getByTestId('poll-voters').innerText()).trim()} alerts=${await card.locator('[role=alert]').count()}`;
  // quick click Apple then Banana
  const ab = (await apple.boundingBox())!, bbx = (await banana.boundingBox())!;
  await page.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2);
  await page.mouse.click(bbx.x + bbx.width / 2, bbx.y + bbx.height / 2);
  await page.waitForTimeout(2000);
  const s1 = await state();
  log(`poll after quick Apple, Banana: ${s1}`);
  expect(s1).toContain('apple=false banana=true');
  // double-click on Apple (two quick clicks)
  const ab2 = (await apple.boundingBox())!;
  await page.mouse.dblclick(ab2.x + ab2.width / 2, ab2.y + ab2.height / 2);
  await page.waitForTimeout(2000);
  const s2 = await state();
  log(`poll after double-click Apple: ${s2}`);
  await shoot(page, 'rv-20-poll-after-double-click-desktop');
  await page.reload();
  const card2 = page.getByTestId('poll').filter({ hasText: q });
  await expect(card2).toBeVisible(T);
  const s3 = `apple=${await card2.getByTestId('poll-choice').nth(0).getAttribute('aria-pressed')} banana=${await card2.getByTestId('poll-choice').nth(1).getAttribute('aria-pressed')} voters=${(await card2.getByTestId('poll-voters').innerText()).trim()}`;
  log(`poll after reload (server truth): ${s3}`);
  expect(s3.replace(/ alerts=\d+/, '')).toBe(s2.replace(/ alerts=\d+/, ''));
  expect(s2).toContain('alerts=0');

  // links
  const post = async (text: string): Promise<void> => {
    const r = await page.request.post(`/api/channels/${roomId}/messages`, { data: { channelId: roomId, body: text, threadRootId: null }, headers: await csrf(nadia!.context) });
    expect(r.status()).toBeLessThan(300);
  };
  await post(`${MARK} PRIV http://10.0.0.1/x`);
  await post(`${MARK} PUB https://example.com/`);
  await post(`${MARK} AFTER plain message below`);
  const priv = rowOf(page, 'PRIV http');
  await expect(priv).toBeVisible(T);
  const seen: string[] = [];
  const after = rowOf(page, 'AFTER');
  let y0 = -1;
  for (let i = 0; i < 40; i++) {
    const slots = await priv.getByTestId('link-preview-slot').count();
    const cards = await priv.getByTestId('link-preview').count();
    const y = Math.round((await after.boundingBox())?.y ?? -1);
    if (i === 0) y0 = y;
    seen.push(`${slots}/${cards}/${y}`);
    await page.waitForTimeout(1000);
  }
  log(`PRIV slot/cards/y-of-message-below over 40 s: ${[...new Set(seen)].join(' , ')} (first y ${y0})`);
  expect(await priv.getByTestId('link-preview-slot').count()).toBe(0);
  expect(await priv.getByTestId('link-preview').count()).toBe(0);
  const pub = rowOf(page, 'PUB https');
  log(`PUB https link: cards=${await pub.getByTestId('link-preview').count()} slots=${await pub.getByTestId('link-preview-slot').count()}`);
  await pub.scrollIntoViewIfNeeded();
  await shoot(page, 'rv-21-links-private-vs-public-desktop');
});

test('rv-07 phone 390 px: command menu and Reminders dialog', async ({ browser }) => {
  const p = await signIn(browser, who('NADIA'), PHONE, true);
  try {
    const { page } = p;
    await page.goto(`/t/${TEAM}/c/${ROOM}`);
    const input = boxOf(page);
    await expect(input).toBeVisible(T);
    await input.click();
    await input.fill('/');
    const menu = page.getByTestId('slash-menu');
    await expect(menu).toBeVisible(T);
    const heights = await menu.locator('li').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    const mb = (await menu.boundingBox())!;
    log(`phone menu: ${heights.length} rows, min row height ${Math.min(...heights)} px, box x=${Math.round(mb.x)} w=${Math.round(mb.width)}, sideways-free=${await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)}`);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(44);
    expect(mb.x + mb.width).toBeLessThanOrEqual(390.5);
    await shoot(page, 'rv-22-slash-menu-phone');
    await input.fill('');
    await run(page, `/remind me in 30 minutes ${MARK} phone one`);
    await input.fill('/remind list');
    await page.keyboard.press('Enter');
    const dlg = page.getByTestId('reminders-dialog');
    await expect(dlg).toBeVisible(T);
    const cancel = dlg.getByTestId('reminder-row').filter({ hasText: 'phone one' }).getByTestId('reminder-cancel');
    await expect(cancel).toBeVisible(T);
    const b = (await cancel.boundingBox())!;
    const db = (await dlg.boundingBox())!;
    log(`phone dialog: x=${Math.round(db.x)} w=${Math.round(db.width)}; cancel x=${Math.round(b.x)} w=${Math.round(b.width)} h=${Math.round(b.height)}; sideways-free=${await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)}`);
    expect(b.x + b.width).toBeLessThanOrEqual(390.5);
    expect(db.x + db.width).toBeLessThanOrEqual(390.5);
    await shoot(page, 'rv-23-reminders-dialog-phone');
    await cancel.click();
    await expect(dlg.getByTestId('reminder-row').filter({ hasText: 'phone one' })).toHaveCount(0, T);
  } finally {
    await p.context.close();
  }
});

test('rv-08 console and page errors over the run', () => {
  log(`console/page errors seen: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 8).join(' | ') : ''}`);
  expect(problems.filter((x) => x.startsWith('pageerror'))).toEqual([]);
});

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
  const figures = shots.map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`).join('');
  writeFileSync(join(OUT, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots.</p>${figures}</body></html>`);
});
