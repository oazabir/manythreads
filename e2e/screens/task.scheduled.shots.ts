import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Scheduled send (P14-05) on the live site, driven as real users in a real browser. Nadia (Engineering, #dev) opens the Send later menu, schedules a
 * test message about 2 minutes ahead with the custom time dialog, sees the "1 scheduled" strip with Edit and Cancel, edits its text, schedules a second
 * one and cancels it, tries a past time (refused in words), schedules a reply inside a thread (the channel strip tags it "In a thread"), and waits for
 * the minute job to post the first as Nadia. Refused path: she schedules a message in a scratch channel Omar makes for the purpose, Omar archives that
 * channel (an archived channel is read-only), the minute job refuses it and the text stays in the Not sent list with the reason. Everything left
 * scheduled is cancelled at the end. Credentials come from the environment only (`source ~/manythreads.passwords.env`).
 * Run: pnpm -C e2e exec playwright test -c screens/task.config.ts task.scheduled.shots.ts --retries=0 --workers=1
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/sc-*.png (default temp/screenshots), plus a rebuilt index.html gallery.
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T = { timeout: 20_000 };
const TEAM = 'engineering';
const CHANNEL = 'dev';
const RAND = Date.now().toString(36);
const MARK = `scheduled-send live check ${RAND}`;
const FIRST = `${MARK} (test, please ignore)`;
const EDITED = `${MARK} (test, please ignore) EDITED`;
const SECOND = `${MARK} second, to be cancelled`;
const REPLY = `${MARK} reply in a thread, to be cancelled`;
const REFUSED = `${MARK} in a channel that gets archived`;
const SCRATCH = `sched-check-${RAND}`;

type Who = { email: string; password: string };
type Key = 'NADIA' | 'OMAR';
const who = (key: Key): Who => ({ email: process.env[`${key}_EMAIL`] ?? '', password: process.env[`${key}_PASSWORD`] ?? '' });

test.beforeAll(() => {
  for (const k of ['NADIA', 'OMAR'] as const) {
    const w = who(k);
    if (!w.email || w.password.length < 8) throw new Error(`${k}_EMAIL / ${k}_PASSWORD are not set (source ~/manythreads.passwords.env)`);
  }
});
test.describe.configure({ mode: 'serial' });

const problems: string[] = [];
type Sess = { page: Page; context: BrowserContext };

async function signIn(browser: Browser, user: Who, viewport: { width: number; height: number }, mobile = false): Promise<Sess> {
  // No trace, no video: the password is typed into the form.
  const context = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, viewport, reducedMotion: 'reduce', ...(mobile ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text().slice(0, 200)} @ ${page.url()}`);
  });
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
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(OUT, { recursive: true });
  // times are masked in screenshots (they change every run); the text of the strip stays
  const style = await page.addStyleTag({ content: '[data-vt-mask]:not([data-testid="presence-dot"]) { visibility: hidden !important; }' });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
  await style.evaluate((el) => (el as unknown as Element).remove());
}
async function shootRaw(page: Page, name: string): Promise<void> {
  // same, with the times left visible (the strip's "Today at ..." is the thing being checked)
  await page.waitForLoadState('networkidle').catch(() => undefined);
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' });
}

const log = (s: string): void => console.log(`[sc] ${s}`);
const noSideways = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
const localInput = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const channelStrip = (page: Page): Locator => page.locator('[data-testid="scheduled-strip"]:not([data-testid="thread-view"] *)');
const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${CHANNEL}` });
async function csrf(context: BrowserContext): Promise<Record<string, string>> {
  const c = (await context.cookies()).find((x) => x.name === 'manythreads_csrf' || x.name === '__Host-manythreads_csrf');
  return c ? { 'x-csrf-token': c.value } : {};
}
type Sched = { id: string; channelId: string; body: string; state: string; refusedReason?: string | null; threadRootId?: string | null; sendAt: string };
async function mine(s: Sess): Promise<Sched[]> {
  const res = await s.page.request.get('/api/scheduled-messages');
  expect(res.status()).toBe(200);
  return ((await res.json()) as { items: Sched[] }).items;
}

let nadia: Sess | undefined;
let omar: Sess | undefined;
let scratch: { id: string } | undefined;
let devId = '';

