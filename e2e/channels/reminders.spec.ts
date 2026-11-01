import { expect, test } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, uniqueName, type Api } from './support.ts';

/**
 * `/remind` (PLAN P14-04, docs/plugins/reminders.md). Rafi types `/remind me tomorrow at 9 …` in a channel: the box empties, one plain sentence says
 * the reminder is set, nothing is posted in the channel, and `/remind list` opens his reminders with a Cancel button for each. A time that cannot be read,
 * a missing "what", and a mistyped command are each answered with a sentence and keep the text in the box. A reminder for a person names them
 * (`/remind @omar …`) and is listed as theirs. Delivery (the notification, the message from "Reminders", the rights check at the moment it fires) needs a
 * minute job to run, so it is tested against the database in packages/plugins/reminders/test/remind-api.test.ts and not waited for here. The phone
 * layout of the list has its own test at the end (project mobile-web).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
type Row = { id: string; text: string; targetKind: string; state: string; person: { name: string } | null; channel: { name: string } | null };
let rafi: Api;
let channel = { id: '', name: '' };
let tag = '';

const pending = async (): Promise<Row[]> => ((await rafi.get('/api/reminders?state=pending')) as { items: Row[] }).items.filter((r) => r.text.includes(tag));

test.beforeAll(async () => {
  rafi = await apiAs('rafi');
  const omar = await apiAs('omar');
  channel = await createChannel(omar, 'remind');
  await omar.ctx.dispose();
  tag = uniqueName('rm');
});
test.afterAll(async () => {
  // leave no reminder waiting
  for (const r of await pending()) await rafi.ctx.delete(`/api/reminders/${r.id}`, { headers: await rafi.headers() });
  await rafi?.ctx.dispose();
});

const box = (page: import('@playwright/test').Page) => page.getByRole('textbox', { name: /^Message/ });

test.describe('desktop', () => {
  test.skip(({ isMobile }) => isMobile, 'the desktop layout; the phone has its own test below');

  test('/remind me sets a reminder with one sentence and posts nothing; /remind list shows it and Cancel removes it', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      const input = box(page);
      await expect(input).toBeVisible(T);
      await input.click();
      await input.pressSequentially(`/remind me tomorrow at 9 ${tag} call the bank`);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('slash-notice')).toContainText('Reminder set for you:', T);
      await expect(input).toHaveValue('');
      // nothing was posted in the channel
      await expect(messages(page).filter({ hasText: tag })).toHaveCount(0);

      const waiting = await pending();
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ text: `${tag} call the bank`, targetKind: 'me', state: 'pending' });

      // the list
      await input.pressSequentially('/remind list');
      await page.keyboard.press('Enter');
      const dialog = page.getByTestId('reminders-dialog');
      await expect(dialog).toBeVisible(T);
      await expect(input).toHaveValue('');
      const row = dialog.getByTestId('reminder-row').filter({ hasText: tag });
      await expect(row).toHaveCount(1, T);
      await expect(row).toContainText('You');
      await row.getByTestId('reminder-cancel').click();
      await expect(dialog.getByTestId('reminder-row').filter({ hasText: tag })).toHaveCount(0, T);
      await expect(dialog.getByTestId('reminder-done').filter({ hasText: tag })).toContainText('Cancelled', T);
      expect(await pending()).toHaveLength(0);

      // Escape closes it and the focus is back in the box
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(input).toBeFocused();
    } finally {
      await context.close();
    }
  });

  test('a time that cannot be read, a missing "what" and a mistyped command are answered in words and keep the text', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      const input = box(page);
      await input.click();
      for (const typed of [`/remind me whenever ${tag} soon`, '/remind me in 20 minutes', `/remind me on 2020-01-01 at 9:00 ${tag} old`, `/remnd me tomorrow ${tag}`]) {
        await input.fill(typed);
        await page.keyboard.press('Enter');
        await expect(page.getByTestId('slash-notice')).toBeVisible(T);
        await expect(input).toHaveValue(typed);
      }
      await expect(page.getByTestId('slash-notice')).toContainText('There is no command called /remnd');
      expect(await pending()).toHaveLength(0);
      await expect(messages(page).filter({ hasText: tag })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('/remind @omar reminds another person about this channel, and the list names them', async ({ browser }) => {
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`);
    try {
      const input = box(page);
      await input.click();
      await input.pressSequentially(`/remind @omar tomorrow at 9 ${tag} review the plan`);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('slash-notice')).toContainText('Reminder set for', T);
      await expect(input).toHaveValue('');
      const waiting = await pending();
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toMatchObject({ targetKind: 'person' });
      expect(waiting[0]!.person?.name).toMatch(/Omar/);

      await input.pressSequentially('/remind list');
      await page.keyboard.press('Enter');
      const row = page.getByTestId('reminders-dialog').getByTestId('reminder-row').filter({ hasText: tag });
      await expect(row).toContainText('Omar', T);
      await row.getByTestId('reminder-cancel').click();
      await expect(row).toHaveCount(0, T);
    } finally {
      await context.close();
    }
  });

  test('another person never sees the reminders of Rafi', async () => {
    await rafi.post('/api/reminders', { target: { kind: 'me' }, text: `${tag} private note`, remindAt: new Date(Date.now() + 86_400_000).toISOString() });
    const priya = await apiAs('priya');
    try {
      const theirs = (await priya.get('/api/reminders?state=pending')) as { items: Row[] };
      expect(theirs.items.filter((r) => r.text.includes(tag))).toHaveLength(0);
    } finally {
      await priya.ctx.dispose();
    }
  });
});

test.describe('phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone viewport only (project mobile-web)');
  test('the reminders list fits a 390 px screen with buttons a thumb can hit', async ({ browser }) => {
    await rafi.post('/api/reminders', { target: { kind: 'me' }, text: `${tag} phone reminder`, remindAt: new Date(Date.now() + 86_400_000).toISOString() });
    const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${channel.name}`, { width: 390, height: 844 }, true);
    try {
      const input = box(page);
      await input.fill('/remind list');
      await page.keyboard.press('Enter');
      const dialog = page.getByTestId('reminders-dialog');
      await expect(dialog).toBeVisible(T);
      const cancel = dialog.getByTestId('reminder-row').filter({ hasText: tag }).getByTestId('reminder-cancel');
      await expect(cancel).toBeVisible(T);
      const b = await cancel.boundingBox();
      expect(b!.x).toBeGreaterThanOrEqual(0);
      expect(b!.x + b!.width).toBeLessThanOrEqual(390);
      expect(b!.height).toBeGreaterThanOrEqual(32);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      await context.close();
    }
  });
});
