import { expect, test } from '@playwright/test';
import { apiAs, createChannel, openAs, postMessage, uniqueName, type Api } from './support.ts';

/**
 * Scheduled send (PLAN P14-05, docs/plugins/channels.md): the "Send later" button beside Send and the "N scheduled" strip. Rafi writes a message and
 * schedules it with a ready-made time (the button and its menu work with the keyboard alone, Escape closes the menu and gives the focus back) and with
 * a time of his own (a past time is refused in words); the strip counts it, lets him edit its text and cancel it; a reply scheduled into a thread shows
 * in the channel's strip too, marked "In a thread". Nothing is posted by the end (the minute job is tested against the database in
 * packages/plugins/channels/test/scheduled-send.test.ts). The phone layout has its own test at the end (project mobile-web).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
let rafi: Api;
let channel = { id: '', name: '' };
let tag = '';

test.beforeAll(async () => {
  rafi = await apiAs('rafi');
  const omar = await apiAs('omar');
  channel = await createChannel(omar, 'sched');
  await omar.ctx.dispose();
  tag = uniqueName('sd');
});
test.afterAll(async () => {
  // leave no scheduled message behind
  const left = (await rafi.get('/api/scheduled-messages')) as { items: Array<{ id: string; channelId: string }> };
  for (const m of left.items.filter((i) => i.channelId === channel.id)) {
    await rafi.ctx.delete(`/api/channels/${m.channelId}/scheduled-messages/${m.id}`, { headers: await rafi.headers() });
  }
  await rafi?.ctx.dispose();
});

const localInput = (d: Date): string => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own test below');

  test('Send later: the keyboard opens the menu, Escape closes it; a ready-made time and a custom time schedule; the strip edits and cancels', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      const box = page.getByRole('textbox', { name: /^Message/ });
      const later = page.getByTestId('send-later');
      await expect(box).toBeVisible(T);
      // nothing to schedule in an empty box
      await expect(later).toBeDisabled();
      await box.fill(`${tag} first note`);
      await expect(later).toBeEnabled();

      // keyboard only: Enter opens the menu on its first choice, the arrows move, Escape closes it and the focus is back on the button
      await later.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByTestId('send-later-menu');
      await expect(menu).toBeVisible(T);
      await expect(page.getByTestId('send-later-in20')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('send-later-in60')).toBeFocused();
      await page.keyboard.press('End');
      await expect(page.getByTestId('send-later-custom')).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(later).toBeFocused();
      expect(await later.getAttribute('aria-expanded')).toBe('false');

      // a ready-made time: the box is emptied and the strip says one is scheduled
      await later.click();
      await page.getByTestId('send-later-in60').click();
      await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
      await expect(box).toHaveValue('');
      await expect(page.getByText('Scheduled for', { exact: false }).first()).toBeVisible(T);

      // a time of his own: a past time is refused in words and keeps the dialog open
      await box.fill(`${tag} second note`);
      await later.click();
      await page.getByTestId('send-later-custom').click();
      const dialog = page.getByTestId('schedule-dialog');
      await expect(dialog).toBeVisible(T);
      await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() - 3_600_000)));
      await page.getByTestId('schedule-save').click();
      await expect(page.getByTestId('schedule-error')).toBeVisible(T);
      await expect(dialog).toBeVisible();
      await page.getByTestId('schedule-at').fill(localInput(new Date(Date.now() + 3 * 3_600_000)));
      await page.getByTestId('schedule-save').click();
      await expect(dialog).toBeHidden(T);
      await expect(page.getByTestId('scheduled-count')).toHaveText('2 scheduled', T);

      // the strip: open it, edit the text of the first, cancel the second
      await page.getByTestId('scheduled-toggle').click();
      const rows = page.getByTestId('scheduled-row');
      await expect(rows).toHaveCount(2);
      await rows.first().getByTestId('scheduled-edit').click();
      await page.getByTestId('schedule-body').fill(`${tag} first note, edited`);
      await page.getByTestId('schedule-save').click();
      await expect(rows.filter({ hasText: 'first note, edited' })).toHaveCount(1, T);
      await rows.filter({ hasText: 'second note' }).getByTestId('scheduled-cancel').click();
      await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
      await rows.first().getByTestId('scheduled-cancel').click();
      await expect(page.getByTestId('scheduled-strip')).toHaveCount(0, T);
      // nothing was posted
      await expect(page.getByText(`${tag} first note`)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('a reply scheduled into a thread is listed in the channel\'s strip, marked "In a thread"', async ({ browser }) => {
    const root = await postMessage(rafi, channel.id, `${tag} thread root`);
    await rafi.post(`/api/channels/${channel.id}/scheduled-messages`, { body: `${tag} later reply`, sendAt: new Date(Date.now() + 2 * 3_600_000).toISOString(), threadRootId: root.id });
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      await expect(page.getByTestId('scheduled-count')).toHaveText('1 scheduled', T);
      await page.getByTestId('scheduled-toggle').click();
      await expect(page.getByTestId('scheduled-in-thread')).toBeVisible(T);
    } finally {
      await context.close();
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone viewport only (project mobile-web)');
  test('the Send later menu and the strip fit a 390 px screen', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`, { width: 390, height: 844 }, true);
    try {
      await page.getByRole('textbox', { name: /^Message/ }).fill(`${tag} phone note`);
      const later = page.getByTestId('send-later');
      await later.click();
      const choice = page.getByTestId('send-later-in20');
      await expect(choice).toBeVisible(T);
      const at = await choice.boundingBox();
      expect(at!.x).toBeGreaterThanOrEqual(0);
      expect(at!.x + at!.width).toBeLessThanOrEqual(390);
      expect(at!.height).toBeGreaterThanOrEqual(32);
      await choice.click();
      await expect(page.getByTestId('scheduled-count')).toBeVisible(T);
      await page.getByTestId('scheduled-toggle').click();
      for (const id of ['scheduled-edit', 'scheduled-cancel']) {
        const b = await page.getByTestId(id).first().boundingBox();
        expect(b!.height).toBeGreaterThanOrEqual(32);
        expect(b!.x + b!.width).toBeLessThanOrEqual(390);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