test.afterAll(async () => {
  // belt and braces: nothing of this run stays scheduled
  try {
    if (nadia) {
      for (const m of (await mine(nadia)).filter((i) => i.body.includes(MARK))) {
        const res = await nadia.page.request.delete(`/api/channels/${m.channelId}/scheduled-messages/${m.id}`, { headers: await csrf(nadia.context) });
        log(`cleanup: DELETE scheduled ${m.state} "${m.body.slice(0, 40)}..." -> ${res.status()}`);
      }
      const left = (await mine(nadia)).filter((i) => i.body.includes(MARK));
      log(`cleanup: still scheduled with the mark: ${left.length}`);
    }
  } catch (e) {
    log(`cleanup failed: ${String(e).slice(0, 200)}`);
  }
  await nadia?.context.close().catch(() => undefined);
  await omar?.context.close().catch(() => undefined);
});

test('sc-01 Nadia opens the Send later menu in #dev and schedules a test message with the custom time dialog', async ({ browser }) => {
  nadia = await signIn(browser, who('NADIA'), DESKTOP);
  const { page } = nadia;
  await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const box = boxOf(page);
  await expect(box).toBeVisible(T);
  const dev = await page.request.get(`/api/teams/${TEAM}/channels`);
  const groups = ((await dev.json()) as { groups: Array<{ channels: Array<{ id: string; name: string }> }> }).groups;
  devId = groups.flatMap((g) => g.channels).find((c) => c.name === CHANNEL)?.id ?? '';
  expect(devId).not.toBe('');
  const before = (await mine(nadia)).filter((i) => i.channelId === devId);
  log(`Nadia has ${before.length} scheduled in #dev before the run`);
  const later = page.getByTestId('send-later');
  await expect(later).toBeDisabled();
  await box.fill(FIRST);
  await expect(later).toBeEnabled();
  await later.click();
  const menu = page.getByTestId('send-later-menu');
  await expect(menu).toBeVisible(T);
  const items = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  log(`menu: head="${(await menu.locator('.sch-menu-head').innerText()).trim()}" items=${JSON.stringify(items)}`);
  await shootRaw(page, 'sc-01-send-later-menu-desktop');
  await page.getByTestId('send-later-custom').click();
  const dialog = page.getByTestId('schedule-dialog');
  await expect(dialog).toBeVisible(T);
  await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() + 2 * 60_000)));
  await shootRaw(page, 'sc-02-custom-time-dialog-desktop');
  await page.getByTestId('schedule-save').click();
  await expect(dialog).toBeHidden(T);
  await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
  await expect(box).toHaveValue('');
  log('strip says "1 scheduled", the box is empty');
});

test('sc-02 the strip lists it with Edit and Cancel; Edit changes the text', async () => {
  const { page } = nadia!;
  await channelStrip(page).getByTestId('scheduled-toggle').click();
  const row = channelStrip(page).getByTestId('scheduled-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('scheduled-edit')).toBeVisible();
  await expect(row.getByTestId('scheduled-cancel')).toBeVisible();
  log(`strip row: "${(await row.innerText()).replace(/\s+/g, ' ').trim()}"`);
  await shootRaw(page, 'sc-03-strip-1-scheduled-desktop');
  await row.getByTestId('scheduled-edit').click();
  await expect(page.getByTestId('schedule-dialog')).toBeVisible(T);
  await page.getByTestId('schedule-body').fill(EDITED);
  await shootRaw(page, 'sc-04-edit-dialog-desktop');
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('schedule-dialog')).toBeHidden(T);
  await expect(row.filter({ hasText: 'EDITED' })).toHaveCount(1, T);
  const server = (await mine(nadia!)).find((i) => i.body === EDITED);
  expect(server?.state).toBe('scheduled');
  log(`edited on the server too, sendAt=${server?.sendAt}`);
  await shootRaw(page, 'sc-05-strip-after-edit-desktop');
});

