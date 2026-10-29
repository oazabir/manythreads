import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P14-12 on the live site: a lead drives the message actions for real in #alerts (edit history, "More" menu with Copy link / Forward… /
 * Mark unread from here, forward + quote card, "Also send to #channel" from a thread, a bookmarks bar, mark unread moving the New line).
 * Everything posted starts with "[verify P14-12]" and is deleted again in the same run (messages and the bookmark).
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-12-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P14-12]';

const msgs = (page: Page): Locator => page.getByTestId('channel-view').getByTestId('message');

async function more(row: Locator): Promise<void> {
  const page = row.page();
  for (let i = 0; i < 4; i++) {
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    if (await page.getByRole('menuitem', { name: 'Copy link' }).isVisible({ timeout: 1_500 }).catch(() => false)) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  throw new Error('the More menu did not open');
}

async function apiDelete(page: Page, id: string): Promise<void> {
  const cid = await page.getByTestId('channel-view').getAttribute('data-channel-id');
  const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const res = await page.request.delete(`/api/channels/${cid}/messages/${id}`, { headers: { 'x-csrf-token': csrf } });
  console.log('api delete', id.slice(-6), res.status());
}

/** Delete every message of this run that is in the open channel (through the API with the session's CSRF token), and the run's bookmark. */
async function sweep(page: Page, path: string): Promise<number> {
  await page.goto(path);
  await page.getByTestId('channel-view').waitFor({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  for (let i = 0; i < 5; i++) {
    const x = page.getByRole('button', { name: /Remove bookmark \[verify P14-12\]/ }).first();
    if (!(await x.isVisible())) break;
    await x.click();
    await page.waitForTimeout(1_000);
  }
  // the list holds a window of messages: go to the newest first so the last ones are in it
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  if (await jump.isVisible()) await jump.click();
  await page.waitForTimeout(1_000);
  const ids = await msgs(page).filter({ hasText: TAG }).evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') ?? ''));
  for (const id of ids) await apiDelete(page, id);
  // a deleted message that holds a thread stays as a line saying so: its replies of this run go too
  let gone = ids.length;
  const tombs = page.getByTestId('channel-view').getByTestId('message').filter({ hasText: 'This message was deleted.' });
  const count = await tombs.count();
  for (let i = 0; i < count; i++) {
    const t = tombs.nth(i);
    const open = t.getByRole('button', { name: /repl/ }).first();
    if (!(await open.isVisible().catch(() => false))) continue;
    await open.click();
    const thread = page.getByTestId('thread-view');
    await thread.waitFor({ timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1_000);
    const replyIds = await thread.getByTestId('message').filter({ hasText: TAG }).evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') ?? ''));
    for (const id of replyIds) await apiDelete(page, id);
    gone += replyIds.length;
    await page.keyboard.press('Escape');
  }
  return gone;
}

async function removeMessage(page: Page, found: Locator): Promise<void> {
  // pin the row by id first: a text filter stops matching once the message is deleted
  const id = await found.getAttribute('data-message-id', { timeout: 20_000 });
  const row = page.locator(`[data-message-id="${id}"]`).first();
  await more(row);
  try {
    await page.getByRole('menuitem', { name: 'Delete…' }).click({ timeout: 4_000 });
    await page.getByRole('menuitem', { name: 'Delete message' }).click({ timeout: 4_000 });
  } catch {
    // BUG (reported): the menu of a message at the bottom of the list is cut off by the list's edge, so Delete cannot be reached;
    // clean up through the API instead (same session cookie)
    await page.screenshot({ path: join(OUT, `p14-12-bug-menu-cut-off-${id?.slice(-6)}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await apiDelete(page, id ?? '');
    await page.reload();
  }
  // a deleted message with no thread leaves the list; one holding a thread stays as a line saying so
  await expect(row.filter({ hasText: TAG })).toHaveCount(0, T);
}

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

test('message actions, end to end', async ({ browser }) => {
  test.skip(process.env['P1412_ONLY'] !== undefined, 'only a part was asked for');
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(OUT, `p14-12-${name}.png`), animations: 'disabled' });
  };
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.goto('/t/engineering');
  await page.getByRole('link', { name: /alerts/ }).first().click();
  await expect(page.getByTestId('channel-view')).toBeVisible(T);
  const channelUrl = page.url();
  // cleanup is a sweep at the end (every message starting with the tag, through the API), so nothing is tracked one by one
  const made = { unshift: (...steps: Array<() => Promise<void>>): void => void steps.length };
  // leftovers of an earlier aborted run: this channel, the other #general channels
  for (const url of ['/t/delivery/c/general', '/t/engineering/c/general', new URL(channelUrl).pathname]) await sweep(page, url);
  const composer = page.getByRole('textbox', { name: /^Message #/ });
  const send = async (text: string): Promise<Locator> => {
    await composer.click();
    await composer.fill(`${TAG} ${text}`);
    await page.keyboard.press('Enter');
    const found = msgs(page).filter({ hasText: `${TAG} ${text}` }).last();
    await expect(found).toBeVisible(T);
    await page.waitForTimeout(800);
    const row = page.getByTestId('channel-view').locator(`[data-message-id="${await found.getAttribute('data-message-id')}"]`);
    made.unshift(() => removeMessage(page, row));
    return row;
  };
  try {
    // 1. two messages; the first one gets edited twice so the history has two entries
    const first = await send('first note, with a typo teh');
    await expect(first).toContainText(TAG);
    const second = await send('second note');
    await send('third note');
    // a few lines below, so that the open menu of the rows above is not cut off by the list's edge (see the bug note in removeMessage)
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) await send(`spacer ${n}`);
    for (const next of ['first note, typo fixed', 'first note, final wording']) {
      await more(first);
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.getByRole('textbox', { name: 'Edit message' }).fill(`${TAG} ${next}`);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0, T);
      await expect(first).toContainText(next, T);
    }

    // 2. the More menu
    await more(second);
    await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Forward…' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Mark unread from here' })).toBeVisible();
    await shot('01-more-menu');
    await page.getByRole('menuitem', { name: 'Copy link' }).click();
    await expect(second.getByRole('status')).toBeVisible(T);
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/open\?channel=[0-9a-f-]+&message=[0-9a-f-]+/);
    await page.screenshot({ path: join(OUT, 'p14-12-02-link-copied.png'), animations: 'disabled' });

    // 3. edit history
    await first.getByTestId('edited-mark').click();
    await expect(page.getByTestId('versions-popover')).toBeVisible(T);
    await expect(page.getByTestId('version')).toHaveCount(2, T);
    await shot('03-edit-history');
    await page.keyboard.press('Escape');
    if (await page.getByTestId('versions-popover').isVisible()) await page.getByTestId('versions-popover').getByRole('button', { name: 'Close' }).click();

    // 4. forward dialog and the quote card in the target
    await more(second);
    await page.getByRole('menuitem', { name: 'Forward…' }).click();
    await expect(page.getByTestId('forward-dialog')).toBeVisible(T);
    await page.getByPlaceholder('Find a channel or a person').fill('general');
    const place = page.getByTestId('forward-place').filter({ hasText: 'Engineering' }).first();
    await expect(place).toBeVisible(T);
    const placeLabel = ((await place.locator('span').first().textContent()) ?? '').trim();
    await place.click();
    await page.getByLabel('Add a note (optional)').fill(`${TAG} forwarded for the check`);
    await shot('04-forward-dialog');
    await page.getByTestId('forward-send').click();
    await expect(page.getByTestId('forward-dialog')).toHaveCount(0, T);
    await expect(second.getByRole('status')).toContainText('Forwarded to', T);
    await page.screenshot({ path: join(OUT, 'p14-12-05-forward-done.png'), animations: 'disabled' });

    // open the target channel and look at the card
    expect(placeLabel).toContain('general');
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('forward-card').last()).toBeVisible(T);
    const fwdRow = msgs(page).filter({ has: page.getByTestId('forward-card') }).last();
    await expect(fwdRow).toContainText(TAG);
    await expect(fwdRow.getByTestId('forward-card')).toContainText('second note');
    const targetPath = new URL(page.url()).pathname;
    made.unshift(async () => {
      await page.goto(targetPath);
      await expect(msgs(page).first()).toBeVisible(T);
      await page.waitForTimeout(1_500);
      const row = msgs(page).filter({ hasText: `${TAG} forwarded for the check` }).last();
      await removeMessage(page, row);
    });
    await shot('06-forward-card');

    // 5. mark unread moves the New line (back in #alerts). Your own messages never count as unread for you, so use two messages other people wrote.
    await page.goto(new URL(channelUrl).pathname);
    await expect(msgs(page).filter({ hasText: 'third note' })).toBeVisible(T);
    await page.waitForTimeout(1_500);
    const orderOf = async (): Promise<string[]> =>
      page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-testid="channel-view"] [data-testid="message"], [data-testid="unread-divider"]'));
        return nodes.map((n) => (n.getAttribute('data-testid') === 'unread-divider' ? 'NEW' : (n.textContent ?? '').replace(/\s+/g, ' ').slice(0, 70)));
      });
    const markFrom = async (needle: string, shotName: string): Promise<void> => {
      const row = msgs(page).filter({ hasText: needle }).first();
      await row.scrollIntoViewIfNeeded();
      await more(row);
      await page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
      await expect(page.getByTestId('unread-divider')).toBeVisible(T);
      await page.waitForTimeout(600);
      const order = await orderOf();
      const iNew = order.indexOf('NEW');
      expect(order[iNew + 1] ?? '', JSON.stringify(order)).toContain(needle);
      await shot(shotName);
    };
    await markFrom('db-conn-pool', '07-mark-unread-new-line');
    await markFrom('Normal at peak', '08-mark-unread-moved');

    // 6. thread: "Also send to #alerts"
    const root = msgs(page).filter({ hasText: `${TAG} third note` }).first();
    await root.hover();
    await root.getByRole('button', { name: 'Reply in thread' }).click();
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible(T);
    const also = page.getByTestId('also-to-channel');
    await expect(also).toBeVisible(T);
    await also.check();
    await expect(also).toBeChecked();
    const reply = thread.getByRole('textbox', { name: 'Reply in thread' });
    await reply.click();
    await reply.fill(`${TAG} thread reply, also sent to the channel`);
    await shot('09-thread-also-send');
    await page.keyboard.press('Enter');
    await expect(thread).toContainText('thread reply, also sent', T);
    const copy = msgs(page).filter({ hasText: 'thread reply, also sent' }).first();
    await expect(copy.getByTestId('also-from-thread')).toBeVisible(T);
    await expect(copy.getByTestId('also-from-thread')).toContainText('Also sent from a thread');
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    if (await jump.isVisible()) await jump.click();
    await page.waitForTimeout(800);
    await shot('10-also-sent-copy');
    made.unshift(async () => {
      await removeMessage(page, msgs(page).filter({ hasText: 'thread reply, also sent' }).first());
    });
    // the reply inside the thread
    made.unshift(async () => {
      const inThread = page.getByTestId('thread-view').getByTestId('message').filter({ hasText: 'thread reply, also sent' }).first();
      if (await inThread.isVisible()) await removeMessage(page, inThread);
    });

    // 7. bookmarks bar with one link
    await page.getByRole('button', { name: /close/i }).first().click().catch(() => undefined);
    await page.getByTestId('bookmark-add').click();
    await expect(page.getByTestId('bookmark-dialog')).toBeVisible(T);
    await page.getByLabel('Web address').fill('https://example.com/verify-p14-12');
    await page.getByLabel('Name (optional)').fill(`${TAG} runbook`);
    await shot('11-bookmark-dialog');
    await page.getByTestId('bookmark-save').click();
    await expect(page.getByTestId('bookmarks-bar')).toBeVisible(T);
    await expect(page.getByTestId('bookmark')).toContainText('runbook');
    made.unshift(async () => {
      const x = page.getByRole('button', { name: /Remove bookmark \[verify P14-12\]/ });
      if (await x.count()) {
        await x.first().click();
        await expect(page.getByTestId('bookmark').filter({ hasText: TAG })).toHaveCount(0, T);
      }
    });
    await shot('12-bookmarks-bar');
  } finally {
    // clean up: every message of this run in #alerts and in the two #general channels, and the bookmark
    for (const url of ['/t/engineering/c/general', '/t/delivery/c/general', new URL(channelUrl).pathname]) {
      const n = await sweep(page, url).catch(() => -1);
      console.log('cleanup', url, 'deleted', n);
    }
    console.log('left in the channel:', await msgs(page).filter({ hasText: TAG }).count(), '; bookmarks left:', await page.getByTestId('bookmark').count());
    await page.screenshot({ path: join(OUT, 'p14-12-13-after-cleanup.png'), animations: 'disabled' }).catch(() => undefined);
  }
  await context.close();
});

test('clean up what an aborted run left', async ({ browser }) => {
  test.skip(process.env['P1412_ONLY'] !== 'cleanup', 'only on request');
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  for (const url of ['/t/engineering/c/alerts', '/t/engineering/c/general', '/t/delivery/c/general']) console.log('cleanup', url, await sweep(page, url));
  await page.goto('/t/engineering/c/alerts');
  await page.waitForTimeout(2_000);
  console.log('left:', await msgs(page).filter({ hasText: TAG }).count());
  await context.close();
});

/**
 * The three layout fixes, with no spacer messages: the run's own message is the NEWEST one at the bottom of #alerts.
 * Pictures: p14-12-fix-*.png. Run with P1412_ONLY=bottom.
 */
test('layout fixes at the bottom of the list', async ({ browser }) => {
  test.skip(process.env['P1412_ONLY'] !== 'bottom', 'only on request');
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(OUT, `p14-12-fix-${name}.png`), animations: 'disabled' });
  };
  const path = '/t/engineering/c/alerts';
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
  console.log('leftovers swept before:', await sweep(page, path));
  try {
    await page.goto(path);
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    await page.waitForTimeout(2_000);
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    if (await jump.isVisible()) await jump.click();
    const composer = page.getByRole('textbox', { name: /^Message #/ });
    const post = async (text: string): Promise<Locator> => {
      await composer.click();
      await composer.fill(`${TAG} ${text}`);
      await page.keyboard.press('Enter');
      const found = msgs(page).filter({ hasText: `${TAG} ${text}` }).last();
      await expect(found).toBeVisible(T);
      await page.waitForTimeout(800);
      return page.locator(`[data-message-id="${await found.getAttribute('data-message-id')}"]`).first();
    };
    const edit = async (row: Locator, to: string): Promise<void> => {
      await more(row);
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.getByRole('textbox', { name: 'Edit message' }).fill(`${TAG} ${to}`);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('textbox', { name: 'Edit message' })).toHaveCount(0, T);
      await expect(row).toContainText(to, T);
    };
    /** Every item of the open menu is inside the window and is what is on top at its centre (not the composer). */
    const menuReport = async (): Promise<string> => {
      const menu = page.getByRole('menu', { name: /./ }).last();
      await expect(menu).toBeVisible();
      const r = await page.evaluate(() => {
        const vh = window.innerHeight;
        const menuEl = Array.from(document.querySelectorAll('[role="menu"]')).pop() as HTMLElement;
        const mb = menuEl.getBoundingClientRect();
        const items = Array.from(menuEl.querySelectorAll('[role="menuitem"]')).map((el) => {
          const b = el.getBoundingClientRect();
          const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
          return { name: (el.textContent ?? '').trim(), inside: b.top >= 0 && b.bottom <= vh, onTop: !!top && menuEl.contains(top) };
        });
        const comp = document.querySelector('[data-testid="composer"]')?.getBoundingClientRect();
        return { menu: { top: Math.round(mb.top), bottom: Math.round(mb.bottom) }, vh, composerTop: comp ? Math.round(comp.top) : null, up: menuEl.className, items };
      });
      console.log('menu', JSON.stringify(r));
      expect(r.items.map((i) => i.name)).toEqual(expect.arrayContaining(['Copy link', 'Forward…', 'Mark unread from here', 'Edit', 'Delete…']));
      for (const i of r.items) {
        expect(i.inside, `${i.name} inside the window`).toBe(true);
        expect(i.onTop, `${i.name} on top (clickable)`).toBe(true);
      }
      return JSON.stringify(r);
    };
    const popoverReport = async (label: string): Promise<void> => {
      const pop = page.getByTestId('versions-popover');
      await expect(pop).toBeVisible(T);
      // the earlier versions are fetched when it opens: wait for them, so the picture shows the real popover
      await expect(pop.getByTestId('version').first()).toBeVisible(T);
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="versions-popover"]') as HTMLElement;
        const b = el.getBoundingClientRect();
        const list = document.querySelector('[data-testid="channel-view"]')?.getBoundingClientRect();
        const pts = [[0.5, 0.1], [0.5, 0.5], [0.5, 0.9]].map(([fx, fy]) => {
          const t = document.elementFromPoint(b.x + b.width * (fx ?? 0), b.y + b.height * (fy ?? 0));
          return !!t && el.contains(t);
        });
        return { top: Math.round(b.top), bottom: Math.round(b.bottom), listTop: list ? Math.round(list.top) : null, listBottom: list ? Math.round(list.bottom) : null, vh: window.innerHeight, onTop: pts };
      });
      console.log('popover', label, JSON.stringify(r));
      expect(r.onTop, `${label}: popover on top of what is behind it`).toEqual([true, true, true]);
      expect(r.top).toBeGreaterThanOrEqual(r.listTop ?? 0);
      expect(r.bottom).toBeLessThanOrEqual(r.listBottom ?? r.vh);
    };

    // A) an older message of mine with one row below it, then the newest one at the bottom
    const a = await post('older note');
    await edit(a, 'older note, edited');
    const b = await post('newest note, last in the channel');
    await edit(b, 'newest note, edited once');
    // b is the last message row of the list
    const lastId = await msgs(page).last().getAttribute('data-message-id');
    expect(lastId).toBe(await b.getAttribute('data-message-id'));

    // FIX 1: the More menu of the newest message
    await more(b);
    await menuReport();
    await shot('1-more-menu-newest');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);

    // FIX 2: the edit history popover, of the newest one and of the older one (a row below it)
    await b.getByTestId('edited-mark').click();
    await popoverReport('newest');
    await shot('2-edit-history-newest');
    await page.keyboard.press('Escape');
    if (await page.getByTestId('versions-popover').isVisible()) await page.getByTestId('versions-popover').getByRole('button', { name: 'Close' }).click();
    await a.getByTestId('edited-mark').click();
    await popoverReport('older, row below');
    await shot('2b-edit-history-with-row-below');
    await page.keyboard.press('Escape');
    if (await page.getByTestId('versions-popover').isVisible()) await page.getByTestId('versions-popover').getByRole('button', { name: 'Close' }).click();

    // FIX 3: Mark unread from here twice on two messages other people wrote: only the second keeps the label
    const others = msgs(page).filter({ hasNotText: TAG });
    const n = await others.count();
    expect(n).toBeGreaterThan(1);
    const o1 = others.nth(n - 2);
    const o2 = others.nth(n - 1);
    const id1 = await o1.getAttribute('data-message-id');
    const id2 = await o2.getAttribute('data-message-id');
    const r1 = page.locator(`[data-message-id="${id1}"]`).first();
    const r2 = page.locator(`[data-message-id="${id2}"]`).first();
    await r1.scrollIntoViewIfNeeded();
    await more(r1);
    await page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(r1.getByRole('status')).toContainText('Marked unread from here', T);
    await shot('3a-marked-first');
    await r2.scrollIntoViewIfNeeded();
    await more(r2);
    await page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(r2.getByRole('status')).toContainText('Marked unread from here', T);
    await expect(r1.getByText('Marked unread from here')).toHaveCount(0, T);
    await expect(page.getByText('Marked unread from here')).toHaveCount(1, T);
    await shot('3b-marked-second-first-cleared');

    // Edit and Delete… from the bottom menu, for real
    if (await jump.isVisible()) await jump.click();
    await b.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await edit(b, 'newest note, edited via the bottom menu');
    await shot('4-edited-via-bottom-menu');
    await more(b);
    await page.getByRole('menuitem', { name: 'Delete…' }).click({ timeout: 4_000 });
    await shot('5-delete-confirm');
    await page.getByRole('menuitem', { name: 'Delete message' }).click({ timeout: 4_000 });
    await expect(page.locator(`[data-message-id="${lastId}"]`).filter({ hasText: TAG })).toHaveCount(0, T);
    console.log('Delete via the bottom menu worked');
  } finally {
    console.log('cleanup', path, 'deleted', await sweep(page, path).catch(() => -1));
    console.log('left in the channel:', await msgs(page).filter({ hasText: TAG }).count());
    await page.screenshot({ path: join(OUT, 'p14-12-fix-9-after-cleanup.png'), animations: 'disabled' }).catch(() => undefined);
  }
  await context.close();
});

test('the More menu and Forward on a phone', async ({ browser }) => {
  test.skip(process.env['P1412_ONLY'] === 'cleanup' || process.env['P1412_ONLY'] === 'bottom', 'only another part was asked for');
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  const channelUrl = 'https://manythreads.kahf.to/t/engineering/c/alerts';
  const phone = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  p.setDefaultTimeout(10_000);
  await p.goto('/sign-in');
  await p.getByLabel('Email').fill('omar@kahf.example');
  await p.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'Sign in' }).click();
  await expect(p).not.toHaveURL(/\/sign-in/);
  await p.goto(new URL(channelUrl).pathname);
  await expect(p.getByTestId('channel-view')).toBeVisible(T);
  const comp = p.getByRole('textbox', { name: /^Message #/ });
  await comp.click();
  await comp.fill(`${TAG} phone check`);
  await p.keyboard.press('Enter');
  const row = p.getByTestId('channel-view').getByTestId('message').filter({ hasText: `${TAG} phone check` }).last();
  await expect(row).toBeVisible(T);
  await p.waitForTimeout(2_000);
  try {
    await row.tap();
    await p.waitForTimeout(500);
    await p.screenshot({ path: join(OUT, 'p14-12-14a-phone-tapped-row.png'), animations: 'disabled' });
    await row.getByRole('button', { name: 'More actions' }).tap();
    await expect(p.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
    await p.waitForLoadState('networkidle');
    await p.screenshot({ path: join(OUT, 'p14-12-14-more-menu-390.png'), animations: 'disabled' });
    await p.getByRole('menuitem', { name: 'Forward…' }).click();
    await expect(p.getByTestId('forward-dialog')).toBeVisible(T);
    await p.screenshot({ path: join(OUT, 'p14-12-15-forward-390.png'), animations: 'disabled' });
    await p.keyboard.press('Escape');
    if (await p.getByTestId('forward-dialog').isVisible()) await p.getByRole('button', { name: 'Cancel' }).click();
  } catch (e) {
    await p.screenshot({ path: join(OUT, 'p14-12-14-phone-state.png'), animations: 'disabled' }).catch(() => undefined);
    throw e;
  } finally {
    await sweep(p, new URL(channelUrl).pathname).catch((e) => console.log('phone cleanup failed:', String(e).slice(0, 200)));
    await phone.close();
  }
});
