import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P14-04 on the live site: a lead drives "Later" and reminders for real in #alerts: Mark for later and Remind me from the More menu (the ready-made
 * times, a custom time, a time in the past refused), the Later tab of Threads (a saved message, a due reminder at the top, the Done view), opening a
 * message from the list, and "This message is no longer available" after its deletion. Everything posted starts with "[verify P14-04]"; the run
 * removes its Later items and deletes its messages again (through the API, with the session's CSRF token) in the same run.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-04-*.png (default temp/screenshots). Never run by `pnpm e2e` (not a *.spec.ts).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P14-04]';

const msgs = (page: Page): Locator => page.getByTestId('channel-view').getByTestId('message');
const localInput = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

async function csrf(page: Page): Promise<Record<string, string>> {
  const token = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  return { 'x-csrf-token': token };
}

async function more(row: Locator, item: string): Promise<void> {
  const page = row.page();
  for (let i = 0; i < 4; i++) {
    await row.hover();
    await row.getByRole('button', { name: 'More actions' }).click();
    if (await page.getByRole('menuitem', { name: item }).isVisible({ timeout: 1_500 }).catch(() => false)) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
  throw new Error(`the More menu did not offer ${item}`);
}

/** Removes every Later item of this run (their message text starts with the tag) and deletes the run's messages in the open channel. */
async function sweep(page: Page, channelPath: string): Promise<void> {
  const headers = await csrf(page);
  const open = await page.request.get('/api/later?state=open');
  const done = await page.request.get('/api/later?state=done');
  for (const res of [open, done]) {
    const body = (await res.json().catch(() => ({ items: [] }))) as { items: Array<{ id: string; message: { snippet: string } | null }> };
    for (const it of body.items) {
      // only items whose text carries the tag; the run removes its deleted-message item itself (it has no text left to match)
      if (it.message?.snippet.includes(TAG)) await page.request.delete(`/api/later/items/${it.id}`, { headers });
    }
  }
  await page.goto(channelPath);
  await page.getByTestId('channel-view').waitFor({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  if (await jump.isVisible()) await jump.click();
  await page.waitForTimeout(1_000);
  const cid = await page.getByTestId('channel-view').getAttribute('data-channel-id');
  const ids = await msgs(page).filter({ hasText: TAG }).evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') ?? ''));
  for (const id of ids) console.log('delete', id.slice(-6), (await page.request.delete(`/api/channels/${cid}/messages/${id}`, { headers })).status());
}

test.describe.configure({ retries: 0 });
test.setTimeout(240_000);

test('Later and reminders, end to end', async ({ browser }) => {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: join(OUT, `p14-04-${name}.png`), animations: 'disabled' });
  };
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.goto('/t/engineering');
  await page.getByRole('link', { name: /alerts/ }).first().click();
  await expect(page.getByTestId('channel-view')).toBeVisible(T);
  const channelPath = new URL(page.url()).pathname;
  await sweep(page, channelPath);                                            // leftovers of an aborted run
  const composer = page.getByRole('textbox', { name: /^Message #/ });
  const send = async (text: string): Promise<Locator> => {
    await composer.click();
    await composer.fill(`${TAG} ${text}`);
    await page.keyboard.press('Enter');
    const found = msgs(page).filter({ hasText: `${TAG} ${text}` }).last();
    await expect(found).toBeVisible(T);
    await page.waitForTimeout(800);
    return page.getByTestId('channel-view').locator(`[data-message-id="${await found.getAttribute('data-message-id')}"]`);
  };
  try {
    const plain = await send('check the rollout plan');
    const timed = await send('look at the dashboards tomorrow');
    const custom = await send('write the incident summary');
    const soon = await send('answer this one now');
    const doomed = await send('this one will be deleted');
    for (const n of [1, 2, 3, 4, 5, 6]) await send(`spacer ${n}`);          // keeps the open menus clear of the list's edge

    // 1. Mark for later, and the choices of Remind me
    await more(plain, 'Mark for later');
    await page.getByRole('menuitem', { name: 'Mark for later' }).click();
    await expect(plain.getByRole('status')).toContainText('Saved for later', T);
    await more(timed, 'Remind me…');
    await page.getByRole('menuitem', { name: 'Remind me…' }).click();
    await expect(page.getByRole('menuitem', { name: 'In 20 minutes' })).toBeVisible();
    await shot('01-remind-choices');
    await page.getByRole('menuitem', { name: 'Tomorrow morning' }).click();
    await expect(timed.getByRole('status')).toContainText('Reminder set for Tomorrow at 09:00', T);

    // 2. a custom time: the past is refused in words, then a day ahead works
    await more(custom, 'Remind me…');
    await page.getByRole('menuitem', { name: 'Remind me…' }).click();
    await page.getByRole('menuitem', { name: 'Pick a date and time…' }).click();
    const dialog = page.getByTestId('remind-dialog');
    await expect(dialog).toBeVisible(T);
    await dialog.getByLabel('Day and time (your time zone)').fill(localInput(new Date(Date.now() - 24 * 3_600_000)));
    await dialog.getByTestId('remind-save').click();
    await expect(dialog.getByTestId('remind-error')).toContainText('already passed');
    await shot('02-custom-time-refused');
    await dialog.getByLabel('Day and time (your time zone)').fill(localInput(new Date(Date.now() + 2 * 24 * 3_600_000)));
    await dialog.getByTestId('remind-save').click();
    await expect(dialog).toHaveCount(0, T);

    // 3. a reminder that is due now, and one whose message is deleted afterwards (through the API, so nothing waits for the minute job)
    const headers = await csrf(page);
    const idOf = async (row: Locator): Promise<string> => (await row.getAttribute('data-message-id')) ?? '';
    const put = (id: string, data: unknown) => page.request.put(`/api/later/messages/${id}`, { data, headers });
    expect((await put(await idOf(soon), { remindAt: new Date().toISOString() })).status()).toBeLessThan(300);
    expect((await put(await idOf(doomed), {})).status()).toBeLessThan(300);
    const cid = await page.getByTestId('channel-view').getAttribute('data-channel-id');
    expect((await page.request.delete(`/api/channels/${cid}/messages/${await idOf(doomed)}`, { headers })).status()).toBeLessThan(300);

    // 4. the Later tab
    await page.goto('/t/engineering/threads');
    await page.getByTestId('tab-later').click();
    await expect(page.getByTestId('later-due-heading')).toBeVisible(T);
    await expect(page.getByTestId('later-row').first()).toContainText('answer this one now');
    await expect(page.getByTestId('later-row').filter({ hasText: 'no longer available' })).toHaveCount(1, T);
    await page.getByTestId('later-row').filter({ hasText: 'check the rollout plan' }).click();
    await expect(page.getByTestId('later-detail')).toBeVisible(T);
    await shot('03-later-tab');
    await page.getByTestId('later-row').filter({ hasText: 'no longer available' }).click();
    await expect(page.getByTestId('later-gone')).toBeVisible(T);
    await shot('04-no-longer-available');
    await page.getByTestId('later-remove').click();
    await expect(page.getByTestId('later-row').filter({ hasText: 'no longer available' })).toHaveCount(0, T);

    // 5. mark one done and look at the Done view
    await page.getByTestId('later-row').filter({ hasText: 'answer this one now' }).click();
    await page.getByTestId('later-done').click();
    await page.getByTestId('later-view-done').click();
    await expect(page.getByTestId('later-row').filter({ hasText: 'answer this one now' })).toHaveCount(1, T);
    await shot('05-done-view');
    await page.getByTestId('later-view-open').click();

    // 6. open a message from the list
    await page.getByTestId('later-row').filter({ hasText: 'check the rollout plan' }).click();
    await page.getByTestId('later-open').click();
    await expect(msgs(page).filter({ hasText: 'check the rollout plan' })).toBeVisible(T);
    await shot('06-opened-in-place');
  } finally {
    await sweep(page, channelPath).catch((e: unknown) => console.log('cleanup failed', e));
    const left = await page.request.get('/api/later?state=open');
    console.log('open Later items left:', ((await left.json()) as { items: unknown[] }).items.length, '; messages of the run left:', await msgs(page).filter({ hasText: TAG }).count());
    await page.screenshot({ path: join(OUT, 'p14-04-07-after-cleanup.png'), animations: 'disabled' }).catch(() => undefined);
  }
  await context.close();
});