test('sc-03 a second one is scheduled and cancelled; a past time is refused in words', async () => {
  const { page } = nadia!;
  const box = boxOf(page);
  const later = page.getByTestId('send-later');
  await box.fill(SECOND);
  await later.click();
  await page.getByTestId('send-later-in60').click();
  await expect(page.getByTestId('scheduled-count')).toHaveText('2 scheduled', T);
  await shootRaw(page, 'sc-06-strip-2-scheduled-desktop');
  const row2 = channelStrip(page).getByTestId('scheduled-row').filter({ hasText: 'second, to be cancelled' });
  await expect(row2).toHaveCount(1);
  await row2.getByTestId('scheduled-cancel').click();
  await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
  expect((await mine(nadia!)).some((i) => i.body === SECOND)).toBe(false);
  log('second one cancelled: strip back to 1 scheduled and gone from the server');

  // past time
  await box.fill(`${MARK} past time try`);
  await later.click();
  await page.getByTestId('send-later-custom').click();
  await expect(page.getByTestId('schedule-dialog')).toBeVisible(T);
  await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() - 3_600_000)));
  await page.getByTestId('schedule-save').click();
  const err = page.getByTestId('schedule-error');
  await expect(err).toBeVisible(T);
  log(`past-time error in words: "${(await err.innerText()).trim()}"`);
  await expect(page.getByTestId('schedule-dialog')).toBeVisible();
  await shootRaw(page, 'sc-07-past-time-refused-desktop');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('schedule-dialog')).toBeHidden(T);
  expect((await mine(nadia!)).some((i) => i.body.includes('past time try'))).toBe(false);
  await box.fill('');
});

test('sc-04 a reply scheduled inside a thread shows in the channel strip tagged "In a thread"', async () => {
  const { page } = nadia!;
  const msgs = page.locator('[data-testid="message"]');
  await expect(msgs.first()).toBeVisible(T);
  const root = msgs.last();
  await root.scrollIntoViewIfNeeded();
  const thread = page.getByTestId('thread-view');
  for (let attempt = 1; attempt <= 3 && !(await thread.isVisible()); attempt++) {
    await root.hover();
    await root.getByRole('button', { name: 'Reply in thread' }).click();
    await thread.waitFor({ state: 'visible', timeout: 6_000 }).catch(() => log(`thread did not open on attempt ${attempt}`));
  }
  await expect(thread).toBeVisible(T);
  const tbox = thread.getByRole('textbox', { name: /Reply/ });
  await tbox.fill(REPLY);
  const tlater = thread.getByTestId('send-later');
  await expect(tlater).toBeEnabled();
  await tlater.click();
  await shootRaw(page, 'sc-08-thread-send-later-menu-desktop');
  await thread.getByTestId('send-later-in60').click();
  await expect(thread.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
  await expect(page.getByTestId('scheduled-count').first()).toBeVisible();
  // the channel strip counts it (2 now: the first test message and this reply)
  await expect(channelStrip(page).getByTestId('scheduled-count')).toHaveText('2 scheduled', T);
  const cs = channelStrip(page);
  if ((await cs.getByTestId('scheduled-row').count()) === 0) await cs.getByTestId('scheduled-toggle').click();
  const tagged = cs.getByTestId('scheduled-row').filter({ hasText: 'reply in a thread' });
  await expect(tagged.getByTestId('scheduled-in-thread')).toHaveText('In a thread', T);
  const taggedOnTheFirst = await cs.getByTestId('scheduled-row').filter({ hasText: 'EDITED' }).getByTestId('scheduled-in-thread').count();
  expect(taggedOnTheFirst).toBe(0);
  log(`channel strip rows: ${JSON.stringify((await cs.getByTestId('scheduled-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()))}`);
  await shootRaw(page, 'sc-09-channel-strip-in-a-thread-desktop');
});

test('sc-05 refused path set up: Omar makes a scratch channel, Nadia schedules a message in it, Omar archives the channel', async ({ browser }) => {
  omar = await signIn(browser, who('OMAR'), DESKTOP);
  const res = await omar.page.request.post(`/api/teams/${TEAM}/channels`, { data: { name: SCRATCH }, headers: await csrf(omar.context) });
  expect(res.status(), await res.text()).toBeLessThan(300);
  scratch = ((await res.json()) as { channel: { id: string } }).channel;
  log(`scratch channel #${SCRATCH} created`);
  const { page } = nadia!;
  await page.goto(`/t/${TEAM}/c/${SCRATCH}`);
  const box = page.getByRole('textbox', { name: `Message #${SCRATCH}` });
  await expect(box).toBeVisible(T);
  await box.fill(REFUSED);
  await page.getByTestId('send-later').click();
  await page.getByTestId('send-later-custom').click();
  await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() + 2 * 60_000)));
  await page.getByTestId('schedule-save').click();
  await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
  const ar = await omar.page.request.post(`/api/channels/${scratch.id}/archive`, { headers: await csrf(omar.context) });
  log(`archive scratch channel -> ${ar.status()}`);
  expect(ar.status()).toBeLessThan(300);
  // the archived channel is read-only: a new post is refused at once, so the later one will be too
  const probe = await nadia!.page.request.post(`/api/channels/${scratch.id}/messages`, { data: { channelId: scratch.id, body: 'probe', threadRootId: null }, headers: await csrf(nadia!.context) });
  log(`Nadia posting in the archived channel now -> ${probe.status()}`);
  expect(probe.status()).toBe(409);
});

