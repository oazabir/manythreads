import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiAs, createChannel, openAs, postMessage, uniqueName, type Api } from './support.ts';

/**
 * Later and reminders (PLAN P14-04, docs/plugins/reminders.md). Rafi saves messages of a channel Nadia writes in: "Mark for later" from the More
 * menu, "Remind me" with a ready-made time and with a time of his own (a time in the past is refused in words), and finds them in the Later tab of
 * Threads; he opens one in place, marks one done, sees a due reminder first, and sees "no longer available" (never the text) for a deleted message.
 * Nadia, who saved nothing, sees none of it. The phone layout has its own test at the end (project mobile-web). The minute job that turns a due
 * reminder into a notification runs on its own clock: the last desktop test waits for it, and checks there is one notification, not two.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
const putLater = async (api: Api, messageId: string, body: unknown): Promise<{ status: number; item: Record<string, unknown> }> => {
  const res = await api.ctx.put(`/api/later/messages/${messageId}`, { data: body, headers: await api.headers() });
  return { status: res.status(), item: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const later = async (api: Api, state = 'open'): Promise<{ items: Array<{ id: string; messageId: string; due: boolean; message: { snippet: string } | null }>; dueCount: number }> =>
  (await api.get(`/api/later?state=${state}`)) as never;

let nadia: Api;
let rafi: Api;
let channel = { id: '', name: '' };
let tag = '';
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  nadia = await apiAs('nadia');
  rafi = await apiAs('rafi');
  const omar = await apiAs('omar');
  channel = await createChannel(omar, 'keep');
  await omar.ctx.dispose();
  tag = uniqueName('lt');
  for (const k of ['plain', 'hour', 'custom', 'open', 'done', 'due', 'gone']) ids[k] = (await postMessage(nadia, channel.id, `${tag} ${k} note about the rollout`)).id;
});
test.afterAll(async () => {
  await Promise.all([nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
});

const row = (page: Page, key: string): Locator => page.locator(`[data-message-id="${ids[key]}"]`).first();
async function more(page: Page, key: string, item: string): Promise<void> {
  const r = row(page, key);
  await r.scrollIntoViewIfNeeded();
  await r.hover();
  await r.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}
const localInput = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own test below');

  test('Mark for later, Remind me with a ready-made time and with a custom time; a past time is refused in words', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      await expect(row(page, 'plain')).toBeVisible(T);

      await more(page, 'plain', 'Mark for later');
      await expect(row(page, 'plain').getByRole('status')).toContainText('Saved for later', T);
      // the menu now offers to take it off the list again
      await row(page, 'plain').hover();
      await row(page, 'plain').getByRole('button', { name: 'More actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Remove from Later' })).toBeVisible();
      await page.keyboard.press('Escape');

      await more(page, 'hour', 'Remind me…');
      for (const label of ['In 20 minutes', 'In 1 hour', 'Tomorrow morning', 'Next week', 'Pick a date and time…']) await expect(page.getByRole('menuitem', { name: label })).toBeVisible();
      await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
      await expect(row(page, 'hour').getByRole('status')).toContainText('Reminder set for Today at', T);

      await more(page, 'custom', 'Remind me…');
      await page.getByRole('menuitem', { name: 'Pick a date and time…' }).click();
      const dialog = page.getByTestId('remind-dialog');
      await expect(dialog).toBeVisible();
      const field = dialog.getByLabel('Day and time (your time zone)');
      await field.fill(localInput(new Date(Date.now() - 24 * 3_600_000)));
      await dialog.getByTestId('remind-save').click();
      await expect(dialog.getByTestId('remind-error')).toContainText('That time has already passed');
      await field.fill(localInput(new Date(Date.now() + 3 * 24 * 3_600_000)));
      await dialog.getByTestId('remind-save').click();
      await expect(dialog).toHaveCount(0, T);
      await expect(row(page, 'custom').getByRole('status')).toContainText('Reminder set for', T);
    } finally {
      await context.close();
    }
    const saved = await later(rafi);
    const mine = saved.items.filter((i) => Object.values(ids).includes(i.messageId));
    expect(mine.map((i) => i.messageId).sort()).toEqual([ids['custom']!, ids['hour']!, ids['plain']!].sort());
  });

  test('the Later tab lists them with the snippet; one opens in place, one is marked done and moves to Done', async ({ browser }) => {
    for (const k of ['open', 'done']) expect((await putLater(rafi, ids[k]!, {})).status).toBe(201);
    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/threads');
    try {
      await page.getByTestId('tab-later').click();
      const rows = page.getByTestId('later-row').filter({ hasText: tag });
      await expect(rows).toHaveCount(5, T);
      await expect(rows.filter({ hasText: 'open note about the rollout' })).toContainText('Nadia');
      await expect(rows.filter({ hasText: 'open note about the rollout' })).toContainText(new RegExp(`#\\s*${channel.name}`));

      // mark one done
      await rows.filter({ hasText: 'done note' }).click();
      await expect(page.getByTestId('later-detail-text')).toContainText('done note about the rollout');
      await page.getByTestId('later-done').click();
      await expect(rows).toHaveCount(4, T);
      await page.getByTestId('later-view-done').click();
      await expect(page.getByTestId('later-row').filter({ hasText: 'done note' })).toHaveCount(1, T);
      await page.getByTestId('later-view-open').click();

      // open one in place: the channel opens with the message in view
      await rows.filter({ hasText: 'open note' }).click();
      await page.getByTestId('later-open').click();
      await expect(page).toHaveURL(new RegExp(`/c/${channel.name}`), T);
      await expect(row(page, 'open')).toBeVisible(T);
    } finally {
      await context.close();
    }
  });

  test('a due reminder is listed first with a count, and a deleted message says it is gone without showing its words', async ({ browser }) => {
    expect((await putLater(rafi, ids['due']!, { remindAt: new Date().toISOString() })).status).toBe(201);
    expect((await putLater(rafi, ids['gone']!, {})).status).toBe(201);
    const del = await nadia.ctx.delete(`/api/channels/${channel.id}/messages/${ids['gone']}`, { headers: await nadia.headers() });
    expect(del.status()).toBeLessThan(300);
    expect((await later(rafi)).dueCount).toBeGreaterThanOrEqual(1);

    const { page, context } = await openAs(browser, 'rafi', '/t/engineering/threads');
    try {
      await expect(page.getByTestId('later-due-count')).toBeVisible(T);
      await page.getByTestId('tab-later').click();
      await expect(page.getByTestId('later-due-heading')).toBeVisible(T);
      const first = page.getByTestId('later-row').first();
      await expect(first).toHaveAttribute('data-due', 'true');
      await expect(first).toContainText('due note');

      const gone = page.getByTestId('later-row').filter({ hasText: 'no longer available' });
      await expect(gone).toHaveCount(1, T);
      await expect(page.getByTestId('later-row').filter({ hasText: 'gone note' })).toHaveCount(0);
      await gone.click();
      await expect(page.getByTestId('later-gone')).toBeVisible();
      await expect(page.getByTestId('later-open')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('gone note about the rollout');
      await page.getByTestId('later-remove').click();
      await expect(gone).toHaveCount(0, T);
    } finally {
      await context.close();
    }
  });

  test('nobody else sees the list, an admin included', async () => {
    const omar = await apiAs('omar');
    try {
      for (const api of [nadia, omar]) expect((await later(api)).items.filter((i) => Object.values(ids).includes(i.messageId))).toEqual([]);
    } finally {
      await omar.ctx.dispose();
    }
  });

  test('a due reminder arrives once as a notification (the minute job runs it)', async () => {
    test.setTimeout(150_000);   // the job runs at the next full minute
    const unread = async (): Promise<number> => {
      const res = (await rafi.get('/api/notifications')) as { items: Array<{ kind: string; refId: string }> };
      return res.items.filter((n) => n.kind === 'reminder' && n.refId === ids['due']).length;
    };
    await expect.poll(unread, { timeout: 120_000, intervals: [3_000] }).toBe(1);
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone viewport only (project mobile-web)');
  test('the Later list and the remind choices fit a 390 px screen', async ({ browser }) => {
    const phoneMsg = (await postMessage(nadia, channel.id, `${tag} phone note`)).id;
    ids['phone'] = phoneMsg;
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`, { width: 390, height: 844 }, true);
    try {
      const r = row(page, 'phone');
      await expect(r).toBeVisible(T);
      await r.hover();
      await r.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Remind me…' }).click();
      const choice = page.getByRole('menuitem', { name: 'In 20 minutes' });
      await expect(choice).toBeVisible(T);
      const box = await choice.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      expect(box!.height).toBeGreaterThanOrEqual(32);
      await choice.click();
      await expect(r.getByRole('status')).toContainText('Reminder set for', T);

      await page.goto('/t/engineering/threads');
      await page.getByTestId('tab-later').click();
      const rows = page.getByTestId('later-row').filter({ hasText: 'phone note' });
      await expect(rows).toHaveCount(1, T);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await rows.click();
      await expect(page.getByTestId('later-detail')).toBeVisible(T);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