test('sc-06 the minute job posts the first message as Nadia in #dev, and the strip empties', async () => {
  test.setTimeout(330_000);
  const { page } = nadia!;
  await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
  const posted = page.locator('[data-testid="message"]').filter({ hasText: EDITED });
  await expect
    .poll(
      async () => {
        await page.reload();
        await page.locator('[data-testid="message"]').last().waitFor({ timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        return posted.count();
      },
      { timeout: 280_000, intervals: [10_000] },
    )
    .toBe(1);
  const author = (await posted.innerText()).replace(/\s+/g, ' ').trim();
  log(`message in #dev: "${author.slice(0, 160)}"`);
  expect(author).toMatch(/Nadia/);
  // the reply is still scheduled, so the strip shows 1 (it holds the reply only); the first one is gone from it
  await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
  await channelStrip(page).getByTestId('scheduled-toggle').click();
  await expect(channelStrip(page).getByTestId('scheduled-row').filter({ hasText: 'EDITED' })).toHaveCount(0);
  expect((await mine(nadia!)).some((i) => i.body === EDITED)).toBe(false);
  await posted.scrollIntoViewIfNeeded();
  await shootRaw(page, 'sc-10-posted-message-and-strip-desktop');
  // cancel the thread reply: the strip disappears altogether
  await channelStrip(page).getByTestId('scheduled-row').filter({ hasText: 'reply in a thread' }).getByTestId('scheduled-cancel').click();
  await expect(channelStrip(page)).toHaveCount(0, T);
  log('strip gone after the first posted and the reply cancelled');
  await shootRaw(page, 'sc-11-strip-gone-desktop');
});

test('sc-07 the archived-channel message is refused with a reason and stays in Not sent; Nadia dismisses it', async () => {
  test.setTimeout(330_000);
  const { page } = nadia!;
  await expect
    .poll(async () => (await mine(nadia!)).find((i) => i.body === REFUSED)?.state ?? 'none', { timeout: 250_000, intervals: [10_000] })
    .toBe('refused');
  const m = (await mine(nadia!)).find((i) => i.body === REFUSED)!;
  log(`refused row: reason="${m.refusedReason}"`);
  expect(m.refusedReason ?? '').not.toBe('');
  await page.goto(`/t/${TEAM}/threads?tab=later`);
  const list = page.getByTestId('not-sent-list');
  await expect(list).toBeVisible(T);
  log(`Not sent list: "${(await list.innerText()).replace(/\s+/g, ' ').trim()}"`);
  await expect(list).toContainText('Not sent.');
  await expect(list).toContainText(REFUSED);
  await shootRaw(page, 'sc-12-not-sent-list-desktop');
  await list.getByTestId('not-sent-dismiss').first().click();
  await expect(page.getByTestId('not-sent-row').filter({ hasText: REFUSED })).toHaveCount(0, T);
  expect((await mine(nadia!)).some((i) => i.body === REFUSED)).toBe(false);
});

test('sc-08 phone 390x844: the menu, the dialog, the strip and the sent message fit the screen', async ({ browser }) => {
  const { page, context } = await signIn(browser, who('NADIA'), PHONE, true);
  try {
    await page.goto(`/t/${TEAM}/c/${CHANNEL}`);
    const box = boxOf(page);
    await expect(box).toBeVisible(T);
    // the sent message first (it is the latest in #dev)
    const sent = page.locator('[data-testid="message"]').filter({ hasText: EDITED });
    await expect(sent).toHaveCount(1, T);
    await sent.scrollIntoViewIfNeeded();
    expect(await noSideways(page)).toBe(true);
    await shoot(page, 'sc-13-posted-message-phone-390');
    await box.fill(`${MARK} phone note, to be cancelled`);
    await page.getByTestId('send-later').click();
    const menu = page.getByTestId('send-later-menu');
    await expect(menu).toBeVisible(T);
    const mb = (await menu.boundingBox())!;
    log(`phone menu frame ${JSON.stringify(mb)}`);
    expect(mb.x).toBeGreaterThanOrEqual(0);
    expect(mb.x + mb.width).toBeLessThanOrEqual(PHONE.width);
    expect(mb.y).toBeGreaterThanOrEqual(0);
    for (const it of await menu.getByRole('menuitem').all()) {
      const b = (await it.boundingBox())!;
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
      expect(b.height).toBeGreaterThanOrEqual(32);
    }
    await shootRaw(page, 'sc-14-send-later-menu-phone-390');
    await page.getByTestId('send-later-custom').click();
    const dialog = page.getByTestId('schedule-dialog');
    await expect(dialog).toBeVisible(T);
    const db = (await dialog.boundingBox())!;
    log(`phone dialog frame ${JSON.stringify(db)}`);
    expect(db.x).toBeGreaterThanOrEqual(0);
    expect(db.x + db.width).toBeLessThanOrEqual(PHONE.width);
    expect(db.y + db.height).toBeLessThanOrEqual(PHONE.height);
    await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() + 3 * 3_600_000)));
    await shootRaw(page, 'sc-15-custom-time-dialog-phone-390');
    await page.getByTestId('schedule-save').click();
    await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
    await channelStrip(page).getByTestId('scheduled-toggle').click();
    for (const id of ['scheduled-edit', 'scheduled-cancel']) {
      const b = (await page.getByTestId(id).first().boundingBox())!;
      expect(b.height).toBeGreaterThanOrEqual(32);
      expect(b.x + b.width).toBeLessThanOrEqual(PHONE.width);
    }
    expect(await noSideways(page)).toBe(true);
    await shootRaw(page, 'sc-16-strip-phone-390');
    await channelStrip(page).getByTestId('scheduled-cancel').first().click();
    await expect(channelStrip(page)).toHaveCount(0, T);
  } finally {
    await context.close();
  }
});

test('sc-09 no page error, no console error over the run', () => {
  expect(problems.filter((p) => p.startsWith('pageerror')), 'uncaught page errors').toEqual([]);
  log(`console errors seen over the run: ${problems.length}${problems.length ? ' :: ' + [...new Set(problems)].slice(0, 6).join(' | ') : ''}`);
  // the 409 for the probe post in the archived channel is on purpose
  expect(problems.filter((p) => !/favicon|status of 409|status of 400/i.test(p)), 'console errors').toEqual([]);
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
  const figures = shots
    .map((s) => `<figure><a href="${s}"><img src="${s}" alt="${s}" loading="lazy"></a><figcaption>${s}</figcaption></figure>`)
    .join('');
  writeFileSync(
    join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>manythreads feature screenshots</title><style>
body { font-family: system-ui, sans-serif; margin: 24px; background: rgb(245, 245, 244); color: rgb(28, 28, 30); }
h1 { font-size: 18px; } p { font-size: 13px; color: rgb(90, 90, 92); }
figure { display: inline-block; vertical-align: top; margin: 8px; background: rgb(255, 255, 255); padding: 8px; border: 1px solid rgb(222, 222, 218); border-radius: 6px; }
img { max-width: 640px; display: block; }
figcaption { font-size: 12px; color: rgb(90, 90, 92); margin-top: 6px; }
</style></head><body><h1>manythreads feature screenshots</h1><p>${shots.length} screenshots under temp/screenshots.</p>${figures}</body></html>`,
  );
});
